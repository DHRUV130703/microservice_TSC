import pino from 'pino';
import { env } from '../config/env.js';

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
  // No pino `transport`. A transport spawns a worker thread and resolves its
  // target module at runtime, which breaks inside a bundled serverless function
  // (and pulled `supports-color`/`has-flag` into the bundle graph). Plain pino
  // already writes newline-delimited JSON to stdout, which is what both local
  // development and platform log collectors want.
});

export type Logger = typeof logger;
