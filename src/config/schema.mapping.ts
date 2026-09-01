import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env } from './env.js';

/**
 * ---------------------------------------------------------------------------
 * SCHEMA MAPPING
 * ---------------------------------------------------------------------------
 * This service makes NO assumptions about BigQuery dataset names, table names,
 * column names or status values. Every one of those facts is declared here, in
 * a file produced from real introspection of the target BigQuery instance
 * (see `npm run discover:schema`).
 *
 * The mapping is validated on load, and every identifier is checked against a
 * strict pattern before it can reach generated SQL.
 */

/** BigQuery identifiers we are willing to interpolate into SQL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Fully-qualified table: `project.dataset.table`, or `dataset.table`. */
const TABLE_REF = /^[A-Za-z0-9_.\-]+\.[A-Za-z_][A-Za-z0-9_]*$/;
/** Wildcard table: `project.dataset.prefix_*`. */
const WILDCARD_REF = /^[A-Za-z0-9_.\-]+\.[A-Za-z_][A-Za-z0-9_]*\*$/;

const identifier = z.string().regex(IDENT, 'must be a bare BigQuery identifier (letters, digits, underscore)');
const tableRef = z.string().regex(TABLE_REF, 'must look like `project.dataset.table` or `dataset.table`');

/**
 * Where a logical entity physically lives. Covers the three real-world layouts:
 *  - `table`    : one canonical table or view (README Option A)
 *  - `tables`   : an explicit list, UNION ALL-ed (heterogeneous history)
 *  - `wildcard` : date-sharded tables, pruned with _TABLE_SUFFIX (README Option B)
 */
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), table: tableRef }),
  z.object({ kind: z.literal('tables'), tables: z.array(tableRef).min(1) }),
  z.object({
    kind: z.literal('wildcard'),
    table: z.string().regex(WILDCARD_REF, 'must look like `project.dataset.prefix_*`'),
    /** Format of the shard suffix so it can be compared to the date window. */
    suffixFormat: z.enum(['YYYYMM', 'YYYY_MM', 'YYYYMMDD', 'YYYY_MM_DD', 'YYYY']),
  }),
]);

/** How a text column should be compared to the supplied pincode. */
const pincodeMatchSchema = z
  .object({
    /** Column type in BigQuery. Drives casting so no implicit coercion happens. */
    columnType: z.enum(['STRING', 'INT64', 'NUMERIC']).default('STRING'),
    /** Trim surrounding whitespace before comparison. */
    trim: z.boolean().default(true),
    /** Compare case-insensitively (relevant for alphanumeric postcodes). */
    caseInsensitive: z.boolean().default(false),
    /** Strip these characters from the column before comparing (e.g. " -"). */
    stripCharacters: z.string().default(''),
  })
  .default({});

/**
 * A filter on any column, so validity is not limited to one "status" column.
 * Real warehouses split validity across several columns — e.g. `order_status`,
 * `pre_post_order_type` and a `flag` marking test rows.
 *
 * NULL handling is explicit: `in` never matches NULL; `not_in` keeps NULL
 * (absence of a value is not evidence of exclusion) unless
 * `treatNullAsExcluded` is set.
 */
const columnFilterSchema = z.object({
  column: identifier,
  operator: z.enum(['in', 'not_in']),
  values: z.array(z.string()).min(1),
  caseInsensitive: z.boolean().default(true),
  /** For `not_in`: also drop rows where the column IS NULL. */
  treatNullAsExcluded: z.boolean().default(false),
});

/**
 * Boolean validity flags. Real warehouses often express order validity as
 * BOOLEAN columns (`is_cancelled`, `is_refunded`) rather than a status string.
 */
const booleanFlagsSchema = z
  .object({
    /** Rows where any of these is TRUE are excluded. NULL is treated as FALSE. */
    excludeWhenTrue: z.array(identifier).default([]),
    /** Rows are kept only when all of these are TRUE. NULL is treated as FALSE. */
    requireTrue: z.array(identifier).default([]),
  })
  .default({});

/**
 * Collapses duplicate rows to one per natural key.
 *
 * The ordering MUST be deterministic. If the ordering key has ties among rows
 * whose measured columns differ, the surviving row — and therefore the metric —
 * changes between otherwise identical queries. Observed in `devx-tsc`: 11,863
 * order items had differing `sales` among rows tied on `record_updated_at`.
 * Add tiebreak columns until the selected value is stable.
 */
