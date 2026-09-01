import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MetricsController } from '../src/controllers/metrics.controller.js';
import { MetricsService } from '../src/services/metrics.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import type { MetricsRepository, MetricsQueryResult } from '../src/repositories/bigquery.repository.js';
import { joinOrdersMapping } from './fixtures/mapping.js';

function appWith(repo: MetricsRepository) {
  return createApp({ metricsController: new MetricsController(new MetricsService(repo, joinOrdersMapping)) });
}

const healthyRepo: MetricsRepository = {
  async fetchMetrics(): Promise<MetricsQueryResult> {
    return { totalOrders: 125, totalOrderValue: 2_312_500, totalLeads: 1004, convertedLeads: 125, bytesProcessed: 4096 };
  },
};

const emptyRepo: MetricsRepository = {
  async fetchMetrics(): Promise<MetricsQueryResult> {
    return { totalOrders: 0, totalOrderValue: 0, totalLeads: 0, convertedLeads: 0 };
  },
};

describe('GET /api/v1/metrics — valid pincode', () => {
  it('returns 200 with the documented response structure', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=400092');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pincode).toBe('400092');
    expect(res.body.data.period).toEqual(
      expect.objectContaining({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), months: 6 }),
    );
    expect(res.body.data.metrics).toEqual({ averageOrderValue: 18_500, conversionRate: 12.45 });
    expect(res.body.data.supporting).toEqual({ totalOrders: 125, totalOrderValue: 2_312_500, totalLeads: 1004, convertedLeads: 125 });
    expect(res.body.data.definitions.averageOrderValue).toBeTypeOf('string');
    expect(res.body.data.definitions.conversionRate).toBeTypeOf('string');
    expect(res.body.data.meta).toEqual(expect.objectContaining({ hasData: true, cached: false }));
    expect(res.body.message).toBeUndefined();
  });

  it('trims surrounding whitespace', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=%20400092%20');
    expect(res.status).toBe(200);
    expect(res.body.data.pincode).toBe('400092');
  });

  it('echoes a correlation id on every response', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=400092').set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('POST /api/v1/metrics', () => {
  it('accepts the pincode in a JSON body', async () => {
    const res = await request(appWith(healthyRepo)).post('/api/v1/metrics').send({ pincode: '400092' });
    expect(res.status).toBe(200);
    expect(res.body.data.metrics.averageOrderValue).toBe(18_500);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await request(appWith(healthyRepo))
      .post('/api/v1/metrics')
      .set('Content-Type', 'application/json')
      .send('{"pincode":');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('missing pincode', () => {
  it('returns 400 INVALID_PINCODE for GET without the parameter', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: ErrorCode.INVALID_PINCODE, message: 'Pincode is required.' } });
  });

  it('returns 400 for an empty pincode', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
  });

  it('returns 400 for POST with no body', async () => {
    const res = await request(appWith(healthyRepo)).post('/api/v1/metrics').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
  });
});

describe('invalid pincode', () => {
  it.each([
    ['contains SQL punctuation', "400092'; DROP TABLE orders; --"],
    ['too short', 'ab'],
    ['too long', '1234567890123456'],
    ['contains an underscore', '4000_92'],
    ['contains a slash', '400/092'],
  ])('returns 400 when the pincode %s', async (_label, pincode) => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics').query({ pincode });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
    expect(res.body.error.message).toMatch(/invalid characters|unsupported length/);
  });

  it('rejects a non-string pincode', async () => {
    const res = await request(appWith(healthyRepo)).post('/api/v1/metrics').send({ pincode: 400092 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Pincode must be a string.');
  });

  it('accepts a valid alphanumeric postcode, not just six Indian digits', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=SW1A%201AA');
    expect(res.status).toBe(200);
    expect(res.body.data.pincode).toBe('SW1A 1AA');
  });
});

describe('pincode with no data', () => {
  it('returns 200 with null metrics and a message', async () => {
    const res = await request(appWith(emptyRepo)).get('/api/v1/metrics?pincode=999999');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.metrics).toEqual({ averageOrderValue: null, conversionRate: null });
    expect(res.body.message).toBe('No data found for the requested pincode and period.');
    expect(res.body.data.meta.hasData).toBe(false);
  });
});

