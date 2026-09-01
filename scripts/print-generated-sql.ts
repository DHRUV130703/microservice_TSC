/**
 * Prints the exact SQL the service will send to BigQuery, without connecting to
 * BigQuery or needing credentials.
 *
 *   npm run print:sql
 *   npm run print:sql -- --pincode=560076
 *   npm run print:sql -- --mapping=config/schema.mapping.lsq-status.json
 *   npm run print:sql -- --date=2026-08-31
 *
 * Reads the REAL mapping (SCHEMA_MAPPING_PATH, default config/schema.mapping.json)
 * so the output matches production. Useful for reviewing a mapping change,
 * pasting the query into the BigQuery console, or estimating cost with a dry run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildMetricsQuery } from '../src/repositories/sql/metrics.query.js';
import { loadSchemaMapping } from '../src/config/schema.mapping.js';
import { resolveDateWindow } from '../src/utils/date.js';
import { env } from '../src/config/env.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const mappingPath = arg('mapping') ?? env.SCHEMA_MAPPING_PATH;
const pincode = arg('pincode') ?? '400092';
const asOf = arg('date') ? new Date(`${arg('date')}T12:00:00+05:30`) : new Date();

const absolute = path.resolve(process.cwd(), mappingPath);
if (!fs.existsSync(absolute)) {
  process.stderr.write(
    `No schema mapping at "${absolute}".\n` +
      `Run "npm run discover:schema" and fill in ${mappingPath}, or pass --mapping=<path>.\n`,
  );
  process.exit(1);
}

const mapping = loadSchemaMapping(mappingPath);
const window = resolveDateWindow(asOf);
const { sql, params, types } = buildMetricsQuery(mapping, pincode, window);

const orderSource = mapping.orders.source;
const leadSource = mapping.leads.source;
const describe = (s: typeof orderSource): string =>
  s.kind === 'table' ? s.table : s.kind === 'wildcard' ? s.table : s.tables.join(' + ');

process.stdout.write(
  [
    `-- mapping:    ${mappingPath}`,
    `-- orders:     ${describe(orderSource)}`,
    `-- leads:      ${describe(leadSource)}`,
    `-- conversion: ${mapping.leads.conversion.strategy}`,
    `-- pincode:    ${pincode}`,
    `-- period:     ${window.from} .. ${window.to} (${window.months} months, ${window.mode}, ${window.timezone})`,
    '',
    sql,
    '',
    '-- parameters (all values are bound, never interpolated):',
    ...Object.entries(params).map(([k, v]) => {
      const rendered = v && typeof v === 'object' && 'value' in (v as object)
        ? `DATE '${(v as { value: string }).value}'`
        : JSON.stringify(v);
      return `--   @${k} = ${rendered}   ${types[k] ? `[${JSON.stringify(types[k])}]` : ''}`.trimEnd();
    }),
    '',
  ].join('\n'),
);
