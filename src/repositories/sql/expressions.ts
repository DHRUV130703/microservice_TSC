import { BigQueryDate } from '@google-cloud/bigquery';
import type { PincodeMatch, TableSource } from '../../config/schema.mapping.js';

/**
 * Wraps an ISO `YYYY-MM-DD` string as a BigQuery DATE parameter value.
 *
 * This is NOT optional. Passing a plain string alongside `types: {x: 'DATE'}`
 * makes the client bind the parameter as NULL — every predicate silently
 * becomes false and the API returns zeros instead of failing. Verified against
 * BigQuery: `CAST(@from AS STRING)` returns NULL for a raw string bound as DATE,
 * and the correct value for a BigQueryDate.
 */
export function dateParam(isoDate: string): BigQueryDate {
  return new BigQueryDate(isoDate);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_REF = /^[A-Za-z0-9_.\-]+\.[A-Za-z_][A-Za-z0-9_]*\*?$/;

/**
 * Defence-in-depth: identifiers already passed Zod validation at mapping load,
 * but they are re-checked here so no code path can interpolate arbitrary text
 * into SQL. Values are *always* bound as query parameters, never interpolated.
 */
export function quoteIdentifier(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Refusing to build SQL with unsafe identifier: ${JSON.stringify(name)}`);
  return `\`${name}\``;
}

export function quoteTable(ref: string): string {
  if (!TABLE_REF.test(ref)) throw new Error(`Refusing to build SQL with unsafe table reference: ${JSON.stringify(ref)}`);
  return `\`${ref}\``;
}

/** Escapes a character class body for use inside a REGEXP_REPLACE literal. */
function toCharacterClass(characters: string): string {
  const escaped = [...new Set(characters)].map((c) => c.replace(/[\\\]\^\-]/g, '\\$&')).join('');
  return `[${escaped}]`;
}

/**
 * Renders the FROM clause plus any wildcard-shard pruning predicate.
 * `alias` is the table alias used by column expressions.
 */
export function renderFrom(
  source: TableSource,
  alias: string,
  columns: string[],
  suffixParams: { min: string; max: string },
): { from: string; wherePredicates: string[] } {
  const alias_ = quoteIdentifier(alias);

  switch (source.kind) {
    case 'table':
      return { from: `${quoteTable(source.table)} AS ${alias_}`, wherePredicates: [] };

    case 'wildcard':
      return {
        from: `${quoteTable(source.table)} AS ${alias_}`,
        // Shard pruning happens before any data is read: only the tables whose
        // suffix falls inside the reporting window are scanned.
        wherePredicates: [`${alias_}._TABLE_SUFFIX BETWEEN @${suffixParams.min} AND @${suffixParams.max}`],
      };

    case 'tables': {
      const projection = columns.map((c) => quoteIdentifier(c)).join(', ');
      const union = source.tables
        .map((table) => `    SELECT ${projection} FROM ${quoteTable(table)}`)
        .join('\n    UNION ALL\n');
      return { from: `(\n${union}\n  ) AS ${alias_}`, wherePredicates: [] };
    }
  }
}

/** Column reference qualified by table alias. */
export function col(alias: string, column: string): string {
  return `${quoteIdentifier(alias)}.${quoteIdentifier(column)}`;
}

/**
 * Normalises a pincode column so it can be compared to the bound parameter.
 * The same normalisation is applied to the parameter value in JS.
 */
export function normalizedPincodeExpression(alias: string, column: string, match: PincodeMatch): string {
  let expr: string;
  switch (match.columnType) {
    case 'STRING':
      expr = col(alias, column);
      break;
    case 'INT64':
      expr = `CAST(${col(alias, column)} AS STRING)`;
      break;
    case 'NUMERIC':
      // Avoid trailing scale digits ("400092.00") leaking into the comparison.
      expr = `CAST(CAST(${col(alias, column)} AS INT64) AS STRING)`;
      break;
  }
  if (match.stripCharacters) {
    expr = `REGEXP_REPLACE(${expr}, r'${toCharacterClass(match.stripCharacters)}', '')`;
  }
  if (match.trim) expr = `TRIM(${expr})`;
  if (match.caseInsensitive) expr = `UPPER(${expr})`;
  return expr;
}

/** Applies the same normalisation to the supplied pincode value. */
export function normalizePincodeValue(pincode: string, match: PincodeMatch): string {
  let value = pincode;
  if (match.stripCharacters) {
    const set = new Set([...match.stripCharacters]);
    value = [...value].filter((c) => !set.has(c)).join('');
  }
  if (match.trim) value = value.trim();
  if (match.caseInsensitive) value = value.toUpperCase();
  return value;
}

