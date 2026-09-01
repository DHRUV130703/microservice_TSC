import { describe, expect, it, vi } from 'vitest';
import type { BigQuery } from '@google-cloud/bigquery';
import { BigQueryMetricsRepository } from '../src/repositories/bigquery.repository.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import { resolveDateWindow } from '../src/utils/date.js';
import { joinOrdersMapping } from './fixtures/mapping.js';

const window = resolveDateWindow(new Date('2026-08-31T06:30:00.000Z'), 6, 'calendar_months', 'Asia/Kolkata');

/** Minimal BigQuery double: captures the job request, returns canned rows. */
function fakeClient(rows: Array<Record<string, unknown>>, metadata: Record<string, unknown> = {}) {
  const createQueryJob = vi.fn(async (options: Record<string, unknown>) => [
    {
      getQueryResults: async () => [rows],
      getMetadata: async () => [
        { statistics: { query: { totalBytesProcessed: '8192', cacheHit: false } }, jobReference: { jobId: 'job-1' }, ...metadata },
      ],
    },
    options,
  ]);
  return { client: { createQueryJob } as unknown as BigQuery, createQueryJob };
}

function throwingClient(error: unknown) {
  return {
    createQueryJob: vi.fn(async () => {
      throw error;
    }),
  } as unknown as BigQuery;
}

describe('BigQueryMetricsRepository — request shape', () => {
  it('sends a parameterized query with a cost ceiling and standard SQL', async () => {
    const { client, createQueryJob } = fakeClient([
      { totalOrders: 10, totalOrderValue: 1000, totalLeads: 50, convertedLeads: 10 },
    ]);
    await new BigQueryMetricsRepository(client, joinOrdersMapping).fetchMetrics('400092', window);

    const options = createQueryJob.mock.calls[0]![0] as Record<string, any>;
    expect(options.useLegacySql).toBe(false);
    expect(options.maximumBytesBilled).toBeTypeOf('string');
    expect(options.params.ordersPincode).toBe('400092');
    expect(options.params.from.value).toBe('2026-03-01');
    expect(options.types.from).toBe('DATE');
    expect(options.query).not.toContain('400092');
  });

  it('issues exactly one BigQuery job per request', async () => {
    const { client, createQueryJob } = fakeClient([{ totalOrders: 1, totalOrderValue: 1, totalLeads: 1, convertedLeads: 1 }]);
    await new BigQueryMetricsRepository(client, joinOrdersMapping).fetchMetrics('400092', window);
    expect(createQueryJob).toHaveBeenCalledTimes(1);
  });
});

describe('BigQueryMetricsRepository — result coercion', () => {
  it('coerces BigQuery numeric wrappers and strings to numbers', async () => {
    const { client } = fakeClient([
      {
        totalOrders: '125',
        totalOrderValue: { toString: () => '2312500.5' },
        totalLeads: 1004n,
        convertedLeads: 125,
      },
    ]);
    const result = await new BigQueryMetricsRepository(client, joinOrdersMapping).fetchMetrics('400092', window);
    expect(result).toMatchObject({ totalOrders: 125, totalOrderValue: 2_312_500.5, totalLeads: 1004, convertedLeads: 125 });
    expect(result.bytesProcessed).toBe(8192);
  });

  it('treats an empty result set and NULL aggregates as zeroes', async () => {
    const { client } = fakeClient([]);
    const result = await new BigQueryMetricsRepository(client, joinOrdersMapping).fetchMetrics('999999', window);
    expect(result).toMatchObject({ totalOrders: 0, totalOrderValue: 0, totalLeads: 0, convertedLeads: 0 });

    const { client: nullClient } = fakeClient([
      { totalOrders: 0, totalOrderValue: null, totalLeads: null, convertedLeads: null },
    ]);
    const nulls = await new BigQueryMetricsRepository(nullClient, joinOrdersMapping).fetchMetrics('999999', window);
    expect(nulls).toMatchObject({ totalOrderValue: 0, totalLeads: 0 });
  });
});

describe('BigQueryMetricsRepository — error translation', () => {
  const run = (error: unknown) =>
    new BigQueryMetricsRepository(throwingClient(error), joinOrdersMapping).fetchMetrics('400092', window);

  it('maps a missing table to CONFIGURATION_ERROR', async () => {
    await expect(run(Object.assign(new Error('Not found: Table x'), { errors: [{ reason: 'notFound' }] }))).rejects.toMatchObject({
      statusCode: 500,
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  });

  it('maps access denied to CONFIGURATION_ERROR', async () => {
    await expect(run(Object.assign(new Error('permission denied'), { code: 403 }))).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  });

  it('maps an invalid generated query to CONFIGURATION_ERROR', async () => {
    await expect(run(new Error('Unrecognized name: shipping_pincod at [4:5]'))).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  });

  it('maps a timeout to UPSTREAM_TIMEOUT (504)', async () => {
    await expect(run(new Error('Operation timeout exceeded'))).rejects.toMatchObject({
      statusCode: 504,
      code: ErrorCode.UPSTREAM_TIMEOUT,
    });
  });

  it('maps a bytes-billed breach to CONFIGURATION_ERROR', async () => {
    await expect(run(new Error('Query exceeded limit for bytes billed'))).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  });

  it('maps missing credentials to CONFIGURATION_ERROR', async () => {
    await expect(run(new Error('Could not load the default credentials'))).rejects.toMatchObject({
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  });

  it('maps anything else to a generic UPSTREAM_ERROR (502)', async () => {
    await expect(run(new Error('socket hang up'))).rejects.toMatchObject({ statusCode: 502, code: ErrorCode.UPSTREAM_ERROR });
  });

  it('never surfaces the raw BigQuery message to the caller', async () => {
    const leaky = new Error('Syntax error near `secret-project.finance.fact_orders`');
    // A syntax error is a configuration problem, but the message must be ours.
    await expect(run(leaky)).rejects.toSatisfy((error: AppError) => {
      expect(error.message).not.toContain('secret-project');
      expect(error.message).not.toContain('fact_orders');
      return true;
    });
  });
});