const dedupeSchema = z
  .object({
    /** Columns forming the natural key of one logical record. */
    keyColumns: z.array(identifier).min(1),
    /** Primary ordering column used to pick the surviving row (latest wins). */
    orderByColumn: identifier,
    direction: z.enum(['DESC', 'ASC']).default('DESC'),
    /**
     * Additional ordering terms applied after `orderByColumn`, in order, to make
     * the choice deterministic. Put the measured column first (so its selected
     * value is stable) then a near-unique column.
     */
    tiebreakColumns: z
      .array(z.object({ column: identifier, direction: z.enum(['DESC', 'ASC']).default('DESC') }))
      .default([]),
  })
  .optional();

const ordersSchema = z.object({
  source: sourceSchema,
  columns: z.object({
    /** Unique order identifier — used to count orders exactly once. */
    orderId: identifier,
    /** Column carrying the delivery/billing pincode. */
    pincode: identifier,
    /** DATE/DATETIME/TIMESTAMP column used for the 6-month filter. */
    orderDate: identifier,
    /** Monetary column summed for total order value. */
    orderValue: identifier,
    /** Order status column, when the schema has one. */
    status: identifier.optional(),
    /** Identifier that can be joined back to leads (phone, customer id, ...). */
    joinKey: identifier.optional(),
  }),
  /** Type of `orderDate`, so the right BigQuery cast/filter is emitted. */
  orderDateType: z.enum(['DATE', 'DATETIME', 'TIMESTAMP']).default('DATE'),
  pincodeMatch: pincodeMatchSchema,
  /**
   * Status handling. Exactly one of these should be used:
   *  - includeStatuses: allow-list of statuses that count as a valid order
   *  - excludeStatuses: deny-list (e.g. cancelled / refunded / failed)
   * Leave both empty ONLY if the table has no status column.
   */
  includeStatuses: z.array(z.string()).default([]),
  excludeStatuses: z.array(z.string()).default([]),
  /** Compare statuses case-insensitively. */
  statusCaseInsensitive: z.boolean().default(true),
  /** Drop non-positive order values from AOV (returns booked at 0, test rows). */
  requirePositiveValue: z.boolean().default(true),
  /** BOOLEAN validity flags, e.g. exclude rows where `is_cancelled` is TRUE. */
  booleanFlags: booleanFlagsSchema,
  /** Arbitrary per-column validity filters, applied in addition to the above. */
  columnFilters: z.array(columnFilterSchema).default([]),
  dedupe: dedupeSchema,
});

const leadsSchema = z.object({
  source: sourceSchema,
  columns: z.object({
    /** Unique lead identifier. */
    leadId: identifier,
    pincode: identifier,
    /** Lead creation date — the 6-month cohort anchor. */
    createdAt: identifier,
    /** Lead status column, when present. */
    status: identifier.optional(),
    /** Identifier joinable to `orders.columns.joinKey`. */
    joinKey: identifier.optional(),
  }),
  createdAtType: z.enum(['DATE', 'DATETIME', 'TIMESTAMP']).default('DATE'),
  pincodeMatch: pincodeMatchSchema,
  /** Statuses excluded from the eligible-lead denominator (junk/spam/duplicate). */
  excludeStatuses: z.array(z.string()).default([]),
  statusCaseInsensitive: z.boolean().default(true),
  /** BOOLEAN eligibility flags on the lead row. */
  booleanFlags: booleanFlagsSchema,
  /** Arbitrary per-column eligibility filters. */
  columnFilters: z.array(columnFilterSchema).default([]),
  dedupe: dedupeSchema,
  /**
   * How "converted" is defined. This is a business decision that MUST be taken
   * from the real data, so it is explicit and documented in the mapping file.
   *  - status_flag : the lead row itself carries a converted status/flag
   *  - join_orders : a lead is converted if a qualifying order shares its joinKey
   */
  conversion: z.discriminatedUnion('strategy', [
    z.object({
      strategy: z.literal('status_flag'),
      /** Statuses on the lead row that mean "converted". */
      convertedStatuses: z.array(z.string()).min(1),
      /** Column holding the status, if different from `columns.status`. */
      column: identifier.optional(),
    }),
    z.object({
      strategy: z.literal('boolean_flag'),
      /** BOOLEAN column that is TRUE for a converted lead. */
      column: identifier,
    }),
    z.object({
      strategy: z.literal('join_orders'),
      /**
       * Require the matching order to fall inside the reporting window too.
       * `false` counts any qualifying order regardless of order date.
       */
      orderWithinPeriod: z.boolean().default(true),
      /** Normalise both sides of the join (trim/lower/strip) before matching. */
      normalizeJoinKey: z.boolean().default(true),
      /** Characters stripped from the join key, e.g. "+ -()" for phone numbers. */
      joinKeyStripCharacters: z.string().default(''),
      /** Keep only the last N characters of the key (e.g. 10 for Indian mobiles). */
      joinKeyLastCharacters: z.number().int().positive().optional(),
    }),
  ]),
});

