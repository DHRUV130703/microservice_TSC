import { Router } from 'express';
import { liveness, readiness } from '../controllers/health.controller.js';

export function createHealthRouter(): Router {
  const router = Router();
  router.get('/health', liveness);
  router.get('/health/ready', readiness);
  return router;
}
