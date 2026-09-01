import type { LeadsMapping, OrdersMapping, SchemaMapping } from '../../config/schema.mapping.js';
import type { DateWindow } from '../../utils/date.js';
import { suffixRange } from '../../utils/date.js';
import {
  booleanFlagPredicates,
  col,
  columnFilterPredicate,
  dateParam,
  dateWindowPredicate,
  dedupeQualify,
  joinKeyExpression,
  normalizePincodeValue,
  normalizeStatusValue,
  normalizedPincodeExpression,
  quoteIdentifier,
  renderFrom,
  statusExpression,
} from './expressions.js';

export interface BuiltQuery {
  sql: string;
  params: Record<string, unknown>;
  types: Record<string, string | string[]>;
}

const ORDERS_ALIAS = 'o';
const LEADS_ALIAS = 'l';

/**
 * Builds ONE BigQuery job that returns a single row with all four supporting
 * counters. Both metrics are derived from that one row, so we never scan the
 * same data twice for a single API call.
 *
 * Filtering (pincode, date window, status) happens entirely inside BigQuery,
 * only the required columns are projected, and every value is bound as a query
 * parameter.
 */
export function buildMetricsQuery(mapping: SchemaMapping, pincode: string, window: DateWindow): BuiltQuery {
  const params: Record<string, unknown> = {
    // Bound as BigQueryDate, never a raw string — see dateParam().
    from: dateParam(window.from),
    to: dateParam(window.to),
    timezone: window.timezone,
  };
  const types: Record<string, string | string[]> = {
    from: 'DATE',
    to: 'DATE',
    timezone: 'STRING',
  };

  const needsOrderJoinKey = mapping.leads.conversion.strategy === 'join_orders';
  const ordersCte = buildOrdersCte(mapping.orders, pincode, window, params, types, needsOrderJoinKey);
  const leadsCte = buildLeadsCte(mapping.leads, pincode, window, params, types);
  const conversionCte = buildConversionCte(mapping, window, params, types);

  const sql = `-- pincode-metrics-service :: AOV + conversion rate for one pincode
WITH
${ordersCte}
,
${leadsCte}
${conversionCte.ctes}
,
orders_agg AS (
  SELECT
    COUNT(DISTINCT order_id) AS totalOrders,
    COALESCE(SUM(order_value), 0) AS totalOrderValue
  FROM orders_scoped
)
,
leads_agg AS (
  SELECT
    COUNT(DISTINCT lead_id) AS totalLeads,
    COUNT(DISTINCT IF(${conversionCte.convertedPredicate}, lead_id, NULL)) AS convertedLeads
  FROM ${conversionCte.leadsRelation}
)
SELECT
  orders_agg.totalOrders,
  orders_agg.totalOrderValue,
  leads_agg.totalLeads,
  leads_agg.convertedLeads
FROM orders_agg
CROSS JOIN leads_agg`;

  return { sql, params, types };
}