export const schemaMappingSchema = z.object({
  /** Free-text provenance: who discovered this, when, against which project. */
  meta: z
    .object({
      discoveredAt: z.string().optional(),
      project: z.string().optional(),
      notes: z.string().optional(),
    })
    .default({}),
  orders: ordersSchema,
  leads: leadsSchema,
});

export type SchemaMapping = z.infer<typeof schemaMappingSchema>;
export type OrdersMapping = SchemaMapping['orders'];
export type LeadsMapping = SchemaMapping['leads'];
export type TableSource = z.infer<typeof sourceSchema>;
export type PincodeMatch = z.infer<typeof pincodeMatchSchema>;
export type BooleanFlags = z.infer<typeof booleanFlagsSchema>;
export type ColumnFilter = z.infer<typeof columnFilterSchema>;

export class SchemaMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMappingError';
  }
}

let cached: SchemaMapping | null = null;

export function loadSchemaMapping(mappingPath: string = env.SCHEMA_MAPPING_PATH): SchemaMapping {
  const absolute = path.isAbsolute(mappingPath) ? mappingPath : path.resolve(process.cwd(), mappingPath);

  if (!fs.existsSync(absolute)) {
    throw new SchemaMappingError(
      `Schema mapping not found at "${absolute}".\n` +
        `This service refuses to guess BigQuery table/column names.\n` +
        `Run "npm run discover:schema" to introspect the real BigQuery instance, ` +
        `then copy config/schema.mapping.example.json to ${mappingPath} and fill it in ` +
        `with the discovered tables, columns and status values.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new SchemaMappingError(`Schema mapping at "${absolute}" is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = schemaMappingSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new SchemaMappingError(`Schema mapping at "${absolute}" is invalid:\n${issues}`);
  }

  assertConsistent(parsed.data);
  return parsed.data;
}

/** Cross-field checks the shape alone cannot express. */
function assertConsistent(mapping: SchemaMapping): void {
  const problems: string[] = [];

  if (mapping.orders.includeStatuses.length > 0 && mapping.orders.excludeStatuses.length > 0) {
    problems.push('orders: set either includeStatuses (allow-list) or excludeStatuses (deny-list), not both');
  }
  if (
    (mapping.orders.includeStatuses.length > 0 || mapping.orders.excludeStatuses.length > 0) &&
    !mapping.orders.columns.status
  ) {
    problems.push('orders: status filters were configured but orders.columns.status is missing');
  }
  if (mapping.leads.excludeStatuses.length > 0 && !mapping.leads.columns.status) {
    problems.push('leads: excludeStatuses was configured but leads.columns.status is missing');
  }

  if (mapping.leads.conversion.strategy === 'status_flag') {
    const column = mapping.leads.conversion.column ?? mapping.leads.columns.status;
    if (!column) {
      problems.push(
        'leads.conversion: strategy "status_flag" needs either leads.conversion.column or leads.columns.status',
      );
    }
  } else if (mapping.leads.conversion.strategy === 'boolean_flag') {
    // The column is required by the shape; nothing further to cross-check.
  } else {
    if (!mapping.leads.columns.joinKey) {
      problems.push('leads.conversion: strategy "join_orders" needs leads.columns.joinKey');
    }
    if (!mapping.orders.columns.joinKey) {
      problems.push('leads.conversion: strategy "join_orders" needs orders.columns.joinKey');
    }
  }

  if (problems.length > 0) {
    throw new SchemaMappingError(`Schema mapping is internally inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export function getSchemaMapping(): SchemaMapping {
  cached ??= loadSchemaMapping();
  return cached;
}

/** Test hook. */
export function __setSchemaMapping(mapping: SchemaMapping | null): void {
  cached = mapping;
}
