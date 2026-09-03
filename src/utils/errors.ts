/** Machine-readable error codes returned to clients. */
export const ErrorCode = {
  INVALID_PINCODE: 'INVALID_PINCODE',
  INVALID_DATE_RANGE: 'INVALID_DATE_RANGE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * An error whose message is safe to return to the caller.
 * Anything that is not an AppError is reported as a generic INTERNAL_ERROR so
 * SQL text, table names and infrastructure details never leak.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly expose = true;

  constructor(statusCode: number, code: ErrorCodeValue, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(code: ErrorCodeValue, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }

  static notFound(message: string): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message);
  }

  static configuration(message: string): AppError {
    return new AppError(500, ErrorCode.CONFIGURATION_ERROR, message);
  }

  static upstream(message = 'The analytics backend is currently unavailable.'): AppError {
    return new AppError(502, ErrorCode.UPSTREAM_ERROR, message);
  }

  static upstreamTimeout(message = 'The analytics query timed out. Please retry.'): AppError {
    return new AppError(504, ErrorCode.UPSTREAM_TIMEOUT, message);
  }
}
