import { env } from '../config/env.js';
import { getStoreLandmarks, type StoreLandmark } from '../config/store-landmarks.js';
import {
  HttpStoreLocatorRepository,
  type LocatorStore,
  type StoreLocatorRepository,
} from '../repositories/store-locator.repository.js';
import { logger } from '../utils/logger.js';
import type { NearbyStore, StoresPayload, StoresResult } from '../types/stores.js';

const NO_STORES_MESSAGE = 'No stores found near the requested pincode.';

interface CacheEntry {
  payload: StoresPayload;
  message?: string;
  storedAt: number;
  expiresAt: number;
}

/** Store locations change rarely, so answers are held far longer than metrics. */
class StoreCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlSeconds: number, private readonly maxEntries = 2000) {}

  get(key: string): CacheEntry | undefined {
    if (this.ttlSeconds <= 0) return undefined;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, payload: StoresPayload, message?: string): void {
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

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export class StoresService {
  private readonly repository: StoreLocatorRepository;
  private readonly landmarks: Map<string, StoreLandmark>;
  private readonly cache: StoreCache;

  constructor(
    repository: StoreLocatorRepository = new HttpStoreLocatorRepository(),
    landmarks: Map<string, StoreLandmark> = getStoreLandmarks(),
    cache: StoreCache = new StoreCache(env.STORE_LOCATOR_CACHE_TTL_SECONDS),
  ) {
    this.repository = repository;
    this.landmarks = landmarks;
    this.cache = cache;
  }

  async getStores(pincode: string, limit?: number, now: Date = new Date()): Promise<StoresResult> {
    const take = Math.max(1, limit ?? env.STORE_LOCATOR_DEFAULT_LIMIT);
    const cacheKey = `${pincode}::${take}`;

    const hit = this.cache.get(cacheKey);
    if (hit) {
      return {
        payload: {
          ...hit.payload,
          meta: {
            ...hit.payload.meta,
            cached: true,
            ageSeconds: Math.round((Date.now() - hit.storedAt) / 1000),
          },
        },
        ...(hit.message ? { message: hit.message } : {}),
      };
    }

    const raw = await this.repository.findNearby(pincode);
    const stores = raw.slice(0, take).map((s) => this.enrich(s));
    const landmarksMatched = stores.filter((s) => s.landmark !== null).length;

    if (stores.length === 0) {
      logger.info({ pincode }, 'Store locator returned no stores for pincode');
    } else if (landmarksMatched < stores.length) {
      // Surfaced so a spreadsheet gap is visible rather than silently absent.
      logger.warn(
        { pincode, stores: stores.length, landmarksMatched, missing: stores.filter((s) => !s.landmark).map((s) => s.storeId) },
        'Some stores have no landmark entry in the spreadsheet',
      );
    }

    const payload: StoresPayload = {
      pincode,
      nearest: stores[0] ?? null,
      stores,
      meta: {
        storesReturned: stores.length,
        landmarksMatched,
        cached: false,
        fetchedAt: now.toISOString(),
        ageSeconds: 0,
      },
    };

    const message = stores.length === 0 ? NO_STORES_MESSAGE : undefined;
    this.cache.set(cacheKey, payload, message);
    return { payload, ...(message ? { message } : {}) };
  }

  /** Joins one locator result to its spreadsheet row on upper-cased store id. */
  private enrich(s: LocatorStore): NearbyStore {
    const storeId = str(s.storeId);
    const row = storeId ? this.landmarks.get(storeId.toUpperCase()) : undefined;

    return {
      storeId,
      storeName: str(s.storeName),
      shortCode: str(s.storeShortCode),
      city: str(s.city),
      pincode: str(s.pincode),
      distanceKm: typeof s.distance === 'number' ? s.distance : null,
      address: str(s.address),
      contact: str(s.contact),
      timings: str(s.storeTimings),
      rating: str(s.storeRating),
      reviewCount: str(s.reviewCount),
      parking: str(s.parking),
      mapLink: str(s.mapLink),
      storeUrl: str(s.storeUrl),
      latitude: str(s.latitude),
      longitude: str(s.longitude),
      comingSoon: Boolean(s.comingSoon),
      landmark: row
        ? {
            detail: str(row.landmarkDetail),
            businessAddress: str(row.businessAddress),
            mapUrl: str(row.mapUrl),
            storeName: str(row.storeName),
            pincode: str(row.pincode),
          }
        : null,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
