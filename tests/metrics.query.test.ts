import { describe, expect, it } from 'vitest';
import { buildMetricsQuery } from '../src/repositories/sql/metrics.query.js';
import { resolveDateWindow } from '../src/utils/date.js';
import { BigQueryDate } from '@google-cloud/bigquery';
import { booleanFlagsMapping, joinOrdersMapping, statusFlagMapping } from './fixtures/mapping.js';
import { schemaMappingSchema } from '../src/config/schema.mapping.js';

const window = resolveDateWindow(new Date('2026-08-31T06:30:00.000Z'), 6, 'calendar_months', 'Asia/Kolkata');

describe('metrics query builder — efficiency guarantees', () => {
  const { sql, params, types } = buildMetricsQuery(joinOrdersMapping, '400092', window);

  it('never uses SELECT *', () => {
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it('binds the pincode and date window as parameters, not string literals', () => {
    expect(sql).not.toContain('400092');
    expect(sql).not.toContain('2026-03-01');
    expect(params.ordersPincode).toBe('400092');
    expect(params.leadsPincode).toBe('400092');
    expect((params.from as { value: string }).value).toBe('2026-03-01');
    expect((params.to as { value: string }).value).toBe('2026-08-31');
    expect(types.from).toBe('DATE');
  });

  it('filters by pincode inside BigQuery for both entities', () => {
    expect(sql).toContain('= @ordersPincode');
    expect(sql).toContain('= @leadsPincode');
  });

  it('leaves the date column unwrapped so partitions can be pruned', () => {
    expect(sql).toContain('`o`.`order_created_at` >= TIMESTAMP(@from, @timezone)');
    expect(sql).not.toContain('DATE(`o`.`order_created_at`)');
  });

  it('returns a single row with all four supporting counters from one job', () => {
    expect(sql.match(/^SELECT$/gm)?.length).toBeGreaterThan(0);
    expect(sql).toContain('orders_agg.totalOrders');
    expect(sql).toContain('orders_agg.totalOrderValue');
    expect(sql).toContain('leads_agg.totalLeads');
    expect(sql).toContain('leads_agg.convertedLeads');
    expect(sql).toContain('CROSS JOIN leads_agg');
  });

  it('projects only the required columns', () => {
    expect(sql).toContain('AS order_id');
    expect(sql).toContain('AS order_value');
    expect(sql).toContain('AS lead_id');
  });
});

describe('metrics query builder — order validity rules', () => {
  it('applies a status deny-list while keeping NULL statuses', () => {
    const { sql, params } = buildMetricsQuery(joinOrdersMapping, '400092', window);
    expect(params.ordersExcludeStatuses).toEqual(['cancelled', 'refunded']);
    expect(sql).toContain('`o`.`order_status` IS NULL OR');
    expect(sql).toContain('NOT IN UNNEST(@ordersExcludeStatuses)');
  });

  it('applies a status allow-list when configured', () => {
    const { sql, params } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(params.ordersIncludeStatuses).toEqual(['delivered', 'shipped']);
    expect(sql).toContain('IN UNNEST(@ordersIncludeStatuses)');
    expect(sql).not.toContain('@ordersExcludeStatuses');
  });

  it('drops non-positive order values when requirePositiveValue is set', () => {
    expect(buildMetricsQuery(joinOrdersMapping, '400092', window).sql).toContain('`o`.`grand_total` > 0');
    expect(buildMetricsQuery(statusFlagMapping, '400092', window).sql).not.toContain('`net_amount` > 0');
  });

  it('counts each order exactly once', () => {
    expect(buildMetricsQuery(joinOrdersMapping, '400092', window).sql).toContain('COUNT(DISTINCT order_id) AS totalOrders');
  });

  it('deduplicates rows when a natural key is declared', () => {
    const { sql } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(sql).toContain('QUALIFY ROW_NUMBER() OVER (PARTITION BY `o`.`order_id` ORDER BY `o`.`updated_at` DESC) = 1');
  });
});

describe('metrics query builder — table layouts', () => {
  it('prunes date-sharded tables with _TABLE_SUFFIX', () => {
    const { sql, params } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(sql).toContain('`o`._TABLE_SUFFIX BETWEEN @ordersSuffixMin AND @ordersSuffixMax');
    expect(params.ordersSuffixMin).toBe('2026_03');
    expect(params.ordersSuffixMax).toBe('2026_08');
  });

  it('UNION ALLs an explicit table list', () => {
    const { sql } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(sql).toContain('`test-project.crm.leads_current`');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('`test-project.crm.leads_archive`');
  });

  it('casts an INT64 pincode column to STRING for comparison', () => {
    const { sql } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(sql).toContain('CAST(`o`.`pincode` AS STRING)');
  });
});

describe('metrics query builder — conversion definitions', () => {
  it('status_flag: reads the converted flag off the lead row, no join', () => {
    const { sql, params } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(params.convertedStatuses).toEqual(['order placed', 'won']);
    expect(sql).toContain('lead_status_norm IN UNNEST(@convertedStatuses)');
    expect(sql).not.toContain('order_join_keys');
  });

  it('join_orders: matches leads to orders on a normalised key', () => {
    const { sql } = buildMetricsQuery(joinOrdersMapping, '400092', window);
    expect(sql).toContain('order_join_keys AS (');
    expect(sql).toContain('LEFT JOIN order_join_keys');
    expect(sql).toContain("RIGHT(LOWER(TRIM(REGEXP_REPLACE(CAST(`l`.`lead_phone` AS STRING)");
    expect(sql).toContain('), 10)');
    // Reuses the already-scanned orders CTE rather than re-scanning the table.
    expect(sql).toContain('FROM orders_scoped\n  WHERE join_key_raw IS NOT NULL');
  });

  it('join_orders: counts converted leads without join fan-out', () => {
    const { sql } = buildMetricsQuery(joinOrdersMapping, '400092', window);
    expect(sql).toContain('COUNT(DISTINCT IF(is_converted, lead_id, NULL)) AS convertedLeads');
    expect(sql).toContain('SELECT DISTINCT');
  });

  it('join_orders with orderWithinPeriod=false scans orders without the date filter', () => {
    const mapping = schemaMappingSchema.parse({
      ...joinOrdersMapping,
      leads: {
        ...joinOrdersMapping.leads,
        conversion: { ...joinOrdersMapping.leads.conversion, orderWithinPeriod: false },
      },
    });
    const { sql } = buildMetricsQuery(mapping, '400092', window);
    expect(sql).toContain('ignoring the date window');
    expect(sql).toContain('`test-project.analytics.fact_orders` AS `o`\n  WHERE');
  });

  it('omits the order join key entirely when conversion does not need it', () => {
    const { sql } = buildMetricsQuery(statusFlagMapping, '400092', window);
    expect(sql).not.toContain('join_key_raw');
  });
});

describe('metrics query builder — injection resistance', () => {
  it('refuses to interpolate an unsafe identifier', () => {
    const evil = JSON.parse(JSON.stringify(joinOrdersMapping)) as typeof joinOrdersMapping;
    (evil.orders.columns as Record<string, string>).pincode = 'x`; DROP TABLE t; --';
    expect(() => buildMetricsQuery(evil, '400092', window)).toThrow(/unsafe identifier/);
  });

  it('rejects an unsafe identifier at mapping-validation time too', () => {
    const evil = JSON.parse(JSON.stringify(joinOrdersMapping)) as Record<string, any>;
    evil.orders.columns.pincode = 'x`; DROP TABLE t; --';
    expect(schemaMappingSchema.safeParse(evil).success).toBe(false);
  });

  it('passes hostile pincode input through as a bound parameter only', () => {
    const { sql, params } = buildMetricsQuery(joinOrdersMapping, "400092' OR 1=1 --", window);
    expect(sql).not.toContain('OR 1=1');
    expect(params.ordersPincode).toBe("400092' OR 1=1 --");
  });
});


describe('metrics query builder — DATE parameter binding (regression)', () => {
  /**
   * Regression: date bounds were bound as plain strings alongside
   * `types: { from: 'DATE' }`. The BigQuery client binds that combination as
   * NULL, so every date predicate silently evaluated false and the API returned
   * zeros for every pincode instead of failing. Verified against real BigQuery:
   * `CAST(@from AS STRING)` returned NULL for a raw string bound as DATE.
   * Dates must be BigQueryDate instances.
   */
  const { params } = buildMetricsQuery(joinOrdersMapping, '400092', window);

  it('binds date bounds as BigQueryDate, never as a raw string', () => {
    for (const key of ['from', 'to'] as const) {
      expect(typeof params[key], `${key} must not be a bare string`).not.toBe('string');
      expect(params[key]).toBeInstanceOf(BigQueryDate);
      expect((params[key] as BigQueryDate).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps non-date parameters as plain values', () => {
    expect(params.timezone).toBe('Asia/Kolkata');
    expect(params.ordersPincode).toBe('400092');
  });

  it('declares array types so empty status lists do not break the query', () => {
    // BigQuery rejects an empty array parameter with no declared type.
    const { types } = buildMetricsQuery(joinOrdersMapping, '400092', window);
    for (const [name, type] of Object.entries(types)) {
      if (Array.isArray(type)) expect(type).toEqual(['STRING']);
      expect(name).toBeTypeOf('string');
    }
  });
});

describe('metrics query builder — boolean validity flags', () => {
  it('excludes rows where a flag is TRUE, treating NULL as FALSE', () => {
    const { sql } = buildMetricsQuery(booleanFlagsMapping, '400092', window);
    expect(sql).toContain('COALESCE(`o`.`is_cancelled`, FALSE) = FALSE');
    expect(sql).toContain('COALESCE(`o`.`is_refunded`, FALSE) = FALSE');
  });

  it('requires rows where a flag must be TRUE', () => {
    const mapping = schemaMappingSchema.parse({
      ...booleanFlagsMapping,
      orders: {
        ...booleanFlagsMapping.orders,
        booleanFlags: { excludeWhenTrue: [], requireTrue: ['is_paid'] },
      },
    });
    expect(buildMetricsQuery(mapping, '400092', window).sql).toContain('COALESCE(`o`.`is_paid`, FALSE) = TRUE');
  });

  it('supports a boolean conversion flag on the lead row', () => {
    const mapping = schemaMappingSchema.parse({
      ...booleanFlagsMapping,
      leads: {
        ...booleanFlagsMapping.leads,
        conversion: { strategy: 'boolean_flag', column: 'has_ordered' },
      },
    });
    const { sql } = buildMetricsQuery(mapping, '400092', window);
    expect(sql).toContain('COALESCE(`l`.`has_ordered`, FALSE) AS is_converted');
    expect(sql).toContain('COUNT(DISTINCT IF(is_converted, lead_id, NULL)) AS convertedLeads');
    expect(sql).not.toContain('order_join_keys');
  });
});

describe('metrics query builder — multi-column validity filters', () => {
  /**
   * The real warehouse splits order validity across three columns
   * (`order_status`, `pre_post_order_type`, `flag`), which a single
   * status allow/deny list cannot express.
   */
  const mapping = schemaMappingSchema.parse({
    ...booleanFlagsMapping,
    orders: {
      ...booleanFlagsMapping.orders,
      columns: { ...booleanFlagsMapping.orders.columns, status: 'order_status' },
      includeStatuses: ['valid'],
      columnFilters: [
        { column: 'pre_post_order_type', operator: 'in', values: ['pre_order'] },
        { column: 'flag', operator: 'not_in', values: ['inf_test'] },
      ],
    },
  });

  const { sql, params, types } = buildMetricsQuery(mapping, '400092', window);

  it('applies every filter as a bound parameter', () => {
    expect(sql).toContain('IN UNNEST(@ordersFilter0)');
    expect(params.ordersFilter0).toEqual(['pre_order']);
    expect(params.ordersFilter1).toEqual(['inf_test']);
    expect(types.ordersFilter0).toEqual(['STRING']);
    expect(sql).not.toContain('pre_order\'');
  });

  it('keeps NULL on a not_in filter unless told otherwise', () => {
    expect(sql).toContain('`o`.`flag` IS NULL OR');
    const strict = schemaMappingSchema.parse({
      ...mapping,
      orders: {
        ...mapping.orders,
        columnFilters: [{ column: 'flag', operator: 'not_in', values: ['inf_test'], treatNullAsExcluded: true }],
      },
    });
    expect(buildMetricsQuery(strict, '400092', window).sql).toContain('`o`.`flag` IS NOT NULL AND');
  });

  it('composes with the status allow-list and boolean flags', () => {
    expect(sql).toContain('IN UNNEST(@ordersIncludeStatuses)');
    expect(sql).toContain('COALESCE(`o`.`is_cancelled`, FALSE) = FALSE');
  });
});

describe('metrics query builder — deterministic deduplication (regression)', () => {
  /**
   * Regression: dedupe ordered only by `record_updated_at`. In the real data
   * 11,863 order items have differing `sales` among rows tied on that column,
   * so ROW_NUMBER picked arbitrarily and the total order value changed between
   * identical queries. Tiebreak terms must be emitted.
   */
  const mapping = schemaMappingSchema.parse({
    ...booleanFlagsMapping,
    orders: {
      ...booleanFlagsMapping.orders,
      dedupe: {
        keyColumns: ['order_item_doc_id'],
        orderByColumn: 'record_updated_at',
        direction: 'DESC',
        tiebreakColumns: [
          { column: 'sales', direction: 'DESC' },
          { column: 'tracking_doc_id', direction: 'DESC' },
        ],
      },
    },
  });

  it('emits every ordering term, in order', () => {
    expect(buildMetricsQuery(mapping, '400092', window).sql).toContain(
      'QUALIFY ROW_NUMBER() OVER (PARTITION BY `o`.`order_item_doc_id` ' +
        'ORDER BY `o`.`record_updated_at` DESC, `o`.`sales` DESC, `o`.`tracking_doc_id` DESC) = 1',
    );
  });

  it('still works with no tiebreaks declared', () => {
    const single = schemaMappingSchema.parse({
      ...mapping,
      orders: { ...mapping.orders, dedupe: { keyColumns: ['order_id'], orderByColumn: 'updated_at' } },
    });
    expect(buildMetricsQuery(single, '400092', window).sql).toContain(
      'ORDER BY `o`.`updated_at` DESC) = 1',
    );
  });

  it('is a pure function: the same inputs give byte-identical SQL', () => {
    const a = buildMetricsQuery(mapping, '400092', window);
    const b = buildMetricsQuery(mapping, '400092', window);
    expect(a.sql).toBe(b.sql);
    expect(JSON.stringify(a.params)).toBe(JSON.stringify(b.params));
  });
});

describe('metrics query builder — column_threshold conversion', () => {
  /**
   * The canonical conversion query reads the outcome straight off the lead row
   * (`Total_Orders > 0`) rather than joining to orders, and restricts the
   * cohort with `mapping IN ('Ho','Store')`.
   */
  const mapping = schemaMappingSchema.parse({
    ...joinOrdersMapping,
    leads: {
      ...joinOrdersMapping.leads,
      columnFilters: [{ column: 'mapping', operator: 'in', values: ['Ho', 'Store'] }],
      conversion: { strategy: 'column_threshold', column: 'Total_Orders', operator: 'gt', value: 0 },
    },
  });

  it('reads the conversion flag off the lead row, with no join to orders', () => {
    const { sql, params } = buildMetricsQuery(mapping, '400058', window);
    expect(sql).toContain('COALESCE(`l`.`Total_Orders`, 0) > @convertedThreshold AS is_converted');
    expect(params.convertedThreshold).toBe(0);
    expect(sql).not.toContain('order_join_keys');
    expect(sql).not.toContain('LEFT JOIN');
  });

  it('treats a NULL count as not converted', () => {
    expect(buildMetricsQuery(mapping, '400058', window).sql).toContain('COALESCE(`l`.`Total_Orders`, 0)');
  });

  it('applies the cohort filter as a bound parameter', () => {
    const { sql, params } = buildMetricsQuery(mapping, '400058', window);
    expect(sql).toContain('IN UNNEST(@leadsFilter0)');
    expect(params.leadsFilter0).toEqual(['ho', 'store']);
    expect(sql).not.toContain("'Ho'");
  });

  it('supports the other comparison operators', () => {
    for (const [op, symbol] of [['gte', '>='], ['eq', '='], ['lt', '<'], ['lte', '<=']] as const) {
      const m = schemaMappingSchema.parse({
        ...mapping,
        leads: { ...mapping.leads, conversion: { strategy: 'column_threshold', column: 'Total_Orders', operator: op, value: 2 } },
      });
      expect(buildMetricsQuery(m, '400058', window).sql).toContain(`, 0) ${symbol} @convertedThreshold`);
    }
  });

  it('does not require a joinKey on either side', () => {
    const m = JSON.parse(JSON.stringify(mapping));
    delete m.leads.columns.joinKey;
    delete m.orders.columns.joinKey;
    expect(() => buildMetricsQuery(schemaMappingSchema.parse(m), '400058', window)).not.toThrow();
  });
});
