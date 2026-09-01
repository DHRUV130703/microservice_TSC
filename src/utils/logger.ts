import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured logger. Credential material, SQL text and raw BigQuery errors are
 * never emitted at info level; secret-looking keys are redacted defensively.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'pincode-metrics-service' },
  redact: {
    paths: [
      'private_key',
      'privateKey',
      'credentials',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.private_key',
      '*.client_email',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : { transport: { target: 'pino/file', options: { destination: 1 } } }),
});

export type Logger = typeof logger;
