import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../src/services/metrics.service.js';
import type { MetricsRepository, MetricsQueryResult } from '../src/repositories/bigquery.repository.js';
import { schemaMappingSchema } from '../src/config/schema.mapping.js';
import { joinOrdersMapping, statusFlagMapping } from './fixtures/mapping.js';
import type { DateWindow } from '../src/utils/date.js';

const NOW = new Date('2026-08-31T06:30:00.000Z');

function repositoryReturning(row: Partial<MetricsQueryResult>): MetricsRepository & { calls: Array<[string, DateWindow]> } {
  const calls: Array<[string, DateWindow]> = [];
  return {
    calls,
    async fetchMetrics(pincode, window) {
      calls.push([pincode, window]);
      return { totalOrders: 0, totalOrderValue: 0, totalLeads: 0, convertedLeads: 0, ...row };
    },
  };
}

describe('AOV calculation', () => {
  it('divides total order value by order count', async () => {
    const service = new MetricsService(
      repositoryReturning({ totalOrders: 125, totalOrderValue: 2_312_500 }),
      joinOrdersMapping,
    );
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.averageOrderValue).toBe(18_500);
    expect(payload.supporting).toMatchObject({ totalOrders: 125, totalOrderValue: 2_312_500 });
  });

  it('rounds to two decimal places', async () => {
    const service = new MetricsService(repositoryReturning({ totalOrders: 3, totalOrderValue: 10_000 }), joinOrdersMapping);
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.averageOrderValue).toBe(3333.33);
  });

  it('is null rather than NaN or Infinity when there are no orders', async () => {
    const service = new MetricsService(repositoryReturning({ totalOrders: 0, totalOrderValue: 0, totalLeads: 40 }), joinOrdersMapping);
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.averageOrderValue).toBeNull();
  });
});

describe('conversion-rate calculation', () => {
  it('expresses converted / eligible leads as a percentage', async () => {
    const service = new MetricsService(repositoryReturning({ totalLeads: 1004, convertedLeads: 125 }), joinOrdersMapping);
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.conversionRate).toBe(12.45);
  });

  it('handles a 100% conversion rate', async () => {
    const service = new MetricsService(repositoryReturning({ totalLeads: 7, convertedLeads: 7 }), joinOrdersMapping);
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.conversionRate).toBe(100);
  });

  it('is null rather than NaN when there are no eligible leads', async () => {
    const service = new MetricsService(repositoryReturning({ totalOrders: 5, totalOrderValue: 500, totalLeads: 0 }), joinOrdersMapping);
    const { payload } = await service.getMetrics('400092', NOW);
    expect(payload.metrics.conversionRate).toBeNull();
    expect(payload.metrics.averageOrderValue).toBe(100);
  });
});

describe('pincode with no data', () => {
  it('returns nulls, zeroed counters and an explanatory message', async () => {
    const service = new MetricsService(repositoryReturning({}), joinOrdersMapping);
    const result = await service.getMetrics('999999', NOW);
    expect(result.message).toBe('No data found for the requested pincode and period.');
    expect(result.payload.metrics).toEqual({ averageOrderValue: null, conversionRate: null });
    expect(result.payload.supporting).toEqual({
      totalOrders: 0,
      totalOrderValue: 0,
      totalLeads: 0,
      convertedLeads: 0,
      averageRowValue: null,
    });
    expect(result.payload.meta.hasData).toBe(false);
  });

  it('omits the message when data exists', async () => {
    const service = new MetricsService(repositoryReturning({ totalOrders: 1, totalOrderValue: 10 }), joinOrdersMapping);
    const result = await service.getMetrics('400092', NOW);
    expect(result.message).toBeUndefined();
    expect(result.payload.meta.hasData).toBe(true);
  });
});

describe('date-window orchestration', () => {
  it('passes the dynamically resolved six-month window to the repository', async () => {
    const repo = repositoryReturning({ totalOrders: 1, totalOrderValue: 1 });
    await new MetricsService(repo, joinOrdersMapping).getMetrics('400092', NOW);
    expect(repo.calls[0]![1]).toMatchObject({ from: '2026-03-01', to: '2026-08-31', months: 6 });
  });

  it('reports the period back to the caller', async () => {
    const { payload } = await new MetricsService(repositoryReturning({}), joinOrdersMapping).getMetrics('400092', NOW);
    expect(payload.period).toMatchObject({ from: '2026-03-01', to: '2026-08-31', months: 6, mode: 'calendar_months', timezone: 'Asia/Kolkata' });
  });
});

describe('self-documenting metric definitions', () => {
  it('describes the join-based conversion definition from the mapping', async () => {
    const { payload } = await new MetricsService(repositoryReturning({}), joinOrdersMapping).getMetrics('400092', NOW);
    expect(payload.definitions.averageOrderValue).toContain('SUM(grand_total) / COUNT(DISTINCT order_id)');
    expect(payload.definitions.averageOrderValue).toContain('status not in [cancelled, refunded]');
    expect(payload.definitions.conversionRate).toContain('shares its lead_phone');
    expect(payload.definitions.conversionRate).toContain('within the same period');
  });

  it('describes the status-based conversion definition from the mapping', async () => {
    const { payload } = await new MetricsService(repositoryReturning({}), statusFlagMapping).getMetrics('400092', NOW);
    expect(payload.definitions.averageOrderValue).toContain('status in [Delivered, Shipped]');
    expect(payload.definitions.conversionRate).toContain('stage is in [Order Placed, Won]');
  });
});

