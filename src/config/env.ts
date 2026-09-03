import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment-based configuration. No credential material is ever placed in
 * source; only the *path* to the service-account file (or reliance on ADC).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** GCP project that owns the BigQuery *jobs* (billing project). */
  GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
  /** Path to the service-account JSON. Omit to use Application Default Credentials. */
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  /**
   * Service-account JSON supplied inline, for platforms with no writable
   * filesystem (Vercel, Cloud Run, Lambda). Raw JSON or base64-encoded.
   * Takes precedence over GOOGLE_APPLICATION_CREDENTIALS.
   */
  GOOGLE_CREDENTIALS_JSON: z.string().min(1).optional(),
  /** BigQuery job location, e.g. "US", "asia-south1". */
  BIGQUERY_LOCATION: z.string().min(1).default('US'),
  /** Hard ceiling on bytes billed per query. Query fails instead of overspending. */
  BIGQUERY_MAXIMUM_BYTES_BILLED: z.string().regex(/^\d+$/).default('20000000000'),
  /** Query timeout in milliseconds. */
  BIGQUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // --- Store locator ------------------------------------------------------
  /** Upstream store-locator endpoint that resolves a pincode to nearby stores. */
  STORE_LOCATOR_URL: z.string().url().default('https://api.thesleepcompany.in/stores'),
  /**
   * API key for the store locator. A secret: keep it in the environment, never
   * in source or in the repository.
   */
  STORE_LOCATOR_API_KEY: z.string().min(1).optional(),
  STORE_LOCATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** How long a store-locator answer is reused. Store locations move rarely. */
  STORE_LOCATOR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(86_400),
  /** Default number of nearby stores returned. */
  STORE_LOCATOR_DEFAULT_LIMIT: z.coerce.number().int().positive().max(50).default(3),
  /** Path to the landmark file generated from the store spreadsheet. */
  STORE_LANDMARKS_PATH: z.string().min(1).default('config/store-landmarks.json'),

  /** Path to the schema mapping file describing the real BigQuery layout. */
  SCHEMA_MAPPING_PATH: z.string().min(1).default('config/schema.mapping.json'),
  /**
   * The schema mapping supplied inline instead of as a file, for deployments
   * where the mapping is not committed. Raw JSON or base64-encoded.
   * Takes precedence over SCHEMA_MAPPING_PATH.
   */
  SCHEMA_MAPPING_JSON: z.string().min(1).optional(),

  /**
   * How the "last 6 months" window is derived.
   *  - calendar_months: first day of the month 5 months back .. today (inclusive).
   *                     e.g. on 2026-08-31 -> 2026-03-01 .. 2026-08-31
   *  - rolling:         today minus 6 months .. today (inclusive).
   *                     e.g. on 2026-08-31 -> 2026-02-28 .. 2026-08-31
   */
  METRICS_PERIOD_MODE: z.enum(['calendar_months', 'rolling']).default('calendar_months'),
  METRICS_PERIOD_MONTHS: z.coerce.number().int().positive().max(60).default(6),

  /**
   * How often the reporting window is allowed to move. This — not the cache TTL
   * alone — determines how often BigQuery is actually queried, because the
   * window's end date is part of the cache key.
   *  - day   : window ends today; a new BigQuery job at most once per day
   *  - week  : window ends on the most recent Sunday; one job per week
   *  - month : window ends on the last day of the previous month; one job per month
   */
  METRICS_PERIOD_ANCHOR: z.enum(['day', 'week', 'month']).default('day'),
  /** IANA timezone used to resolve "today". */
  METRICS_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),

  /** Regex a pincode must match. Deliberately not hardcoded to 6 digits. */
  PINCODE_PATTERN: z.string().min(1).default('^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$'),

  /**
   * Widest custom range a caller may request, in days. Guards BigQuery spend:
   * without it one request could scan the whole table. Generous by default,
   * about three years.
   */
  METRICS_MAX_RANGE_DAYS: z.coerce.number().int().positive().max(36500).default(1095),

  /**
   * In-process response cache TTL in seconds. 0 disables caching.
   * Cap it at or below the anchor interval; a longer TTL cannot outlive the
   * window change that rotates the cache key.
   */
  METRICS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(2_592_000).default(300),
  /** Maximum distinct pincode+period entries held in the response cache. */
  METRICS_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().max(100_000).default(500),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  // A variable present but blank (a commented-out value in .env) means "unset",
  // so defaults and `.optional()` apply instead of failing min-length checks.
  const source = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = load();
export const isProduction = env.NODE_ENV === 'production';
