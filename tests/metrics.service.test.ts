import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../src/services/metrics.service.js';
import type { MetricsRepository, MetricsQueryResult } from '../src/repositories/bigquery.repository.js';
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
    expect(result.payload.supporting).toEqual({ totalOrders: 0, totalOrderValue: 0, totalLeads: 0, convertedLeads: 0 });
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
