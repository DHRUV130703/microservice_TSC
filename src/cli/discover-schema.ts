/**
 * ---------------------------------------------------------------------------
 * BigQuery schema discovery
 * ---------------------------------------------------------------------------
 * Introspects the real BigQuery instance and reports exactly what exists, so
 * the schema mapping can be filled in from facts instead of guesses.
 *
 *   npm run discover:schema
 *   npm run discover:schema -- --dataset=production,view_reports
 *   npm run discover:schema -- --profile        # sample status values (billable)
 *   npm run discover:schema -- --out=reports/schema.md
 *   npm run discover:schema -- --all            # include noise/scratch tables
 *
 * Uses the metadata REST API (not INFORMATION_SCHEMA), so it works with service
 * accounts that lack INFORMATION_SCHEMA query permission. No table data is read
 * unless --profile is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { getBigQueryClient } from '../config/bigquery.js';
import { env } from '../config/env.js';
import { introspectDataset, listDatasets, type TableInfo } from './lib/introspect.js';
import { HINTS, detectShardFamilies, fieldsMatching, scoreTable, type Score } from './lib/heuristics.js';

interface Args {
  dataset?: string;
  profile: boolean;
  includeNoise: boolean;
  out: string;
  topCandidates: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    ...(get('dataset') ? { dataset: get('dataset')! } : {}),
    profile: argv.includes('--profile'),
    includeNoise: argv.includes('--all'),
    out: get('out') ?? 'reports/schema-discovery.md',
    topCandidates: Number(get('top') ?? 15),
  };
}

const log = (s: string): void => void process.stdout.write(`${s}\n`);
const fmt = (n: number | null): string => (n === null ? 'unknown' : n.toLocaleString('en-IN'));
const gb = (n: number | null): string => (n === null ? '?' : `${(n / 1e9).toFixed(2)} GB`);

function candidateLines(t: TableInfo): string[] {
  const pick = (patterns: readonly RegExp[]): string => {
    const found = fieldsMatching(t, patterns);
    return found.length === 0 ? '_none_' : found.map((f) => `\`${f.path}\`:${f.type}`).join(', ');
  };
  return [
    `  - **pincode**: ${pick(HINTS.pincode)}`,
    `  - **date**: ${pick(HINTS.date)}`,
    `  - **value**: ${pick(HINTS.value)}`,
    `  - **order id**: ${pick(HINTS.orderId)}`,
    `  - **lead id**: ${pick(HINTS.leadId)}`,
    `  - **status**: ${pick(HINTS.status)}`,
    `  - **join key**: ${pick(HINTS.joinKey)}`,
  ];
}

/** Samples the distinct values of status-like columns. Reads data — billable. */
async function profileStatuses(client: BigQuery, t: TableInfo): Promise<string[]> {
  const columns = fieldsMatching(t, HINTS.status)
    .filter((f) => !f.repeated && !f.path.includes('.'))
    .slice(0, 4);
  const lines: string[] = [];
  for (const field of columns) {
    try {
      const [rows] = await client.query({
        query: `SELECT CAST(\`${field.path}\` AS STRING) AS value, COUNT(*) AS n
                FROM \`${t.dataset}.${t.table}\`
                GROUP BY value ORDER BY n DESC LIMIT 25`,
        location: env.BIGQUERY_LOCATION,
        maximumBytesBilled: env.BIGQUERY_MAXIMUM_BYTES_BILLED,
      });
      const values = (rows as Array<{ value: string | null; n: unknown }>)
        .map((r) => `\`${r.value ?? 'NULL'}\` (${fmt(Number(r.n))})`)
        .join(', ');
      lines.push(`    - \`${field.path}\`: ${values}`);
    } catch (error) {
      lines.push(`    - \`${field.path}\`: not profiled (${String((error as Error).message).split('\n')[0]})`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = getBigQueryClient();
  const projectId = await client.getProjectId();
  const datasets = await listDatasets(client, args.dataset);

  log(`Project ${projectId} — inspecting ${datasets.length} dataset(s) via the metadata API...`);

  const all: TableInfo[] = [];
  for (const dataset of datasets) {
    try {
      const tables = await introspectDataset(client, dataset, {
        skipTypes: new Set(['EXTERNAL']),
        concurrency: 20,
        onProgress: (done, total) => {
          if (done === total || done % 50 === 0) log(`  ${dataset}: ${done}/${total}`);
        },
      });
      all.push(...tables);
    } catch (error) {
      log(`  ${dataset}: FAILED — ${String((error as Error).message).split('\n')[0]}`);
    }
  }

  const readable = all.filter((t) => !t.error);
  const unreadable = all.filter((t) => t.error);
  const scored = readable
    .map((t) => ({ t, s: scoreTable(t) }))
    .filter(({ s }) => s.hasPincode)
    .filter(({ s }) => args.includeNoise || !s.noise);

  const orderCandidates = [...scored].filter(({ s }) => s.orders > 0).sort((a, b) => b.s.orders - a.s.orders || (b.t.numRows ?? 0) - (a.t.numRows ?? 0));
  const leadCandidates = [...scored].filter(({ s }) => s.leads > 0).sort((a, b) => b.s.leads - a.s.leads || (b.t.numRows ?? 0) - (a.t.numRows ?? 0));

  const report: string[] = [
    '# BigQuery schema discovery',
    '',
    `- Project: \`${projectId}\``,
    `- Location: \`${env.BIGQUERY_LOCATION}\``,
    `- Generated: ${new Date().toISOString()}`,
    `- Datasets: ${datasets.map((d) => `\`${d}\``).join(', ')}`,
    `- Tables introspected: ${all.length} (${readable.length} readable, ${unreadable.length} unreadable)`,
    `- Tables with a pincode-like column: ${scored.length}${args.includeNoise ? '' : ' (scratch/test tables excluded; pass --all to include)'}`,
    `- Status profiling: ${args.profile ? '**ON** — table data was read' : 'OFF (pass --profile to enable)'}`,
    '',
    '> Candidates below come from **name heuristics only**. Confirm them against real',
    '> rows before writing them into `config/schema.mapping.json`.',
    '',
    '---',
    '',
  ];

  const renderCandidate = async (t: TableInfo, s: Score, rank: number, kind: 'ORDER' | 'LEAD'): Promise<string[]> => {
    const lines = [
      `### ${rank}. \`${projectId}.${t.dataset}.${t.table}\``,
      '',
      `- score: **${kind === 'ORDER' ? s.orders : s.leads}** (${kind.toLowerCase()} candidate) | type: ${t.type} | rows: ${fmt(t.numRows)} | size: ${gb(t.numBytes)}`,
      `- partitioned by: ${t.partitionField ? `\`${t.partitionField}\` (${t.partitionType})${t.requirePartitionFilter ? ' **requires partition filter**' : ''}` : '_not partitioned_'}`,
      `- clustered by: ${t.clusterFields.length ? t.clusterFields.map((c) => `\`${c}\``).join(', ') : '_none_'}`,
      `- ${t.fields.length} columns`,
      ...candidateLines(t),
    ];
    if (args.profile) {
      const profile = await profileStatuses(client, t);
      if (profile.length > 0) lines.push('  - **status values**:', ...profile);
    }
    lines.push('');
    return lines;
  };

  report.push('## Order-table candidates', '');
  if (orderCandidates.length === 0) report.push('_None found with a pincode-like column._', '');
  for (const [i, { t, s }] of orderCandidates.slice(0, args.topCandidates).entries()) {
    report.push(...(await renderCandidate(t, s, i + 1, 'ORDER')));
  }

  report.push('---', '', '## Lead-table candidates', '');
  if (leadCandidates.length === 0) report.push('_None found with a pincode-like column._', '');
  for (const [i, { t, s }] of leadCandidates.slice(0, args.topCandidates).entries()) {
    report.push(...(await renderCandidate(t, s, i + 1, 'LEAD')));
  }

  const families = detectShardFamilies(readable);
  if (families.size > 0) {
    report.push('---', '', '## Date-sharded table families', '');
    for (const [prefix, list] of families) {
      const sorted = [...list].sort();
      report.push(
        `- \`${prefix}*\` — ${list.length} shards (${sorted[0]} … ${sorted[sorted.length - 1]}). ` +
          `Mapping: \`{"kind":"wildcard","table":"${projectId}.<dataset>.${prefix}*","suffixFormat":"YYYY_MM"}\``,
      );
    }
    report.push('');
  }

  report.push('---', '', '## All tables with a pincode-like column', '');
  for (const { t, s } of scored.sort((a, b) => a.t.dataset.localeCompare(b.t.dataset) || a.t.table.localeCompare(b.t.table))) {
    const pincodes = fieldsMatching(t, HINTS.pincode).map((f) => `${f.path}:${f.type}`).join(', ');
    report.push(`- \`${t.dataset}.${t.table}\` (${t.type}, ${fmt(t.numRows)} rows) — pincode: ${pincodes} — scores: orders ${s.orders}, leads ${s.leads}`);
  }
  report.push('');

  if (unreadable.length > 0) {
    report.push('---', '', '## Unreadable tables', '');
    for (const t of unreadable.slice(0, 50)) report.push(`- \`${t.dataset}.${t.table}\`: ${t.error}`);
    if (unreadable.length > 50) report.push(`- … and ${unreadable.length - 50} more`);
    report.push('');
  }

  report.push(
    '---',
    '',
    '## Next steps',
    '',
    '1. Pick one order table and one lead table from the candidates above.',
    '2. Confirm the pincode / date / value / id / status / join-key columns against real rows.',
    '3. Choose the conversion definition (`status_flag` vs `join_orders`) from the status values.',
    '4. Fill in `config/schema.mapping.json`.',
    '5. Run `npm run validate:metrics -- --top=3`.',
    '',
  );

  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report.join('\n'), 'utf8');

  log('');
  log(`Introspected ${all.length} tables; ${scored.length} have a pincode-like column.`);
  log(`Top order candidates: ${orderCandidates.slice(0, 5).map(({ t }) => `${t.dataset}.${t.table}`).join(', ') || 'none'}`);
  log(`Top lead candidates:  ${leadCandidates.slice(0, 5).map(({ t }) => `${t.dataset}.${t.table}`).join(', ') || 'none'}`);
  log(`Report: ${outPath}`);
}

main().catch((error: Error) => {
  process.stderr.write(`\nSchema discovery failed: ${error.message}\n`);
  process.exit(1);
});
