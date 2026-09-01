/**
 * ---------------------------------------------------------------------------
 * Metrics validation harness
 * ---------------------------------------------------------------------------
 * Runs the production query against BigQuery for several pincodes and prints
 * the supporting counters plus independent cross-check queries, so AOV and
 * conversion rate can be verified by hand.
 *
 *   npm run validate:metrics -- --pincode=400092 --pincode=110001 --pincode=560001
 *   npm run validate:metrics -- --pincode=400092 --print-sql
 *   npm run validate:metrics -- --pincode=400092 --dry-run     # cost estimate only
 *   npm run validate:metrics -- --top=5                        # discover busiest pincodes first
 */
import { getBigQueryClient, baseJobOptions } from '../config/bigquery.js';
import { getSchemaMapping } from '../config/schema.mapping.js';
import { buildMetricsQuery } from '../repositories/sql/metrics.query.js';
import { resolveDateWindow, suffixRange } from '../utils/date.js';
import { col, dateParam, normalizedPincodeExpression, renderFrom, dateWindowPredicate } from '../repositories/sql/expressions.js';
import { env } from '../config/env.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const values = (name: string): string[] =>
  argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.split('=').slice(1).join('='));
const single = (name: string): string | undefined => values(name)[0];

const out = (s: string): void => void process.stdout.write(`${s}\n`);
/** BigQuery DATE/TIMESTAMP values arrive as `{ value: '...' }` wrappers. */
const scalar = (v: unknown): string => {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) return String((v as { value: unknown }).value);
  return String(v);
};
const fmt = (n: number): string => n.toLocaleString('en-IN');

/** Finds the pincodes with the most orders, so validation uses real, dense data. */
async function discoverTopPincodes(limit: number): Promise<string[]> {
  const mapping = getSchemaMapping();
  const client = getBigQueryClient();
  const window = resolveDateWindow();
  const orders = mapping.orders;
  const c = orders.columns;

  const params: Record<string, unknown> = { from: dateParam(window.from), to: dateParam(window.to), timezone: window.timezone, limit };
  const types: Record<string, string> = { from: 'DATE', to: 'DATE', timezone: 'STRING', limit: 'INT64' };

  if (orders.source.kind === 'wildcard') {
    const range = suffixRange(window, orders.source.suffixFormat);
    params.ordersSuffixMin = range.min;
    params.ordersSuffixMax = range.max;
    types.ordersSuffixMin = 'STRING';
    types.ordersSuffixMax = 'STRING';
  }
  const { from, wherePredicates } = renderFrom(orders.source, 'o', [c.pincode, c.orderDate, c.orderId], {
    min: 'ordersSuffixMin',
    max: 'ordersSuffixMax',
  });

  const sql = `
    SELECT ${normalizedPincodeExpression('o', c.pincode, orders.pincodeMatch)} AS pincode,
           COUNT(DISTINCT ${col('o', c.orderId)}) AS orders
    FROM ${from}
    WHERE ${[...wherePredicates, dateWindowPredicate('o', c.orderDate, orders.orderDateType, { from: 'from', to: 'to', timezone: 'timezone' })].join('\n      AND ')}
    GROUP BY pincode
    HAVING pincode IS NOT NULL AND pincode != ''
    ORDER BY orders DESC
    LIMIT @limit`;

  const [rows] = await client.query({ ...baseJobOptions(), query: sql, params, types });
  return (rows as Array<{ pincode: string; orders: unknown }>).map((r) => {
    out(`  ${r.pincode.padEnd(12)} ${fmt(Number(r.orders))} orders`);
    return r.pincode;
  });
}

/** Independent per-pincode cross-check: order-level rows for manual arithmetic. */
function crossCheckSql(pincode: string): { sql: string; params: Record<string, unknown>; types: Record<string, string | string[]> } {
  const mapping = getSchemaMapping();
  const built = buildMetricsQuery(mapping, pincode, resolveDateWindow());

  /**
   * Renders the order-date column as a DATE in the business timezone. The cast
   * depends on the column's declared type — a DATE column cannot take a
   * timezone argument, a TIMESTAMP must have one to land on the right day.
   */
  const asBusinessDate = (column: string): string => {
    switch (mapping.orders.orderDateType) {
      case 'DATE':
        return column;
      case 'DATETIME':
        return `DATE(${column})`;
      case 'TIMESTAMP':
        return `DATE(${column}, @timezone)`;
    }
  };
  // Reuse the production CTEs, but expose the raw components separately so the
  // aggregate can be recomputed by hand from independent SELECTs.
  const sql = built.sql.replace(
    /SELECT\n  orders_agg\.totalOrders[\s\S]*$/,
    `SELECT
  (SELECT COUNT(DISTINCT order_id) FROM orders_scoped)                AS check_distinct_orders,
  (SELECT COUNT(*) FROM orders_scoped)                                AS check_order_rows,
  (SELECT ROUND(SUM(order_value), 2) FROM orders_scoped)              AS check_total_value,
  (SELECT ROUND(AVG(order_value), 2) FROM orders_scoped)              AS check_avg_row_value,
  (SELECT MIN(${asBusinessDate('order_date')}) FROM orders_scoped)     AS check_min_order_date,
  (SELECT MAX(${asBusinessDate('order_date')}) FROM orders_scoped)     AS check_max_order_date,
  orders_agg.totalOrders,
  orders_agg.totalOrderValue,
  leads_agg.totalLeads,
  leads_agg.convertedLeads
FROM orders_agg
CROSS JOIN leads_agg`,
  );
  return { sql, params: built.params, types: built.types };
}

