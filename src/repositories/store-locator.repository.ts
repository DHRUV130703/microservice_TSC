import { env } from '../config/env.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** One store as returned by the upstream locator. Only fields we use are typed. */
export interface LocatorStore {
  storeId?: string;
  storeName?: string;
  storeShortCode?: string;
  city?: string;
  pincode?: string;
  address?: string;
  contact?: string;
  storeTimings?: string;
  storeRating?: string;
  reviewCount?: string;
  parking?: string;
  mapLink?: string;
  storeUrl?: string;
  latitude?: string;
  longitude?: string;
  distance?: number;
  comingSoon?: boolean;
}

export interface StoreLocatorRepository {
  findNearby(pincode: string): Promise<LocatorStore[]>;
}

export class HttpStoreLocatorRepository implements StoreLocatorRepository {
  /**
   * Resolves a pincode to nearby stores via the upstream locator.
   *
   * The upstream returns `stores` already sorted by ascending `distance`; we
   * preserve that order rather than re-sorting, so "nearest" means what the
   * upstream says it means.
   */
  async findNearby(pincode: string): Promise<LocatorStore[]> {
    if (!env.STORE_LOCATOR_API_KEY) {
      throw AppError.configuration(
        'The store locator is not configured. Set STORE_LOCATOR_API_KEY to enable store lookups.',
      );
    }

    const url = `${env.STORE_LOCATOR_URL}?pincode=${encodeURIComponent(pincode)}`;
    const startedAt = Date.now();

    // AbortSignal.timeout would do, but an explicit controller lets the timeout
    // be reported distinctly from an upstream error.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.STORE_LOCATOR_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'x-api-key': env.STORE_LOCATOR_API_KEY,
        },
      });
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      logger.error(
        { err: { message: (error as Error).message }, durationMs: Date.now() - startedAt, aborted },
        'Store locator request failed',
      );
      throw aborted
        ? AppError.upstreamTimeout('The store locator did not respond in time.')
        : AppError.upstream('The store locator is currently unavailable.');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      logger.error({ status: res.status, durationMs: Date.now() - startedAt }, 'Store locator returned an error');
      // 401/403 means our key is wrong — an operator problem, not a caller one.
      if (res.status === 401 || res.status === 403) {
        throw AppError.configuration('The store locator rejected our API key.');
      }
      throw new AppError(502, ErrorCode.UPSTREAM_ERROR, 'The store locator returned an unexpected response.');
    }

    let body: { success?: boolean; stores?: LocatorStore[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw AppError.upstream('The store locator returned a malformed response.');
    }

    const stores = Array.isArray(body.stores) ? body.stores : [];
    logger.info(
      { pincode, durationMs: Date.now() - startedAt, stores: stores.length },
      'Store locator responded',
    );
    return stores;
  }
}
