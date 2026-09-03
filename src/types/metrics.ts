import type { DateWindow } from '../utils/date.js';

/** Raw single-row aggregate returned by the BigQuery repository. */
export interface RawMetricsRow {
  totalOrders: number;
  totalOrderValue: number;
  /** AVG(value) across rows — average ITEM value on a line-item table. */
  averageRowValue?: number | null;
  totalLeads: number;
  convertedLeads: number;
}

export interface MetricsPeriod {
  from: string;
  to: string;
  /** Inclusive day count of the window. */
  days: number;
  timezone: string;
  /** `custom` when the caller supplied from/to, otherwise `default`. */
  source: DateWindow['source'];
  /** Configured window length. Absent for a custom range. */
  months?: number;
  mode?: DateWindow['mode'];
  /** How often the default window moves. Absent for a custom range. */
  anchor?: DateWindow['anchor'];
  /** When the default window next moves. Absent for a custom range. */
  nextRolloverOn?: string;
}

export interface MetricsPayload {
  pincode: string;
  period: MetricsPeriod;
  metrics: {
    /** Total order value / order count. `null` when there are no orders. */
    averageOrderValue: number | null;
    /** Converted leads / eligible leads x 100. `null` when there are no leads. */
    conversionRate: number | null;
  };
  /** Supporting counters so the metrics can be validated and debugged. */
  supporting: {
    totalOrders: number;
    totalOrderValue: number;
    totalLeads: number;
    convertedLeads: number;
    /** Average value per row. On a line-item table, the average item value. */
    averageRowValue: number | null;
  };
  /** Machine-readable statement of how each metric was computed. */
  definitions: {
    averageOrderValue: string;
    conversionRate: string;
  };
  meta: {
    hasData: boolean;
    generatedAt: string;
    cached: boolean;
    /** When this payload was actually computed from BigQuery (ISO). */
    fetchedAt: string;
    /** Age of the underlying BigQuery result, in seconds. 0 on a fresh fetch. */
    ageSeconds: number;
    /** BigQuery bytes processed. Retained on cached responses. */
    bytesProcessed?: number;
  };
}

export interface MetricsResult {
  payload: MetricsPayload;
  message?: string;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}
