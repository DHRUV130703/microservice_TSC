import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service.js';
import { StoresService } from '../services/stores.service.js';
import { parseMetricsRequest } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import type { SuccessEnvelope, MetricsPayload } from '../types/metrics.js';

export type MetricsServiceProvider = () => MetricsService;
export type StoresServiceProvider = () => StoresService;

/**
 * HTTP boundary only: validate input, delegate to the service, shape the
 * response. No SQL and no business rules live here.
 *
 * The service is resolved through a provider *after* validation, so a malformed
 * request is rejected with 400 even when the BigQuery configuration is broken.
 */
export class MetricsController {
  private readonly provider: MetricsServiceProvider;
  private readonly storesProvider: StoresServiceProvider;

  constructor(
    serviceOrProvider?: MetricsService | MetricsServiceProvider,
    storesOrProvider?: StoresService | StoresServiceProvider,
  ) {
    if (typeof serviceOrProvider === 'function') {
      this.provider = serviceOrProvider;
    } else if (serviceOrProvider) {
      this.provider = () => serviceOrProvider;
    } else {
      let cached: MetricsService | undefined;
      this.provider = () => (cached ??= new MetricsService());
    }

    if (typeof storesOrProvider === 'function') {
      this.storesProvider = storesOrProvider;
    } else if (storesOrProvider) {
      this.storesProvider = () => storesOrProvider;
    } else {
      let cachedStores: StoresService | undefined;
      this.storesProvider = () => (cachedStores ??= new StoresService());
    }
  }

  /** GET /api/v1/metrics?pincode=...&from=YYYY-MM-DD&to=YYYY-MM-DD */
  getMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(
      { pincode: req.query.pincode, from: req.query.from, to: req.query.to, stores: req.query.stores },
      res,
      next,
    );
  };

  /** POST /api/v1/metrics  { "pincode": "...", "from": "...", "to": "..." } */
  postMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = (req.body ?? {}) as { pincode?: unknown; from?: unknown; to?: unknown; stores?: unknown };
    await this.handle({ pincode: body.pincode, from: body.from, to: body.to, stores: body.stores }, res, next);
  };

  private async handle(
    raw: { pincode: unknown; from: unknown; to: unknown; stores: unknown },
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Validation first: never let a configuration failure mask a bad request.
      // Blank query params are treated as absent so `?from=&to=` behaves as if
      // the caller had not asked for a range at all.
      const blankToUndefined = (v: unknown): unknown =>
        typeof v === 'string' && v.trim() === '' ? undefined : v;

      const { pincode, from, to, stores } = parseMetricsRequest({
        pincode: raw.pincode,
        from: blankToUndefined(raw.from),
        to: blankToUndefined(raw.to),
        stores: blankToUndefined(raw.stores),
      });

      const wantStores = stores !== false;

      // Run both upstreams concurrently: the store lookup then costs no extra
      // latency. allSettled, not all, because a locator failure must not deny
      // the caller their metrics — those are the primary answer.
      const [metricsOutcome, storesOutcome] = await Promise.allSettled([
        this.provider().getMetrics(pincode, new Date(), { from, to }),
        wantStores ? this.storesProvider().getStores(pincode, 1) : Promise.resolve(null),
      ]);

      if (metricsOutcome.status === 'rejected') throw metricsOutcome.reason;
      const result = metricsOutcome.value;

      let nearestStore = null;
      let storeLookup: 'ok' | 'unavailable' | 'skipped' = wantStores ? 'ok' : 'skipped';
      if (wantStores) {
        if (storesOutcome.status === 'fulfilled') {
          nearestStore = storesOutcome.value?.payload.nearest ?? null;
        } else {
          storeLookup = 'unavailable';
          logger.warn(
            { pincode, err: { message: (storesOutcome.reason as Error)?.message } },
            'Store lookup failed; returning metrics without a nearest store',
          );
        }
      }

      const body: SuccessEnvelope<MetricsPayload> = {
        success: true,
        data: {
          ...result.payload,
          nearestStore,
          meta: { ...result.payload.meta, storeLookup },
        },
        ...(result.message ? { message: result.message } : {}),
      };
      res.status(200).json(body);
    } catch (error) {
      next(error);
    }
  }
}