/**
 * Date-window predicate. Written as `column >= <constant> AND column < <constant>`
 * so BigQuery can prune partitions and clustering on the raw column — wrapping
 * the column in DATE() would defeat that.
 */
export function dateWindowPredicate(
  alias: string,
  column: string,
  type: 'DATE' | 'DATETIME' | 'TIMESTAMP',
  params: { from: string; to: string; timezone: string },
): string {
  const c = col(alias, column);
  switch (type) {
    case 'DATE':
      return `${c} >= @${params.from} AND ${c} < DATE_ADD(@${params.to}, INTERVAL 1 DAY)`;
    case 'DATETIME':
      return `${c} >= DATETIME(@${params.from}) AND ${c} < DATETIME(DATE_ADD(@${params.to}, INTERVAL 1 DAY))`;
    case 'TIMESTAMP':
      // Day boundaries are resolved in the business timezone, not UTC.
      return (
        `${c} >= TIMESTAMP(@${params.from}, @${params.timezone}) AND ` +
        `${c} < TIMESTAMP(DATE_ADD(@${params.to}, INTERVAL 1 DAY), @${params.timezone})`
      );
  }
}

/** Normalised status expression, matching how status values are bound. */
export function statusExpression(alias: string, column: string, caseInsensitive: boolean): string {
  const expr = `TRIM(CAST(${col(alias, column)} AS STRING))`;
  return caseInsensitive ? `LOWER(${expr})` : expr;
}

export function normalizeStatusValue(value: string, caseInsensitive: boolean): string {
  const trimmed = value.trim();
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** Normalised join-key expression for lead <-> order matching. */
export function joinKeyExpression(
  alias: string,
  column: string,
  options: { normalize: boolean; stripCharacters: string; lastCharacters?: number },
): string {
  let expr = `CAST(${col(alias, column)} AS STRING)`;
  if (options.stripCharacters) {
    expr = `REGEXP_REPLACE(${expr}, r'${toCharacterClass(options.stripCharacters)}', '')`;
  }
  if (options.normalize) expr = `LOWER(TRIM(${expr}))`;
  if (options.lastCharacters) expr = `RIGHT(${expr}, ${Math.trunc(options.lastCharacters)})`;
  return `NULLIF(${expr}, '')`;
}

/**
 * Renders one column filter as a predicate plus the parameter it needs.
 * Values are always bound, never interpolated.
 */
export function columnFilterPredicate(
  alias: string,
  filter: { column: string; operator: 'in' | 'not_in'; values: string[]; caseInsensitive: boolean; treatNullAsExcluded: boolean },
  paramName: string,
): { predicate: string; value: string[] } {
  const expr = statusExpression(alias, filter.column, filter.caseInsensitive);
  const value = filter.values.map((v) => normalizeStatusValue(v, filter.caseInsensitive));

  if (filter.operator === 'in') {
    return { predicate: `${expr} IN UNNEST(@${paramName})`, value };
  }
  const notIn = `${expr} NOT IN UNNEST(@${paramName})`;
  return {
    predicate: filter.treatNullAsExcluded
      ? `(${col(alias, filter.column)} IS NOT NULL AND ${notIn})`
      : `(${col(alias, filter.column)} IS NULL OR ${notIn})`,
    value,
  };
}

/**
 * Predicates for BOOLEAN validity flags. NULL is treated as FALSE, so a missing
 * flag never silently excludes (or includes) a row.
 */
export function booleanFlagPredicates(
  alias: string,
  flags: { excludeWhenTrue: string[]; requireTrue: string[] },
): string[] {
  return [
    ...flags.excludeWhenTrue.map((c) => `COALESCE(${col(alias, c)}, FALSE) = FALSE`),
    ...flags.requireTrue.map((c) => `COALESCE(${col(alias, c)}, FALSE) = TRUE`),
  ];
}

/**
 * QUALIFY clause that keeps one row per natural key.
 *
 * All tiebreak terms are emitted so the surviving row is deterministic; without
 * them a tied ordering key silently randomises the metric.
 */
export function dedupeQualify(
  alias: string,
  dedupe: {
    keyColumns: string[];
    orderByColumn: string;
    direction: 'ASC' | 'DESC';
    tiebreakColumns: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  },
): string {
  const partition = dedupe.keyColumns.map((c) => col(alias, c)).join(', ');
  const ordering = [
    `${col(alias, dedupe.orderByColumn)} ${dedupe.direction}`,
    ...dedupe.tiebreakColumns.map((t) => `${col(alias, t.column)} ${t.direction}`),
  ].join(', ');
  return `QUALIFY ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${ordering}) = 1`;
}
