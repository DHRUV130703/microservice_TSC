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

  /** GET /api/v1/metrics?pincode=... */
  getMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req.query.pincode, res, next);
  };

  /** POST /api/v1/metrics  { "pincode": "..." } */
  postMetrics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle((req.body as { pincode?: unknown })?.pincode, res, next);
  };

  private async handle(rawPincode: unknown, res: Response, next: NextFunction): Promise<void> {
    try {
      // Validation first: never let a configuration failure mask a bad request.
      const { pincode } = parseMetricsRequest({ pincode: rawPincode });

      const result = await this.provider().getMetrics(pincode);

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
