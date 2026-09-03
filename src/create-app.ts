import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { createHealthRouter } from './routes/health.routes.js';
import { createMetricsRouter } from './routes/metrics.routes.js';
import { createStoresRouter } from './routes/stores.routes.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import type { MetricsController } from './controllers/metrics.controller.js';
import type { StoresController } from './controllers/stores.controller.js';

export interface AppOptions {
  /** Injected in tests so the app can run without BigQuery. */
  metricsController?: MetricsController;
  /** Injected in tests so the app can run without the store locator. */
  storesController?: StoresController;
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

  // Static UI.
  //
  // Deliberately does NOT use `import.meta.url`: serverless builders bundle this
  // file to CJS, where import.meta is empty, and fileURLToPath(undefined) throws
  // at module load — taking the whole function down before it can serve anything.
  // Resolving from cwd works under `tsx` (src/), the compiled build (dist/) and
  // a bundled function alike. When the directory is absent — as on Vercel, where
  // the CDN serves /public ahead of any rewrite — static mounting is simply
  // skipped rather than being a fatal error.
  const publicDir = [
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), '..', 'public'),
  ].find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

  if (publicDir) {
    app.use(
      express.static(publicDir, {
        index: 'index.html',
        setHeaders: (res, filePath) => {
          // Express's mime table predates AVIF and serves it as
          // application/octet-stream, which browsers may refuse inside a
          // <picture> source. Declare it explicitly.
          if (filePath.endsWith('.avif')) res.setHeader('Content-Type', 'image/avif');

          // The page is a thin shell over the API; let the API's own cache
          // govern data freshness. Images are content-addressed by name and
          // change rarely, so they can be cached hard.
          if (/\.(avif|png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
  }

  app.use(createHealthRouter());
  app.use('/api/v1', createMetricsRouter(options.metricsController));
  app.use('/api/v1', createStoresRouter(options.storesController));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
