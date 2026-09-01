import { env } from '../config/env.js';
import { getSchemaMapping, type SchemaMapping } from '../config/schema.mapping.js';
import { BigQueryMetricsRepository, type MetricsRepository } from '../repositories/bigquery.repository.js';
import { resolveDateWindow, type DateWindow } from '../utils/date.js';
import { logger } from '../utils/logger.js';
import type { MetricsPayload, MetricsResult } from '../types/metrics.js';

const NO_DATA_MESSAGE = 'No data found for the requested pincode and period.';

/** Rounds to `digits` decimal places without float drift artefacts. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

interface CacheEntry {
  payload: MetricsPayload;
  message?: string;
  expiresAt: number;
  storedAt: number;
}

/**
 * Small in-process TTL cache. Pincode metrics over a 6-month window change
 * slowly, so this removes repeated BigQuery jobs for the same pincode without
 * introducing external infrastructure.
 */
class TtlCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxEntries: number = env.METRICS_CACHE_MAX_ENTRIES,
  ) {}

  get(key: string): CacheEntry | undefined {
    if (this.ttlSeconds <= 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, payload: MetricsPayload, message?: string): void {
    if (this.ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const now = Date.now();
    this.entries.set(key, {
      payload,
      ...(message ? { message } : {}),
      storedAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

export class MetricsService {
  private readonly repository: MetricsRepository;
  private readonly mapping: SchemaMapping;
  private readonly cache: TtlCache;

  constructor(
    repository?: MetricsRepository,
    mapping?: SchemaMapping,
    cache: TtlCache = new TtlCache(env.METRICS_CACHE_TTL_SECONDS, env.METRICS_CACHE_MAX_ENTRIES),
  ) {
    this.mapping = mapping ?? getSchemaMapping();
    this.repository = repository ?? new BigQueryMetricsRepository(undefined, this.mapping);
    this.cache = cache;
  }

  /**
   * Orchestrates one metrics lookup: resolve the window, query BigQuery once,
   * derive both metrics, and describe how they were derived.
   */
  async getMetrics(pincode: string, now: Date = new Date()): Promise<MetricsResult> {
    const window = resolveDateWindow(now);
    const cacheKey = `${pincode}::${window.from}::${window.to}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        payload: {
          ...cached.payload,
          meta: {
            ...cached.payload.meta,
            cached: true,
            ageSeconds: Math.round((Date.now() - cached.storedAt) / 1000),
          },
        },
        ...(cached.message ? { message: cached.message } : {}),
      };
    }

    const raw = await this.repository.fetchMetrics(pincode, window);

    // Two readings of "average order value" exist on a line-item table, and they
    // differ materially. The mapping chooses which is the headline; both are
    // reported so a consumer can see the other.
    const averageRowValue = raw.averageRowValue == null ? null : round(raw.averageRowValue, 2);
    const averagePerOrder = raw.totalOrders > 0 ? round(raw.totalOrderValue / raw.totalOrders, 2) : null;
    const averageOrderValue =
      this.mapping.orders.aovMethod === 'average_of_rows' ? averageRowValue : averagePerOrder;
    const conversionRate = raw.totalLeads > 0 ? round((raw.convertedLeads / raw.totalLeads) * 100, 2) : null;
    const hasData = raw.totalOrders > 0 || raw.totalLeads > 0;

    if (!hasData) {
      logger.info({ pincode, from: window.from, to: window.to }, 'No data for pincode in reporting window');
    }

    const payload: MetricsPayload = {
      pincode,
      period: {
        from: window.from,
        to: window.to,
        months: window.months,
        mode: window.mode,
        anchor: window.anchor,
        timezone: window.timezone,
        nextRolloverOn: window.nextRolloverOn,
      },
      metrics: { averageOrderValue, conversionRate },
      supporting: {
        totalOrders: raw.totalOrders,
        totalOrderValue: round(raw.totalOrderValue, 2),
        totalLeads: raw.totalLeads,
        convertedLeads: raw.convertedLeads,
        averageRowValue,
      },
      definitions: describeDefinitions(this.mapping, window),
      meta: {
        hasData,
        generatedAt: now.toISOString(),
        cached: false,
        fetchedAt: now.toISOString(),
        ageSeconds: 0,
        ...(raw.bytesProcessed !== undefined ? { bytesProcessed: raw.bytesProcessed } : {}),
      },
    };

    const message = hasData ? undefined : NO_DATA_MESSAGE;
    this.cache.set(cacheKey, payload, message);

    return { payload, ...(message ? { message } : {}) };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Turns the schema mapping into a human-readable statement of each formula, so
 * the API is self-documenting and the numbers are auditable by consumers.
 */
export function describeDefinitions(mapping: SchemaMapping, window: DateWindow): MetricsPayload['definitions'] {
  const orders = mapping.orders;
  const orderFilters: string[] = [];
  if (orders.columns.status && orders.includeStatuses.length > 0) {
    orderFilters.push(`status in [${orders.includeStatuses.join(', ')}]`);
  }
  if (orders.columns.status && orders.excludeStatuses.length > 0) {
    orderFilters.push(`status not in [${orders.excludeStatuses.join(', ')}]`);
  }
  for (const f of orders.columnFilters) {
    orderFilters.push(`${f.column} ${f.operator === 'in' ? 'in' : 'not in'} [${f.values.join(', ')}]`);
  }
  for (const flag of orders.booleanFlags.excludeWhenTrue) orderFilters.push(`${flag} is not true`);
  for (const flag of orders.booleanFlags.requireTrue) orderFilters.push(`${flag} is true`);
  if (orders.requirePositiveValue) orderFilters.push('order value > 0');

  if (orders.dedupe) {
    orderFilters.push(
      `duplicate rows collapsed to one per ${orders.dedupe.keyColumns.join('+')} ` +
        `(latest by ${orders.dedupe.orderByColumn})`,
    );
  }

  const numerator =
    orders.aovMethod === 'average_of_rows'
      ? `AVG(${orders.columns.orderValue}) across rows (average ITEM value, not per order) `
      : `SUM(${orders.columns.orderValue}) / COUNT(DISTINCT ${orders.columns.orderId}) `;

  const averageOrderValue =
    numerator +
    `over orders whose ${orders.columns.pincode} matches the requested pincode and whose ` +
    `${orders.columns.orderDate} falls in ${window.from}..${window.to}` +
    (orderFilters.length > 0 ? `, restricted to ${orderFilters.join(' and ')}` : '');

  const leads = mapping.leads;
  const leadExclusions: string[] = [];
  if (leads.columns.status && leads.excludeStatuses.length > 0) {
    leadExclusions.push(`status in [${leads.excludeStatuses.join(', ')}]`);
  }
  for (const f of leads.columnFilters) {
    leadExclusions.push(`${f.column} ${f.operator === 'in' ? 'not in' : 'in'} [${f.values.join(', ')}]`);
  }
  for (const flag of leads.booleanFlags.excludeWhenTrue) leadExclusions.push(`${flag} is true`);
  for (const flag of leads.booleanFlags.requireTrue) leadExclusions.push(`${flag} is not true`);
  if (leads.dedupe) {
    leadExclusions.push(
      `duplicate rows collapsed to one per ${leads.dedupe.keyColumns.join('+')} ` +
        `(latest by ${leads.dedupe.orderByColumn})`,
    );
  }
  const leadFilters = leadExclusions.length > 0 ? `, excluding leads where ${leadExclusions.join(' or ')}` : '';

  let convertedClause: string;
  if (leads.conversion.strategy === 'status_flag') {
    convertedClause =
      `a lead is converted when ${leads.conversion.column ?? leads.columns.status} is in ` +
      `[${leads.conversion.convertedStatuses.join(', ')}]`;
  } else if (leads.conversion.strategy === 'boolean_flag') {
    convertedClause = `a lead is converted when ${leads.conversion.column} is TRUE`;
  } else {
    convertedClause =
      `a lead is converted when a qualifying order shares its ${leads.columns.joinKey} ` +
      `(matched against orders.${mapping.orders.columns.joinKey}` +
      `${leads.conversion.orderWithinPeriod ? ' within the same period' : ' regardless of order date'})`;
  }

  const conversionRate =
    `COUNT(DISTINCT converted ${leads.columns.leadId}) / COUNT(DISTINCT ${leads.columns.leadId}) * 100 ` +
    `over leads whose ${leads.columns.pincode} matches the requested pincode and whose ` +
    `${leads.columns.createdAt} falls in ${window.from}..${window.to}${leadFilters}; ${convertedClause}`;

  return { averageOrderValue, conversionRate };
}