function buildOrdersCte(
  orders: OrdersMapping,
  pincode: string,
  window: DateWindow,
  params: Record<string, unknown>,
  types: Record<string, string | string[]>,
  needsJoinKey: boolean,
): string {
  const c = orders.columns;
  const includeJoinKey = needsJoinKey && Boolean(c.joinKey);
  const projected = [c.orderId, c.pincode, c.orderDate, c.orderValue];
  if (c.status) projected.push(c.status);
  if (includeJoinKey) projected.push(c.joinKey!);
  projected.push(...orders.booleanFlags.excludeWhenTrue, ...orders.booleanFlags.requireTrue);
  projected.push(...orders.columnFilters.map((f) => f.column));
  if (orders.dedupe) {
    projected.push(...orders.dedupe.keyColumns, orders.dedupe.orderByColumn);
    projected.push(...orders.dedupe.tiebreakColumns.map((t) => t.column));
  }

  if (orders.source.kind === 'wildcard') {
    const range = suffixRange(window, orders.source.suffixFormat);
    params.ordersSuffixMin = range.min;
    params.ordersSuffixMax = range.max;
    types.ordersSuffixMin = 'STRING';
    types.ordersSuffixMax = 'STRING';
  }

  const { from, wherePredicates } = renderFrom(orders.source, ORDERS_ALIAS, unique(projected), {
    min: 'ordersSuffixMin',
    max: 'ordersSuffixMax',
  });

  params.ordersPincode = normalizePincodeValue(pincode, orders.pincodeMatch);
  types.ordersPincode = 'STRING';

  const predicates = [
    ...wherePredicates,
    `${normalizedPincodeExpression(ORDERS_ALIAS, c.pincode, orders.pincodeMatch)} = @ordersPincode`,
    dateWindowPredicate(ORDERS_ALIAS, c.orderDate, orders.orderDateType, {
      from: 'from',
      to: 'to',
      timezone: 'timezone',
    }),
  ];

  if (c.status && orders.includeStatuses.length > 0) {
    params.ordersIncludeStatuses = orders.includeStatuses.map((s) => normalizeStatusValue(s, orders.statusCaseInsensitive));
    types.ordersIncludeStatuses = ['STRING'];
    predicates.push(
      `${statusExpression(ORDERS_ALIAS, c.status, orders.statusCaseInsensitive)} IN UNNEST(@ordersIncludeStatuses)`,
    );
  } else if (c.status && orders.excludeStatuses.length > 0) {
    params.ordersExcludeStatuses = orders.excludeStatuses.map((s) => normalizeStatusValue(s, orders.statusCaseInsensitive));
    types.ordersExcludeStatuses = ['STRING'];
    // A NULL status is not evidence of cancellation, so it survives the deny-list.
    predicates.push(
      `(${col(ORDERS_ALIAS, c.status)} IS NULL OR ` +
        `${statusExpression(ORDERS_ALIAS, c.status, orders.statusCaseInsensitive)} NOT IN UNNEST(@ordersExcludeStatuses))`,
    );
  }

  if (orders.requirePositiveValue) {
    predicates.push(`${col(ORDERS_ALIAS, c.orderValue)} > 0`);
  }

  predicates.push(...booleanFlagPredicates(ORDERS_ALIAS, orders.booleanFlags));

  orders.columnFilters.forEach((filter, index) => {
    const name = `ordersFilter${index}`;
    const { predicate, value } = columnFilterPredicate(ORDERS_ALIAS, filter, name);
    params[name] = value;
    types[name] = ['STRING'];
    predicates.push(predicate);
  });

  const select = [
    `${col(ORDERS_ALIAS, c.orderId)} AS order_id`,
    `${col(ORDERS_ALIAS, c.orderValue)} AS order_value`,
    `${col(ORDERS_ALIAS, c.orderDate)} AS order_date`,
  ];
  if (includeJoinKey) select.push(`${col(ORDERS_ALIAS, c.joinKey!)} AS join_key_raw`);

  return `-- Valid orders for the pincode inside the reporting window
orders_scoped AS (
  SELECT
    ${select.join(',\n    ')}
  FROM ${from}
  WHERE ${predicates.join('\n    AND ')}${orders.dedupe ? `\n  ${dedupeQualify(ORDERS_ALIAS, orders.dedupe)}` : ''}
)`;
}

