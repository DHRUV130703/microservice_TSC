import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: typeof logger;
    }
  }
}

/** Attaches a correlation id and a child logger, then logs the completed request. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  req.log = logger.child({ requestId: req.requestId });
  res.setHeader('x-request-id', req.requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    req.log.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        // Query values are business identifiers (pincode), not secrets.
        pincode: typeof req.query.pincode === 'string' ? req.query.pincode : undefined,
      },
      'request completed',
    );
  });

  next();
}
