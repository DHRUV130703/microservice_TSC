import { z } from 'zod';
import { env } from '../config/env.js';
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

export const metricsRequestSchema = z.object({
  pincode: pincodeSchema,
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
