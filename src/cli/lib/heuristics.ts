import type { FieldInfo, TableInfo } from './introspect.js';

/**
 * Name heuristics used ONLY to rank candidates for human confirmation.
 * Nothing here decides the mapping — it decides what a human should look at.
 */
export const HINTS = {
  pincode: [/pin_?code/i, /postal_?code/i, /post_?code/i, /^pin$/i, /_pin$/i, /\bzip\b/i, /zip_?code/i],
  date: [/date/i, /_at$/i, /_on$/i, /timestamp/i, /created/i, /placed/i, /ordered/i, /booking/i, /month/i, /day/i],
  value: [
    /grand_?total/i, /net_?(amount|value|revenue|sales)/i, /total_?(amount|value|price|revenue|sales)/i,
    /\bgmv\b/i, /\bnmv\b/i, /amount/i, /revenue/i, /\bsales\b/i, /\bprice\b/i, /\bvalue\b/i, /subtotal/i,
  ],
  orderId: [/^order_?id$/i, /order_?number/i, /^increment_?id$/i, /invoice_?(id|no|number)/i, /^so_?id$/i, /order_?code/i],
  leadId: [/^lead_?id$/i, /lead_?number/i, /enquiry_?id/i, /prospect_?id/i, /activity_?id/i],
  status: [/status/i, /_state$/i, /^state$/i, /stage/i, /disposition/i, /outcome/i, /converted/i, /is_?order/i],
  joinKey: [/phone/i, /mobile/i, /contact_?(no|number)/i, /msisdn/i, /customer_?id/i, /user_?id/i, /email/i, /lsq_?id/i],
} as const;

export const TABLE_HINTS = {
  orders: [/order/i, /\bsales\b/i, /transaction/i, /invoice/i, /purchase/i, /booking/i, /\bgmv\b/i, /\bd2c\b/i, /\boms\b/i],
  leads: [/lead/i, /enquiry/i, /inquiry/i, /prospect/i, /\bcrm\b/i, /funnel/i, /walkin/i, /visit/i, /quotation/i, /\blsq\b/i],
  /** Tables that look like scratch/duplicates — deprioritised, never auto-picked. */
  noise: [/_temp$/i, /^temp_/i, /_tmp$/i, /\btest\b/i, /_test/i, /^abc/i, /_copy$/i, /_old$/i, /_bak$/i,
          /_v\d+$/i, /_new+$/i, /_stg$/i, /_stage$/i, /^pm_/i, /_pm$/i, /_pm_/i, /practice/i, /edit_table/i],
} as const;

export const matches = (name: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((p) => p.test(name));

export const fieldsMatching = (table: TableInfo, patterns: readonly RegExp[]): FieldInfo[] =>
  table.fields.filter((f) => matches(f.path, patterns));

export interface Score {
  orders: number;
  leads: number;
  noise: boolean;
  hasPincode: boolean;
  hasDate: boolean;
  hasValue: boolean;
}

export function scoreTable(t: TableInfo): Score {
  const hasPincode = fieldsMatching(t, HINTS.pincode).length > 0;
  const hasDate = fieldsMatching(t, HINTS.date).length > 0;
  const hasValue = fieldsMatching(t, HINTS.value).length > 0;
  const noise = matches(t.table, TABLE_HINTS.noise);

  // A pincode column is the hard requirement for this service; without it the
  // table cannot answer a pincode question at all.
  let orders = 0;
  if (!hasPincode) orders = -100;
  else {
    if (matches(t.table, TABLE_HINTS.orders)) orders += 3;
    if (hasValue) orders += 4;
    if (hasDate) orders += 2;
    if (fieldsMatching(t, HINTS.orderId).length > 0) orders += 3;
    if (fieldsMatching(t, HINTS.status).length > 0) orders += 1;
    if ((t.numRows ?? 0) > 1000) orders += 1;
    if (t.type !== 'TABLE') orders -= 1;
    if (noise) orders -= 5;
  }

  let leads = 0;
  if (!hasPincode) leads = -100;
  else {
    if (matches(t.table, TABLE_HINTS.leads)) leads += 3;
    if (fieldsMatching(t, HINTS.leadId).length > 0) leads += 4;
    if (fieldsMatching(t, HINTS.status).length > 0) leads += 2;
    if (hasDate) leads += 2;
    if (fieldsMatching(t, HINTS.joinKey).length > 0) leads += 1;
    if ((t.numRows ?? 0) > 1000) leads += 1;
    if (t.type !== 'TABLE') leads -= 1;
    if (noise) leads -= 5;
  }

  return { orders, leads, noise, hasPincode, hasDate, hasValue };
}

/** Groups `orders_2026_01`-style shards into one family. */
export function detectShardFamilies(tables: TableInfo[]): Map<string, string[]> {
  const families = new Map<string, string[]>();
  for (const t of tables) {
    const m = /^(.*?)[_-]?((?:19|20)\d{2}(?:[_-]?\d{2}){0,2})$/.exec(t.table);
    if (!m || !m[1] || m[1].length < 3) continue;
    families.set(m[1], [...(families.get(m[1]) ?? []), t.table]);
  }
  for (const [prefix, list] of families) if (list.length < 2) families.delete(prefix);
  return families;
}
