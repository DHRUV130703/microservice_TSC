import type { BigQuery } from '@google-cloud/bigquery';
import { baseJobOptions, getBigQueryClient } from '../config/bigquery.js';
import { env } from '../config/env.js';
import { getSchemaMapping, type SchemaMapping } from '../config/schema.mapping.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { DateWindow } from '../utils/date.js';
import type { RawMetricsRow } from '../types/metrics.js';
import { buildMetricsQuery } from './sql/metrics.query.js';

export interface MetricsQueryResult extends RawMetricsRow {
  bytesProcessed?: number;
  cacheHit?: boolean;
}

export interface MetricsRepository {
  fetchMetrics(pincode: string, window: DateWindow): Promise<MetricsQueryResult>;
}

/** Numeric columns can arrive as BigQuery Big/Numeric wrappers or strings. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(typeof value === 'object' ? String(value) : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class BigQueryMetricsRepository implements MetricsRepository {
  private readonly client: BigQuery;
  private readonly mapping: SchemaMapping;

  constructor(client: BigQuery = getBigQueryClient(), mapping: SchemaMapping = getSchemaMapping()) {
    this.client = client;
    this.mapping = mapping;
  }

  async fetchMetrics(pincode: string, window: DateWindow): Promise<MetricsQueryResult> {
    const { sql, params, types } = buildMetricsQuery(this.mapping, pincode, window);

    // SQL is only ever emitted at debug level, and carries no user secrets.
    logger.debug({ params: Object.keys(params), from: window.from, to: window.to }, 'Executing metrics query');

    const startedAt = Date.now();
    try {
      const [job] = await this.client.createQueryJob({
        ...baseJobOptions(),
        query: sql,
        params,
        types,
      });

      const [rows] = await job.getQueryResults({ timeoutMs: baseJobOptions().timeoutMs });
      const [metadata] = await job.getMetadata();

      const row = (rows[0] ?? {}) as Record<string, unknown>;
      const bytesProcessed = Number(metadata?.statistics?.query?.totalBytesProcessed ?? 0);
      const cacheHit = Boolean(metadata?.statistics?.query?.cacheHit);

      logger.info(
        { durationMs: Date.now() - startedAt, bytesProcessed, cacheHit, jobId: metadata?.jobReference?.jobId },
        'Metrics query completed',
      );

      return {
        totalOrders: toNumber(row.totalOrders),
        totalOrderValue: toNumber(row.totalOrderValue),
        averageRowValue: row.averageRowValue === null || row.averageRowValue === undefined
          ? null
          : toNumber(row.averageRowValue),
        totalLeads: toNumber(row.totalLeads),
        convertedLeads: toNumber(row.convertedLeads),
        bytesProcessed,
        cacheHit,
      };
    } catch (error) {
      throw this.translateError(error, Date.now() - startedAt);
    }
  }

  /**
   * Converts BigQuery failures into client-safe errors. The raw message — which
   * can contain SQL, table names and project identifiers — stays in the logs.
   */
  private translateError(error: unknown, durationMs: number): AppError {
    const err = error as { message?: string; code?: number | string; errors?: Array<{ reason?: string }> };
    const message = err?.message ?? 'Unknown BigQuery error';
    const reason = err?.errors?.[0]?.reason ?? '';

    logger.error({ err: { message, code: err?.code, reason }, durationMs }, 'BigQuery query failed');

    const lower = message.toLowerCase();

    if (lower.includes('timeout') || lower.includes('deadline') || err?.code === 504) {
      return AppError.upstreamTimeout();
    }
    if (reason === 'notFound' || lower.includes('not found: table') || lower.includes('not found: dataset')) {
      return AppError.configuration(
        'The configured analytics tables could not be found. Verify the schema mapping against BigQuery.',
      );
    }
    if (reason === 'accessDenied' || err?.code === 403 || lower.includes('permission denied')) {
      // BigQuery reports a job run in the wrong region as "Access Denied", not
      // as a location error, so an operator reasonably concludes the service
      // account lacks a grant and starts editing IAM. Name the likelier cause.
      return AppError.configuration(
        `Analytics query refused. The service account may lack access to the configured tables, ` +
          `but the more common cause is a region mismatch: jobs are running in ` +
          `"${env.BIGQUERY_LOCATION}" and BigQuery reports a cross-region query as Access Denied. ` +
          `Check that BIGQUERY_LOCATION matches the dataset's location.`,
      );
    }
    if (reason === 'invalidQuery' || lower.includes('unrecognized name') || lower.includes('syntax error')) {
      return AppError.configuration(
        'The generated analytics query is invalid for the configured schema. Verify the schema mapping column names and types.',
      );
    }
    if (lower.includes('bytes billed') || lower.includes('exceeded limit')) {
      return AppError.configuration(
        'The analytics query would exceed the configured cost ceiling. Narrow the reporting window or raise BIGQUERY_MAXIMUM_BYTES_BILLED.',
      );
    }
    if (err?.code === 401 || lower.includes('could not load the default credentials') || lower.includes('unauthenticated')) {
      return AppError.configuration('Analytics credentials are missing or invalid.');
    }

    return AppError.upstream();
  }
}
