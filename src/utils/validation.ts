import { z } from 'zod';
import { env } from '../config/env.js';
import { daysBetween, isValidIsoDate } from './date.js';
import { AppError, ErrorCode } from './errors.js';

/**
 * Pincode validation.
 *
 * Deliberately NOT locked to six Indian digits: the pattern is configurable via
 * PINCODE_PATTERN so alphanumeric postcodes remain supported. The default
 * accepts 3-12 alphanumeric characters plus spaces and hyphens.
 */
const pincodePattern = new RegExp(env.PINCODE_PATTERN);

export const pincodeSchema = z
  .string({ required_error: 'Pincode is required.', invalid_type_error: 'Pincode must be a string.' })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: 'Pincode is required.' })
  .refine((value) => pincodePattern.test(value), {
    message: 'Pincode contains invalid characters or has an unsupported length.',
  });

/**
 * Optional custom range. Both bounds are inclusive plain dates, interpreted in
 * METRICS_TIMEZONE exactly as the default window is, so a custom range and the
 * default range are measured identically.
 */
const isoDateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => isValidIsoDate(value), {
    message: 'Date must be a real calendar date in YYYY-MM-DD form.',
  });

export const metricsRequestSchema = z.object({
  pincode: pincodeSchema,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /**
   * Set false to skip the nearest-store lookup. Defaults to true; the lookup
   * runs in parallel with the metrics query, so it costs no extra latency, but
   * a caller that does not need it can avoid the upstream call entirely.
   */
  stores: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'))
    .optional(),
});

export type MetricsRequest = z.infer<typeof metricsRequestSchema>;

/** Parses request input, converting Zod failures into a client-safe AppError. */
export function parseMetricsRequest(input: unknown): MetricsRequest {
  const parsed = metricsRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const isPincodeIssue = first?.path[0] === 'pincode';
  throw AppError.badRequest(
    isPincodeIssue ? ErrorCode.INVALID_PINCODE : ErrorCode.VALIDATION_ERROR,
    first?.message ?? 'Invalid request.',
    parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
  );
}

export const storesRequestSchema = z.object({
  pincode: pincodeSchema,
  /** How many nearby stores to return. Capped so one call cannot fan out. */
  limit: z.coerce.number().int().positive().max(20).optional(),
});

export type StoresRequest = z.infer<typeof storesRequestSchema>;

export function parseStoresRequest(input: unknown): StoresRequest {
  const parsed = storesRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const isPincodeIssue = first?.path[0] === 'pincode';
  throw AppError.badRequest(
    isPincodeIssue ? ErrorCode.INVALID_PINCODE : ErrorCode.VALIDATION_ERROR,
    first?.message ?? 'Invalid request.',
    parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
  );
}

/**
 * Range checks that need both bounds resolved, so they run after the window is
 * built rather than during field validation.
 */
export function assertRangeUsable(window: { from: string; to: string; days: number }): void {
  if (window.from > window.to) {
    throw AppError.badRequest(
      ErrorCode.INVALID_DATE_RANGE,
      `"from" (${window.from}) must not be later than "to" (${window.to}).`,
    );
  }
  if (window.days > env.METRICS_MAX_RANGE_DAYS) {
    throw AppError.badRequest(
      ErrorCode.INVALID_DATE_RANGE,
      `Requested range spans ${window.days} days, which exceeds the ${env.METRICS_MAX_RANGE_DAYS}-day limit. ` +
        `Narrow the range, or raise METRICS_MAX_RANGE_DAYS.`,
    );
  }
}

/** Re-exported so callers can compute a span without importing date utils. */
export { daysBetween };
