import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { getSchemaMapping } from '../config/schema.mapping.js';
import { resolveDateWindow } from '../utils/date.js';

/**
 * Which build is actually running, and the settings most likely to be
 * misconfigured. Without this it is impossible to tell from the outside
 * whether a redeploy picked up a new commit or a changed environment
 * variable — both of which have silently not happened during deployment.
 * Only non-secret values: never credentials, never table names.
 */
function deploymentInfo() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    environment: process.env.VERCEL_ENV ?? env.NODE_ENV,
    region: process.env.VERCEL_REGION ?? 'local',
    bigQueryLocation: env.BIGQUERY_LOCATION,
    periodAnchor: env.METRICS_PERIOD_ANCHOR,
    cacheTtlSeconds: env.METRICS_CACHE_TTL_SECONDS,
    credentialSource: process.env.GOOGLE_CREDENTIALS_JSON
      ? 'inline_env_json'
      : env.GOOGLE_APPLICATION_CREDENTIALS
        ? 'key_file'
        : 'application_default',
  };
}

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
        deployment: deploymentInfo(),
        schemaMapping: {
          loaded: true,
          ordersSourceKind: mapping.orders.source.kind,
          leadsSourceKind: mapping.leads.source.kind,
          conversionStrategy: mapping.leads.conversion.strategy,
        },
        period: {
          from: window.from,
          to: window.to,
          months: window.months,
          mode: window.mode,
          anchor: window.anchor,
          nextRolloverOn: window.nextRolloverOn,
        },
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: { code: 'CONFIGURATION_ERROR', message: (error as Error).message },
      deployment: deploymentInfo(),
    });
  }
}
