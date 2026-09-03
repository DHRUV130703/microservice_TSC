import { Router } from 'express';
import { StoresController } from '../controllers/stores.controller.js';

export function createStoresRouter(controller: StoresController = new StoresController()): Router {
  const router = Router();
  router.get('/stores', (req, res, next) => void controller.getStores(req, res, next));
  router.post('/stores', (req, res, next) => void controller.postStores(req, res, next));
  return router;
}
