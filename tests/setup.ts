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
// Blank, NOT deleted. `dotenv/config` runs when src/config/env.ts is first
// imported — after this file — and dotenv does not overwrite a variable that is
// already present, but it will happily fill in one that was deleted. Deleting
// the key therefore let .env put the real one back, and the whole suite started
// calling the live store locator. A blank value survives, and env.ts treats
// blank as unset, so the repository refuses before it can open a socket.
process.env.STORE_LOCATOR_API_KEY = '';
process.env.GOOGLE_CREDENTIALS_JSON = '';


// Belt and braces: no test may reach the network, whatever the configuration
// says. supertest drives the app over the http module, not fetch, so nothing
// legitimate is blocked. A test that needs fetch must stub it explicitly.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(
    `Network call blocked in tests: ${String(input)}. ` +
      'Stub fetch, or inject a fake repository, instead of calling a live service.',
  );
}) as typeof fetch;