function buildLeadsCte(
  leads: LeadsMapping,
  pincode: string,
  window: DateWindow,
  params: Record<string, unknown>,
  types: Record<string, string | string[]>,
): string {
  const c = leads.columns;
  const conversionColumn =
    leads.conversion.strategy === 'status_flag'
      ? (leads.conversion.column ?? c.status)
      : leads.conversion.strategy === 'boolean_flag'
        ? leads.conversion.column
        : undefined;

  const projected = [c.leadId, c.pincode, c.createdAt];
  if (c.status) projected.push(c.status);
  if (c.joinKey) projected.push(c.joinKey);
  if (conversionColumn) projected.push(conversionColumn);
  projected.push(...leads.booleanFlags.excludeWhenTrue, ...leads.booleanFlags.requireTrue);
  projected.push(...leads.columnFilters.map((f) => f.column));
  if (leads.dedupe) {
    projected.push(...leads.dedupe.keyColumns, leads.dedupe.orderByColumn);
    projected.push(...leads.dedupe.tiebreakColumns.map((t) => t.column));
  }

  if (leads.source.kind === 'wildcard') {
    const range = suffixRange(window, leads.source.suffixFormat);
    params.leadsSuffixMin = range.min;
    params.leadsSuffixMax = range.max;
    types.leadsSuffixMin = 'STRING';
    types.leadsSuffixMax = 'STRING';
  }

  const { from, wherePredicates } = renderFrom(leads.source, LEADS_ALIAS, unique(projected), {
    min: 'leadsSuffixMin',
    max: 'leadsSuffixMax',
  });

  params.leadsPincode = normalizePincodeValue(pincode, leads.pincodeMatch);
  types.leadsPincode = 'STRING';

  const predicates = [
    ...wherePredicates,
    `${normalizedPincodeExpression(LEADS_ALIAS, c.pincode, leads.pincodeMatch)} = @leadsPincode`,
    dateWindowPredicate(LEADS_ALIAS, c.createdAt, leads.createdAtType, {
      from: 'from',
      to: 'to',
      timezone: 'timezone',
    }),
  ];

  if (c.status && leads.excludeStatuses.length > 0) {
    params.leadsExcludeStatuses = leads.excludeStatuses.map((s) => normalizeStatusValue(s, leads.statusCaseInsensitive));
    types.leadsExcludeStatuses = ['STRING'];
    predicates.push(
      `(${col(LEADS_ALIAS, c.status)} IS NULL OR ` +
        `${statusExpression(LEADS_ALIAS, c.status, leads.statusCaseInsensitive)} NOT IN UNNEST(@leadsExcludeStatuses))`,
    );
  }

  predicates.push(...booleanFlagPredicates(LEADS_ALIAS, leads.booleanFlags));

  leads.columnFilters.forEach((filter, index) => {
    const name = `leadsFilter${index}`;
    const { predicate, value } = columnFilterPredicate(LEADS_ALIAS, filter, name);
    params[name] = value;
    types[name] = ['STRING'];
    predicates.push(predicate);
  });

  const select = [`${col(LEADS_ALIAS, c.leadId)} AS lead_id`];
  if (leads.conversion.strategy === 'status_flag' && conversionColumn) {
    select.push(`${statusExpression(LEADS_ALIAS, conversionColumn, leads.statusCaseInsensitive)} AS lead_status_norm`);
  } else if (leads.conversion.strategy === 'boolean_flag') {
    select.push(`COALESCE(${col(LEADS_ALIAS, leads.conversion.column)}, FALSE) AS is_converted`);
  }
  if (c.joinKey && leads.conversion.strategy === 'join_orders') {
    select.push(
      `${joinKeyExpression(LEADS_ALIAS, c.joinKey, {
        normalize: leads.conversion.normalizeJoinKey,
        stripCharacters: leads.conversion.joinKeyStripCharacters,
        ...(leads.conversion.joinKeyLastCharacters ? { lastCharacters: leads.conversion.joinKeyLastCharacters } : {}),
      })} AS join_key`,
    );
  }

  return `-- Eligible leads for the pincode inside the reporting window
leads_scoped AS (
  SELECT
    ${select.join(',\n    ')}
  FROM ${from}
  WHERE ${predicates.join('\n    AND ')}${leads.dedupe ? `\n  ${dedupeQualify(LEADS_ALIAS, leads.dedupe)}` : ''}
)`;
}

interface ConversionSql {
  /** Extra CTEs (may be empty), each prefixed with a leading comma. */
  ctes: string;
  /** Relation that `leads_agg` selects from. */
  leadsRelation: string;
  /** Boolean expression identifying a converted lead. */
  convertedPredicate: string;
}

