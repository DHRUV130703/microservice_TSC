import { Router } from 'express';
import { MetricsController } from '../controllers/metrics.controller.js';

/**
 * The controller resolves its service lazily, so the process can boot (and
 * serve /health) even when the schema mapping or credentials are missing: the
 * failure then surfaces as a clean 500 CONFIGURATION_ERROR on the metrics
 * route rather than crashing at startup — and after input validation, so a
 * malformed request still gets its 400.
 */
export function createMetricsRouter(controller: MetricsController = new MetricsController()): Router {
  const router = Router();
  router.get('/metrics', (req, res, next) => void controller.getMetrics(req, res, next));
  router.post('/metrics', (req, res, next) => void controller.postMetrics(req, res, next));
  return router;
}
