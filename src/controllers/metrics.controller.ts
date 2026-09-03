import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service.js';
import { parseMetricsRequest } from '../utils/validation.js';
import type { SuccessEnvelope, MetricsPayload } from '../types/metrics.js';

export type MetricsServiceProvider = () => MetricsService;

/**
 * HTTP boundary only: validate input, delegate to the service, shape the
 * response. No SQL and no business rules live here.
 *
 * The service is resolved through a provider *after* validation, so a malformed
 * request is rejected with 400 even when the BigQuery configuration is broken.
 */
export class MetricsController {
  private readonly provider: MetricsServiceProvider;

  constructor(serviceOrProvider?: MetricsService | MetricsServiceProvider) {
    if (typeof serviceOrProvider === 'function') {
      this.provider = serviceOrProvider;
    } else if (serviceOrProvider) {
      this.provider = () => serviceOrProvider;
    } else {
      let cached: MetricsService | undefined;
      this.provider = () => (cached ??= new MetricsService());
    }
  }

  /** GET /api/v1/metrics?pincode=...&from=YYYY-MM-DD&to=YYYY-MM-DD */
  getMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(
      { pincode: req.query.pincode, from: req.query.from, to: req.query.to },
      res,
      next,
    );
  };

  /** POST /api/v1/metrics  { "pincode": "...", "from": "...", "to": "..." } */
  postMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = (req.body ?? {}) as { pincode?: unknown; from?: unknown; to?: unknown };
    await this.handle({ pincode: body.pincode, from: body.from, to: body.to }, res, next);
  };

  private async handle(
    raw: { pincode: unknown; from: unknown; to: unknown },
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Validation first: never let a configuration failure mask a bad request.
      // Blank query params are treated as absent so `?from=&to=` behaves as if
      // the caller had not asked for a range at all.
      const blankToUndefined = (v: unknown): unknown =>
        typeof v === 'string' && v.trim() === '' ? undefined : v;

      const { pincode, from, to } = parseMetricsRequest({
        pincode: raw.pincode,
        from: blankToUndefined(raw.from),
        to: blankToUndefined(raw.to),
      });

      const result = await this.provider().getMetrics(pincode, new Date(), { from, to });

      const body: SuccessEnvelope<MetricsPayload> = {
        success: true,
        data: result.payload,
        ...(result.message ? { message: result.message } : {}),
      };
      res.status(200).json(body);
    } catch (error) {
      next(error);
    }
  }
}