function buildConversionCte(
  mapping: SchemaMapping,
  window: DateWindow,
  params: Record<string, unknown>,
  types: Record<string, string | string[]>,
): ConversionSql {
  const { leads, orders } = mapping;

  if (leads.conversion.strategy === 'status_flag') {
    params.convertedStatuses = leads.conversion.convertedStatuses.map((s) =>
      normalizeStatusValue(s, leads.statusCaseInsensitive),
    );
    types.convertedStatuses = ['STRING'];
    return {
      ctes: '',
      leadsRelation: 'leads_scoped',
      convertedPredicate: 'lead_status_norm IN UNNEST(@convertedStatuses)',
    };
  }

  if (leads.conversion.strategy === 'boolean_flag') {
    return { ctes: '', leadsRelation: 'leads_scoped', convertedPredicate: 'is_converted' };
  }

  // join_orders: a lead counts as converted when a qualifying order shares its key.
  const conversion = leads.conversion;
  const joinKeyOptions = {
    normalize: conversion.normalizeJoinKey,
    stripCharacters: conversion.joinKeyStripCharacters,
    ...(conversion.joinKeyLastCharacters ? { lastCharacters: conversion.joinKeyLastCharacters } : {}),
  };

  let orderKeysCte: string;
  if (conversion.orderWithinPeriod) {
    // Reuses the already-scanned orders_scoped CTE: no second table scan.
    orderKeysCte = `-- Distinct order join keys, reusing the orders already scanned
order_join_keys AS (
  SELECT DISTINCT ${rewriteJoinKeyOverCte('join_key_raw', joinKeyOptions)} AS join_key
  FROM orders_scoped
  WHERE join_key_raw IS NOT NULL
)`;
  } else {
    // Orders outside the window also count, so a separate (pincode-filtered) scan is required.
    const c = orders.columns;
    if (orders.source.kind === 'wildcard') {
      params.ordersAllSuffixMin = '0000';
      params.ordersAllSuffixMax = '9999_99_99';
      types.ordersAllSuffixMin = 'STRING';
      types.ordersAllSuffixMax = 'STRING';
    }
    const { from, wherePredicates } = renderFrom(orders.source, ORDERS_ALIAS, unique([c.pincode, c.joinKey!]), {
      min: 'ordersAllSuffixMin',
      max: 'ordersAllSuffixMax',
    });
    orderKeysCte = `-- Distinct order join keys for the pincode, ignoring the date window
order_join_keys AS (
  SELECT DISTINCT ${joinKeyExpression(ORDERS_ALIAS, c.joinKey!, joinKeyOptions)} AS join_key
  FROM ${from}
  WHERE ${[...wherePredicates, `${normalizedPincodeExpression(ORDERS_ALIAS, c.pincode, orders.pincodeMatch)} = @ordersPincode`, `${col(ORDERS_ALIAS, c.joinKey!)} IS NOT NULL`].join('\n    AND ')}
)`;
  }

  const leadsWithConversion = `-- Leads annotated with whether a matching order exists
leads_with_conversion AS (
  SELECT
    leads_scoped.lead_id,
    order_join_keys.join_key IS NOT NULL AS is_converted
  FROM leads_scoped
  LEFT JOIN order_join_keys
    ON leads_scoped.join_key = order_join_keys.join_key
)`;

  return {
    ctes: `,\n${orderKeysCte}\n,\n${leadsWithConversion}`,
    leadsRelation: 'leads_with_conversion',
    convertedPredicate: 'is_converted',
  };
}

/** Applies join-key normalisation to a bare column already inside a CTE. */
function rewriteJoinKeyOverCte(
  column: string,
  options: { normalize: boolean; stripCharacters: string; lastCharacters?: number },
): string {
  let expr = `CAST(${quoteIdentifier(column)} AS STRING)`;
  if (options.stripCharacters) {
    const escaped = [...new Set(options.stripCharacters)].map((c) => c.replace(/[\\\]\^\-]/g, '\\$&')).join('');
    expr = `REGEXP_REPLACE(${expr}, r'[${escaped}]', '')`;
  }
  if (options.normalize) expr = `LOWER(TRIM(${expr}))`;
  if (options.lastCharacters) expr = `RIGHT(${expr}, ${Math.trunc(options.lastCharacters)})`;
  return `NULLIF(${expr}, '')`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
