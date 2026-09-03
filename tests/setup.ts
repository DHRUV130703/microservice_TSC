process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.METRICS_CACHE_TTL_SECONDS = '0';
process.env.METRICS_PERIOD_MODE = 'calendar_months';
// Pinned so tests never depend on the operator's .env cadence.
process.env.METRICS_PERIOD_ANCHOR = 'day';
process.env.METRICS_PERIOD_MONTHS = '6';
process.env.METRICS_TIMEZONE = 'Asia/Kolkata';
process.env.SCHEMA_MAPPING_PATH = 'config/schema.mapping.test.json';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
// No store-locator key in tests, so the repository refuses before it can make
// a network call. Tests that assert on store data inject a stub instead.
delete process.env.STORE_LOCATOR_API_KEY;
