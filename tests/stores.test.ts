import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/create-app.js';
import { StoresController } from '../src/controllers/stores.controller.js';
import { StoresService } from '../src/services/stores.service.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';
import type { LocatorStore, StoreLocatorRepository } from '../src/repositories/store-locator.repository.js';
import type { StoreLandmark } from '../src/config/store-landmarks.js';

/** Two stores as the upstream returns them: sorted nearest-first. */
const upstream: LocatorStore[] = [
  {
    storeId: 'TSC118', storeName: 'The Sleep Company Experience Store - Malad',
    storeShortCode: 'Malad West', city: 'Mumbai', pincode: '400064', distance: 2.4,
    address: '269-A/3, First Floor, Solitaire II, Malad West', contact: '9811981911',
    storeTimings: '11AM to 9:30PM, Mon - Sun', storeRating: '4.9', reviewCount: '539',
    parking: 'Valet Parking', mapLink: 'https://maps.app.goo.gl/x', latitude: '19.18', longitude: '72.83',
    comingSoon: false,
  },
  {
    storeId: 'TSC231', storeShortCode: 'Applaud 38 Goregaon', city: 'Mumbai',
    pincode: '400063', distance: 2.6, comingSoon: false,
  },
];

const landmarks = new Map<string, StoreLandmark>([
  ['TSC118', {
    storeId: 'TSC118', storeName: 'Malad_Mumbai', pincode: '400064',
    latitude: '19.18409', longitude: '72.83609',
    businessAddress: '269-A/3, First Floor, Solitaire II, Opposite Infinity Mall',
    landmarkDetail: 'Opposite Infinity Mall, Malad West — 1st floor. PIN 400064.',
    mapUrl: 'https://maps.google.com/maps?cid=17318950302109061910',
  }],
  // TSC231 deliberately absent, to prove a spreadsheet gap degrades gracefully.
]);

const repo = (stores: LocatorStore[] = upstream): StoreLocatorRepository => ({
  async findNearby() { return stores; },
});

const failing = (error: Error): StoreLocatorRepository => ({
  async findNearby() { throw error; },
});

function appWith(r: StoreLocatorRepository, l = landmarks) {
  // TTL 0 keeps each test independent of the others' caching.
  const cache = new (class {
    get() { return undefined; }
    set() {}
    clear() {}
  })();
  return createApp({ storesController: new StoresController(new StoresService(r, l, cache as never)) });
}

describe('GET /api/v1/stores', () => {
  it('returns the nearest store with its landmark detail joined on store id', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pincode).toBe('400090');
    expect(res.body.data.nearest).toMatchObject({
      storeId: 'TSC118', shortCode: 'Malad West', city: 'Mumbai', distanceKm: 2.4,
    });
    expect(res.body.data.nearest.landmark).toMatchObject({
      detail: 'Opposite Infinity Mall, Malad West — 1st floor. PIN 400064.',
      mapUrl: 'https://maps.google.com/maps?cid=17318950302109061910',
      storeName: 'Malad_Mumbai',
    });
  });

  it('preserves the upstream ordering rather than re-sorting', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090&limit=2');
    expect(res.body.data.stores.map((s: { storeId: string }) => s.storeId)).toEqual(['TSC118', 'TSC231']);
    expect(res.body.data.nearest.storeId).toBe('TSC118');
  });

  it('still reports a store the spreadsheet does not cover, with landmark null', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090&limit=2');
    const second = res.body.data.stores[1];
    expect(second.storeId).toBe('TSC231');
    expect(second.landmark).toBeNull();
    expect(res.body.data.meta).toMatchObject({ storesReturned: 2, landmarksMatched: 1 });
  });

  it('honours limit and caps how many are returned', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090&limit=1');
    expect(res.body.data.stores).toHaveLength(1);
    expect(res.body.data.meta.storesReturned).toBe(1);
  });

  it('rejects a limit above the cap', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090&limit=99');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('treats a blank limit as absent', async () => {
    const res = await request(appWith(repo())).get('/api/v1/stores?pincode=400090&limit=');
    expect(res.status).toBe(200);
  });

  it('reports no stores as a success with a message, not an error', async () => {
    const res = await request(appWith(repo([]))).get('/api/v1/stores?pincode=999999');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.nearest).toBeNull();
    expect(res.body.data.stores).toEqual([]);
    expect(res.body.message).toMatch(/No stores found/);
  });

  it('validates the pincode the same way the metrics endpoint does', async () => {
    for (const bad of ['', 'ab', "400092'; DROP TABLE x;--"]) {
      const res = await request(appWith(repo())).get('/api/v1/stores').query({ pincode: bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.INVALID_PINCODE);
    }
  });

  it('accepts a POST body', async () => {
    const res = await request(appWith(repo())).post('/api/v1/stores').send({ pincode: '400090', limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.nearest.storeId).toBe('TSC118');
  });
});

describe('store locator failures', () => {
  it('maps an upstream outage to 502 without leaking internals', async () => {
    const res = await request(appWith(failing(AppError.upstream('The store locator is currently unavailable.'))))
      .get('/api/v1/stores?pincode=400090');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/x-api-key|thesleepcompany\.in/);
  });

  it('maps a timeout to 504', async () => {
    const res = await request(appWith(failing(AppError.upstreamTimeout()))).get('/api/v1/stores?pincode=400090');
    expect(res.status).toBe(504);
  });

  it('maps a missing API key to a configuration error', async () => {
    const res = await request(appWith(failing(AppError.configuration('The store locator is not configured.'))))
      .get('/api/v1/stores?pincode=400090');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCode.CONFIGURATION_ERROR);
  });

  it('never echoes the API key in any response', async () => {
    const leaky = new Error('request failed with x-api-key: SUPERSECRETKEY');
    const res = await request(appWith(failing(leaky))).get('/api/v1/stores?pincode=400090');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('SUPERSECRETKEY');
  });
});

describe('store lookups are cached', () => {
  it('reuses a result for the same pincode and limit', async () => {
    const r = repo();
    const spy = vi.spyOn(r, 'findNearby');
    const service = new StoresService(r, landmarks);
    await service.getStores('400090', 2);
    const second = await service.getStores('400090', 2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.payload.meta.cached).toBe(true);
  });

  it('does not let one limit serve another', async () => {
    const r = repo();
    const spy = vi.spyOn(r, 'findNearby');
    const service = new StoresService(r, landmarks);
    await service.getStores('400090', 1);
    await service.getStores('400090', 2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
