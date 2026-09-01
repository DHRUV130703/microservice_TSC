import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../utils/errors.js';
import { SchemaMappingError } from '../config/schema.mapping.js';
import { logger } from '../utils/logger.js';
import type { ErrorEnvelope } from '../types/metrics.js';

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorEnvelope = {
    success: false,
    error: { code: ErrorCode.NOT_FOUND, message: `Route ${req.method} ${req.path} does not exist.` },
    requestId: req.requestId,
  };
  res.status(404).json(body);
}

/**
 * Single error boundary. Only AppError messages reach the client; everything
 * else is logged in full and reported as a generic internal error so SQL,
 * table names, stack traces and credentials never leave the process.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const log = req.log ?? logger;

  let appError: AppError;
  if (error instanceof AppError) {
    appError = error;
  } else if (error instanceof SchemaMappingError) {
    // The mapping message is operator-facing configuration guidance, not a secret.
    appError = AppError.configuration(
      'The analytics schema mapping is missing or invalid. The service cannot compute metrics until it is configured.',
    );
    log.error({ err: { message: error.message } }, 'Schema mapping error');
  } else if (isBodyParseError(error)) {
    appError = AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Request body is not valid JSON.');
  } else {
    appError = new AppError(500, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.');
    log.error({ err: error }, 'Unhandled error');
  }

  if (appError.statusCode >= 500 && !(error instanceof AppError)) {
    // already logged above
  } else if (appError.statusCode >= 500) {
    log.error({ code: appError.code, message: appError.message }, 'Request failed');
  } else {
    log.warn({ code: appError.code, message: appError.message }, 'Request rejected');
  }

  const body: ErrorEnvelope = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
    requestId: req.requestId,
  };
  res.status(appError.statusCode).json(body);
}

function isBodyParseError(error: unknown): boolean {
  const e = error as { type?: string; status?: number };
  return e?.type === 'entity.parse.failed' || (e?.status === 400 && e?.type !== undefined);
}
