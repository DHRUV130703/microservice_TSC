import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * Store landmark details, generated from the store spreadsheet by
 * `scripts/import-store-landmarks.py`.
 *
 * The sheet is keyed by store name (`Koramangala_Bengaluru`) while the locator
 * API identifies stores by id (`TSC118`), and the two naming conventions do not
 * line up — matching the locator's own labels against the sheet reaches only
 * 66%. The import step resolves the id, so lookups here are by id first and fall
 * back to a normalised name for a store whose id has not been seen before.
 */
const landmarkSchema = z.object({
  storeId: z.string().nullable().optional(),
  storeName: z.string().nullable().optional(),
  businessAddress: z.string().nullable().optional(),
  landmarkDetail: z.string().nullable().optional(),
  mapUrl: z.string().nullable().optional(),
});

const fileSchema = z.object({
  meta: z
    .object({
      source: z.string().optional(),
      storeCount: z.number().optional(),
      resolvedToStoreId: z.number().optional(),
      note: z.string().optional(),
    })
    .default({}),
  stores: z.record(z.string(), landmarkSchema),
  /** Normalised store name -> key in `stores`. */
  byName: z.record(z.string(), z.string()).default({}),
});

export type StoreLandmark = z.infer<typeof landmarkSchema>;

/** Case, spaces, underscores and hyphens all differ between the two sources. */
export function normalizeStoreName(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface LandmarkTable {
  size: number;
  /** Resolves a landmark by store id, then by any of the supplied labels. */
  find(storeId: string | null | undefined, ...labels: Array<string | null | undefined>): StoreLandmark | undefined;
}

const EMPTY: LandmarkTable = { size: 0, find: () => undefined };

let cached: LandmarkTable | null = null;

function build(stores: Record<string, StoreLandmark>, byName: Record<string, string>): LandmarkTable {
  const byId = new Map(Object.entries(stores).map(([k, v]) => [k.toUpperCase(), v]));
  const names = new Map(Object.entries(byName).map(([k, v]) => [k, v]));

  return {
    size: byId.size,
    find(storeId, ...labels) {
      if (storeId) {
        const hit = byId.get(storeId.toUpperCase());
        if (hit) return hit;
      }
      for (const label of labels) {
        const key = normalizeStoreName(label);
        if (!key) continue;
        const target = names.get(key);
        if (target) {
          const hit = byId.get(target.toUpperCase()) ?? stores[target];
          if (hit) return hit;
        }
      }
      return undefined;
    },
  };
}

/**
 * Loads the landmark table once. A missing or unreadable file is NOT fatal:
 * metrics and the locator still work, results simply carry no landmark. Store
 * data must not be able to take the endpoint down.
 */
export function getStoreLandmarks(): LandmarkTable {
  if (cached) return cached;

  const configured = env.STORE_LANDMARKS_PATH;
  const candidates = path.isAbsolute(configured)
    ? [configured]
    : [
        path.resolve(process.cwd(), configured),
        path.resolve(process.cwd(), '..', configured),
        path.resolve('/var/task', configured),
      ];

  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

  if (!found) {
    logger.warn({ looked: candidates }, 'Store landmark file not found — results will omit landmarks');
    cached = EMPTY;
    return cached;
  }

  try {
    const parsed = fileSchema.parse(JSON.parse(fs.readFileSync(found, 'utf8')));
    cached = build(parsed.stores, parsed.byName);
    logger.info(
      { file: found, stores: cached.size, source: parsed.meta.source, resolvedToStoreId: parsed.meta.resolvedToStoreId },
      'Store landmarks loaded',
    );
  } catch (error) {
    logger.error(
      { err: { message: (error as Error).message }, file: found },
      'Store landmark file is unreadable — results will omit landmarks',
    );
    cached = EMPTY;
  }
  return cached;
}

/** Test hook. Accepts a plain id->landmark map for convenience. */
export function __setStoreLandmarks(next: LandmarkTable | Record<string, StoreLandmark> | null): void {
  if (next === null || (next as LandmarkTable).find !== undefined) {
    cached = next as LandmarkTable | null;
    return;
  }
  const stores = next as Record<string, StoreLandmark>;
  const byName = Object.fromEntries(
    Object.entries(stores)
      .filter(([, v]) => v.storeName)
      .map(([k, v]) => [normalizeStoreName(v.storeName), k]),
  );
  cached = build(stores, byName);
}

/** Builds a table directly from records — used by tests and by the service. */
export function landmarkTableFrom(stores: Record<string, StoreLandmark>): LandmarkTable {
  const byName = Object.fromEntries(
    Object.entries(stores)
      .filter(([, v]) => v.storeName)
      .map(([k, v]) => [normalizeStoreName(v.storeName), k]),
  );
  return build(stores, byName);
}