describe('response caching', () => {
  it('serves a second identical request from cache and marks it', async () => {
    const repo = repositoryReturning({ totalOrders: 2, totalOrderValue: 200 });
    const spy = vi.spyOn(repo, 'fetchMetrics');
    // Cache is disabled globally in tests, so enable it for this case only.
    const { MetricsService: Service } = await import('../src/services/metrics.service.js');
    const service = new Service(repo, joinOrdersMapping, new (class {
      private entry: any;
      get() { return this.entry; }
      set(_k: string, payload: any, message?: string) { this.entry = { payload, message, expiresAt: Infinity }; }
      clear() { this.entry = undefined; }
    })() as any);

    const first = await service.getMetrics('400092', NOW);
    const second = await service.getMetrics('400092', NOW);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.payload.meta.cached).toBe(false);
    expect(second.payload.meta.cached).toBe(true);
    expect(second.payload.metrics).toEqual(first.payload.metrics);
  });
});


describe('AOV method selection', () => {
  /**
   * On a line-item table these two readings differ materially — for pincode
   * 560076 they are 16,052 and 24,524 — so which one is the headline is a
   * business decision the mapping records explicitly.
   */
  const raw = { totalOrders: 100, totalOrderValue: 2_500_000, averageRowValue: 16_052.48 };

  it('total_over_orders divides value by distinct orders', async () => {
    const mapping = schemaMappingSchema.parse({
      ...joinOrdersMapping,
      orders: { ...joinOrdersMapping.orders, aovMethod: 'total_over_orders' },
    });
    const { payload } = await new MetricsService(repositoryReturning(raw), mapping).getMetrics('400092', NOW);
    expect(payload.metrics.averageOrderValue).toBe(25_000);
    expect(payload.definitions.averageOrderValue).toContain('COUNT(DISTINCT order_id)');
  });

  it('average_of_rows returns the per-row average and says it is per item', async () => {
    const mapping = schemaMappingSchema.parse({
      ...joinOrdersMapping,
      orders: { ...joinOrdersMapping.orders, aovMethod: 'average_of_rows' },
    });
    const { payload } = await new MetricsService(repositoryReturning(raw), mapping).getMetrics('400092', NOW);
    expect(payload.metrics.averageOrderValue).toBe(16_052.48);
    expect(payload.definitions.averageOrderValue).toContain('average ITEM value');
  });

  it('always reports both readings so the difference is visible', async () => {
    const { payload } = await new MetricsService(repositoryReturning(raw), joinOrdersMapping).getMetrics('400092', NOW);
    expect(payload.supporting.averageRowValue).toBe(16_052.48);
    expect(payload.supporting.totalOrderValue).toBe(2_500_000);
    expect(payload.supporting.totalOrders).toBe(100);
  });
});

describe('cache keying across window sources', () => {
  /**
   * Regression: the key was pincode+from+to, so an explicit range matching the
   * default window served the default's cached payload — reporting
   * `source: default` and a rollover date for what is actually a fixed range.
   */
  it('does not let an explicit range inherit the default range payload', async () => {
    const repo = repositoryReturning({ totalOrders: 10, totalOrderValue: 1000, totalLeads: 20, convertedLeads: 5 });
    const cache = new (class {
      private m = new Map<string, any>();
      get(k: string) { return this.m.get(k); }
      set(k: string, payload: any, message?: string) { this.m.set(k, { payload, message, storedAt: Date.now(), expiresAt: Infinity }); }
      clear() { this.m.clear(); }
    })();
    const service = new MetricsService(repo, joinOrdersMapping, cache as never);

    const dflt = await service.getMetrics('400092', NOW);
    const explicit = await service.getMetrics('400092', NOW, {
      from: dflt.payload.period.from,
      to: dflt.payload.period.to,
    });

    expect(dflt.payload.period.source).toBe('default');
    expect(explicit.payload.period.source).toBe('custom');
    expect(explicit.payload.period.nextRolloverOn).toBeUndefined();
    // Same window, so the numbers must agree even though metadata differs.
    expect(explicit.payload.supporting).toEqual(dflt.payload.supporting);
  });

  it('serves a repeat of the same explicit range from cache', async () => {
    const repo = repositoryReturning({ totalOrders: 3, totalOrderValue: 300 });
    const spy = vi.spyOn(repo, 'fetchMetrics');
    const cache = new (class {
      private m = new Map<string, any>();
      get(k: string) { return this.m.get(k); }
      set(k: string, payload: any) { this.m.set(k, { payload, storedAt: Date.now(), expiresAt: Infinity }); }
      clear() { this.m.clear(); }
    })();
    const service = new MetricsService(repo, joinOrdersMapping, cache as never);
    const range = { from: '2026-07-01', to: '2026-07-31' };
    await service.getMetrics('400092', NOW, range);
    const second = await service.getMetrics('400092', NOW, range);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.payload.meta.cached).toBe(true);
  });
});
