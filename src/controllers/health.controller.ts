import type { Request, Response } from 'express';
import { getSchemaMapping } from '../config/schema.mapping.js';
import { resolveDateWindow } from '../utils/date.js';

/** Liveness: the process is up. Never touches BigQuery. */
export function liveness(_req: Request, res: Response): void {
  res.status(200).json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } });
}

/**
 * Readiness: configuration is loadable and coherent. Reports the *shape* of the
 * mapping without leaking dataset or table identifiers.
 */
export function readiness(_req: Request, res: Response): void {
  try {
    const mapping = getSchemaMapping();
    const window = resolveDateWindow();
    res.status(200).json({
      success: true,
      data: {
        status: 'ready',
        schemaMapping: {
          loaded: true,
          ordersSourceKind: mapping.orders.source.kind,
          leadsSourceKind: mapping.leads.source.kind,
          conversionStrategy: mapping.leads.conversion.strategy,
        },
        period: { from: window.from, to: window.to, months: window.months, mode: window.mode },
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: { code: 'CONFIGURATION_ERROR', message: (error as Error).message },
    });
  }
}