async function validatePincode(pincode: string, printSql: boolean, dryRun: boolean): Promise<void> {
  const client = getBigQueryClient();
  const window = resolveDateWindow();
  const { sql, params, types } = crossCheckSql(pincode);

  out('');
  out('='.repeat(78));
  out(`Pincode ${pincode}   period ${window.from} .. ${window.to}  (${window.months} months, ${window.mode})`);
  out('='.repeat(78));

  if (printSql) {
    out('\n--- SQL -------------------------------------------------------------------');
    out(sql);
    out('--- parameters ------------------------------------------------------------');
    out(JSON.stringify(params, null, 2));
    out('');
  }

  if (dryRun) {
    const [job] = await client.createQueryJob({ ...baseJobOptions(), query: sql, params, types, dryRun: true });
    const bytes = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
    out(`Dry run OK. Estimated bytes processed: ${fmt(bytes)} (~$${((bytes / 1e12) * 6.25).toFixed(4)} at $6.25/TB)`);
    return;
  }

  const [rows] = await client.query({ ...baseJobOptions(), query: sql, params, types });
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  const num = (k: string): number => Number(r[k] ?? 0);

  const totalOrders = num('totalOrders');
  const totalValue = num('totalOrderValue');
  const totalLeads = num('totalLeads');
  const converted = num('convertedLeads');

  const aov = totalOrders > 0 ? totalValue / totalOrders : null;
  const cr = totalLeads > 0 ? (converted / totalLeads) * 100 : null;

  out('Orders');
  out(`  distinct order ids .......... ${fmt(num('check_distinct_orders'))}`);
  out(`  raw rows in scope ........... ${fmt(num('check_order_rows'))}` +
      (num('check_order_rows') !== num('check_distinct_orders')
        ? '   <-- >1 row per order: line-item grain or duplicates. COUNT(DISTINCT order_id) is used for the order count.'
        : ''));
  out(`  total order value ........... ${fmt(Number(totalValue.toFixed(2)))}`);
  out(`  order date range ............ ${scalar(r.check_min_order_date)} .. ${scalar(r.check_max_order_date)} (${window.timezone})`);
  out(`  AOV = ${fmt(Number(totalValue.toFixed(2)))} / ${fmt(totalOrders)} = ${aov === null ? 'null (no orders)' : aov.toFixed(2)}`);
  out('');
  out('Leads');
  out(`  eligible leads .............. ${fmt(totalLeads)}`);
  out(`  converted leads ............. ${fmt(converted)}`);
  out(`  Conversion = ${fmt(converted)} / ${fmt(totalLeads)} x 100 = ${cr === null ? 'null (no leads)' : `${cr.toFixed(2)}%`}`);
  out('');

  const warnings: string[] = [];
  if (converted > totalLeads) warnings.push('convertedLeads exceeds totalLeads — the conversion join is fanning out');
  if (cr !== null && cr > 100) warnings.push('conversion rate above 100%');
  if (totalOrders > 0 && totalLeads === 0) warnings.push('orders exist but no leads — the lead source or its pincode column may be wrong');
  const minDate = scalar(r.check_min_order_date);
  const maxDate = scalar(r.check_max_order_date);
  if (minDate !== '-' && minDate.slice(0, 10) < window.from) warnings.push(`an order (${minDate}) predates the window start ${window.from} — check the date column/type`);
  if (maxDate !== '-' && maxDate.slice(0, 10) > window.to) warnings.push(`an order (${maxDate}) postdates the window end ${window.to} — check the date column/type`);
  if (warnings.length > 0) {
    out('WARNINGS');
    for (const w of warnings) out(`  ! ${w}`);
    out('');
  }
}

async function main(): Promise<void> {
  const mapping = getSchemaMapping();
  out(`Schema mapping: orders=${mapping.orders.source.kind}, leads=${mapping.leads.source.kind}, conversion=${mapping.leads.conversion.strategy}`);

  let pincodes = values('pincode');
  const top = Number(single('top') ?? 0);
  if (top > 0) {
    out(`\nDiscovering the ${top} pincodes with the most orders in the window:`);
    pincodes = [...pincodes, ...(await discoverTopPincodes(top))];
  }

  if (pincodes.length === 0) {
    out('\nNo pincodes supplied. Use --pincode=XXXXXX (repeatable) or --top=3.');
    process.exit(2);
  }

  // Add a deliberately absent pincode so the no-data path is exercised too.
  if (!flag('no-negative-case')) pincodes.push('000000');

  for (const pincode of [...new Set(pincodes)]) {
    await validatePincode(pincode, flag('print-sql'), flag('dry-run'));
  }

  out(`Done. ${pincodes.length} pincode(s) validated against project ${env.GOOGLE_CLOUD_PROJECT ?? '(from credentials)'}.`);
}

main().catch((error: Error) => {
  process.stderr.write(`\nValidation failed: ${error.message}\n`);
  process.exit(1);
});
