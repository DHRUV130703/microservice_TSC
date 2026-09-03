import type { NextFunction, Request, Response } from 'express';
import { StoresService } from '../services/stores.service.js';
import { parseStoresRequest } from '../utils/validation.js';
import type { StoresPayload } from '../types/stores.js';
import type { SuccessEnvelope } from '../types/metrics.js';

export type StoresServiceProvider = () => StoresService;

/**
 * HTTP boundary for store lookups. Validates, delegates, shapes the response.
 * The service is resolved after validation so a configuration failure cannot
 * mask a bad request — same ordering as the metrics controller.
 */
export class StoresController {
  private readonly provider: StoresServiceProvider;

  constructor(serviceOrProvider?: StoresService | StoresServiceProvider) {
    if (typeof serviceOrProvider === 'function') {
      this.provider = serviceOrProvider;
    } else if (serviceOrProvider) {
      this.provider = () => serviceOrProvider;
    } else {
      let cache: StoresService | undefined;
      this.provider = () => (cache ??= new StoresService());
    }
  }

  /** GET /api/v1/stores?pincode=...&limit=3 */
  getStores = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle({ pincode: req.query.pincode, limit: req.query.limit }, res, next);
  };

  /** POST /api/v1/stores  { "pincode": "...", "limit": 3 } */
  postStores = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = (req.body ?? {}) as { pincode?: unknown; limit?: unknown };
    await this.handle({ pincode: body.pincode, limit: body.limit }, res, next);
  };

  private async handle(
    raw: { pincode: unknown; limit: unknown },
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const blank = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
      const { pincode, limit } = parseStoresRequest({ pincode: raw.pincode, limit: blank(raw.limit) });

      const result = await this.provider().getStores(pincode, limit);

      const body: SuccessEnvelope<StoresPayload> = {
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
