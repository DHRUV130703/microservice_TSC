import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Pincode-wise landmark details for physical stores, generated from the store
 * spreadsheet by `scripts/import-store-landmarks.py`.
 *
 * Keyed by upper-cased store id (`TSC118`), which is what the store-locator API
 * returns as `storeId` — so a locator result joins straight onto this.
 */
const landmarkSchema = z.object({
  storeId: z.string(),
  storeName: z.string().nullable().optional(),
  pincode: z.string().nullable().optional(),
  latitude: z.string().nullable().optional(),
  longitude: z.string().nullable().optional(),
  businessAddress: z.string().nullable().optional(),
  landmarkDetail: z.string().nullable().optional(),
  mapUrl: z.string().nullable().optional(),
});

const fileSchema = z.object({
  meta: z.object({ source: z.string().optional(), storeCount: z.number().optional(), note: z.string().optional() }).default({}),
  stores: z.record(z.string(), landmarkSchema),
});

export type StoreLandmark = z.infer<typeof landmarkSchema>;

let cached: Map<string, StoreLandmark> | null = null;

/**
 * Loads the landmark table once. A missing file is NOT fatal: store metrics and
 * the locator itself still work, results simply carry no landmark. That keeps a
 * spreadsheet problem from taking the endpoint down.
 */
export function getStoreLandmarks(): Map<string, StoreLandmark> {
  if (cached) return cached;

  const configured = env.STORE_LANDMARKS_PATH;
  const candidates = path.isAbsolute(configured)
    ? [configured]
    : [
        path.resolve(process.cwd(), configured),
        path.resolve(process.cwd(), '..', configured),
        path.resolve('/var/task', configured),
      ];

  const found = candidates.find((c) => {
    try {
      return fs.existsSync(c) && fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });

  if (!found) {
    logger.warn(
      { looked: candidates },
      'Store landmark file not found — locator results will omit landmark details',
    );
    cached = new Map();
    return cached;
  }

  try {
    const parsed = fileSchema.parse(JSON.parse(fs.readFileSync(found, 'utf8')));
    cached = new Map(Object.entries(parsed.stores).map(([id, s]) => [id.toUpperCase(), s]));
    logger.info({ file: found, stores: cached.size }, 'Store landmarks loaded');
  } catch (error) {
    logger.error(
      { err: { message: (error as Error).message }, file: found },
      'Store landmark file is unreadable — locator results will omit landmark details',
    );
    cached = new Map();
  }
  return cached;
}

/** Test hook. */
export function __setStoreLandmarks(next: Map<string, StoreLandmark> | null): void {
  cached = next;
}
