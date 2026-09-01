import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createHealthRouter } from './routes/health.routes.js';
import { createMetricsRouter } from './routes/metrics.routes.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import type { MetricsController } from './controllers/metrics.controller.js';

export interface AppOptions {
  /** Injected in tests so the app can run without BigQuery. */
  metricsController?: MetricsController;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));
  app.use(requestContext);

  // Minimal CORS for the frontend: a read-only GET/POST metrics endpoint.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ALLOW_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-request-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Static UI. Resolves to <repo>/public from both src/ (tsx) and dist/ (built).
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      // The page is a thin shell over the API; let the API's own cache govern data freshness.
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  app.use(createHealthRouter());
  app.use('/api/v1', createMetricsRouter(options.metricsController));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