describe('BigQuery errors', () => {
  const failing = (error: Error): MetricsRepository => ({
    async fetchMetrics(): Promise<MetricsQueryResult> {
      throw error;
    },
  });

  it('maps an upstream failure to 502 without leaking internals', async () => {
    const res = await request(appWith(failing(AppError.upstream()))).get('/api/v1/metrics?pincode=400092');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe(ErrorCode.UPSTREAM_ERROR);
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|fact_orders|test-project/);
  });

  it('maps a query timeout to 504', async () => {
    const res = await request(appWith(failing(AppError.upstreamTimeout()))).get('/api/v1/metrics?pincode=400092');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe(ErrorCode.UPSTREAM_TIMEOUT);
  });

  it('maps a configuration problem to 500 CONFIGURATION_ERROR', async () => {
    const res = await request(appWith(failing(AppError.configuration('tables missing')))).get('/api/v1/metrics?pincode=400092');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCode.CONFIGURATION_ERROR);
  });

  it('never exposes an unexpected error message, SQL or credentials', async () => {
    const leaky = new Error(
      'Query failed: SELECT * FROM `secret-project.finance.fact_orders`; key=-----BEGIN PRIVATE KEY-----',
    );
    const res = await request(appWith(failing(leaky))).get('/api/v1/metrics?pincode=400092');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.' });
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY|secret-project|SELECT/);
  });
});

describe('health and routing', () => {
  it('serves liveness without touching BigQuery', async () => {
    const res = await request(appWith(healthyRepo)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('returns 404 in the standard error envelope for unknown routes', async () => {
    const res = await request(appWith(healthyRepo)).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: ErrorCode.NOT_FOUND } });
  });

  it('answers CORS preflight', async () => {
    const res = await request(appWith(healthyRepo)).options('/api/v1/metrics');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('does not advertise the server framework', async () => {
    const res = await request(appWith(healthyRepo)).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('validation precedence over configuration failures', () => {
  /**
   * Regression: the route used to construct the metrics service (which loads the
   * schema mapping) *before* validating input, so a malformed pincode returned
   * 500 CONFIGURATION_ERROR instead of 400 INVALID_PINCODE.
   */
  const brokenConfigApp = () =>
    createApp({
      metricsController: new MetricsController(() => {
        throw new (class extends Error {})('schema mapping missing');
      }),
    });

  it('rejects a malformed pincode with 400 even when the backend is misconfigured', async () => {
    const res = await request(brokenConfigApp()).get('/api/v1/metrics').query({ pincode: "400092'; DROP TABLE orders;--" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
  });

  it('rejects a missing pincode with 400 even when the backend is misconfigured', async () => {
    const res = await request(brokenConfigApp()).get('/api/v1/metrics');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
  });

  it('still reports 500 for a valid pincode when the backend is misconfigured', async () => {
    const res = await request(brokenConfigApp()).get('/api/v1/metrics?pincode=400092');
    expect(res.status).toBe(500);
  });
});

describe('static frontend', () => {
  it('serves the UI at /', async () => {
    const res = await request(appWith(healthyRepo)).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Pincode Metrics');
    expect(res.text).toContain('/api/v1/metrics');
  });

  it('does not shadow the API or health routes', async () => {
    expect((await request(appWith(healthyRepo)).get('/api/v1/metrics?pincode=400092')).status).toBe(200);
    expect((await request(appWith(healthyRepo)).get('/health')).status).toBe(200);
  });

  it('still 404s unknown paths in the JSON envelope', async () => {
    const res = await request(appWith(healthyRepo)).get('/definitely-not-a-page');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('marks the shell as no-cache so a stale page never masks new data', async () => {
    const res = await request(appWith(healthyRepo)).get('/');
    expect(res.headers['cache-control']).toContain('no-cache');
  });
});

describe('readiness reports what is actually deployed', () => {
  it('exposes the running commit and the settings that commonly go wrong', async () => {
    const res = await request(appWith(healthyRepo)).get('/health/ready');
    expect(res.status).toBe(200);
    const d = res.body.data.deployment;
    expect(d).toBeDefined();
    expect(d.bigQueryLocation).toBeTypeOf('string');
    expect(d.periodAnchor).toBeTypeOf('string');
    expect(d.commit).toBeTypeOf('string');
    expect(d.credentialSource).toBeTypeOf('string');
  });

  it('never leaks credentials or table names in the diagnostic', async () => {
    const res = await request(appWith(healthyRepo)).get('/health/ready');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/PRIVATE KEY|private_key|fact_orders|oms_sales|lead_base/);
  });
});
