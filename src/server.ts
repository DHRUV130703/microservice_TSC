import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { getSchemaMapping } from './config/schema.mapping.js';

const app = createApp();

// Fail loudly at boot if the mapping is missing, but keep serving /health so
// orchestrators get a readable readiness signal instead of a crash loop.
try {
  getSchemaMapping();
  logger.info('Schema mapping loaded and validated');
} catch (error) {
  logger.error({ err: { message: (error as Error).message } }, 'Schema mapping unavailable — /api/v1/metrics will return 500 until configured');
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'pincode-metrics-service listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled rejection'));
