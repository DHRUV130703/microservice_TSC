import type { DateWindow } from '../utils/date.js';
import type { NearbyStore } from './stores.js';

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
  /**
   * Closest physical store to the pincode, with its landmark details. Resolved
   * from a separate upstream in parallel with the metrics query, so it is
   * best-effort: `null` here is disambiguated by `meta.storeLookup`.
   */
  nearestStore?: NearbyStore | null;
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
    /**
     * Outcome of the store lookup, so `nearestStore: null` is never ambiguous.
     *  - ok          : the lookup ran; `nearestStore` is the answer, possibly null
     *                  because the locator genuinely found no store nearby
     *  - unavailable : the lookup failed; metrics are unaffected
     *  - skipped     : the caller passed stores=false
     */
    storeLookup?: 'ok' | 'unavailable' | 'skipped';
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
