import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinOrdersMapping } from './fixtures/mapping.js';

/**
 * Covers the configuration paths used on serverless platforms (Vercel, Cloud
 * Run, Lambda), where there is no writable filesystem and no repo checkout:
 * credentials and the schema mapping arrive as environment variables.
 *
 * `env` is parsed once at module load, so each case resets the module registry
 * and re-imports with the environment already set — the same order Vercel uses.
 */
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function freshImport<T>(path: string): Promise<T> {
  vi.resetModules();
  return (await import(path)) as T;
}

describe('schema mapping from SCHEMA_MAPPING_JSON', () => {
  it('loads raw JSON from the environment, ignoring the file path', async () => {
    process.env.SCHEMA_MAPPING_JSON = JSON.stringify(joinOrdersMapping);
    process.env.SCHEMA_MAPPING_PATH = '/nonexistent/should-not-be-read.json';

    const mod = await freshImport<typeof import('../src/config/schema.mapping.js')>(
      '../src/config/schema.mapping.js',
    );
    const mapping = mod.loadSchemaMapping();
    expect(mapping.orders.columns.orderId).toBe('order_id');
    expect(mapping.leads.conversion.strategy).toBe('join_orders');
  });

  it('accepts a base64-encoded mapping', async () => {
    process.env.SCHEMA_MAPPING_JSON = Buffer.from(JSON.stringify(joinOrdersMapping)).toString('base64');
    process.env.SCHEMA_MAPPING_PATH = '/nonexistent/should-not-be-read.json';

    const mod = await freshImport<typeof import('../src/config/schema.mapping.js')>(
      '../src/config/schema.mapping.js',
    );
    expect(mod.loadSchemaMapping().orders.columns.pincode).toBe('shipping_pincode');
  });

  it('rejects malformed inline JSON with a message naming the variable', async () => {
    process.env.SCHEMA_MAPPING_JSON = '{ not json';
    const mod = await freshImport<typeof import('../src/config/schema.mapping.js')>(
      '../src/config/schema.mapping.js',
    );
    expect(() => mod.loadSchemaMapping()).toThrow(/SCHEMA_MAPPING_JSON/);
  });

  it('still validates an inline mapping against the schema', async () => {
    const broken = JSON.parse(JSON.stringify(joinOrdersMapping));
    broken.orders.columns.pincode = 'bad`name';
    process.env.SCHEMA_MAPPING_JSON = JSON.stringify(broken);

    const mod = await freshImport<typeof import('../src/config/schema.mapping.js')>(
      '../src/config/schema.mapping.js',
    );
    expect(() => mod.loadSchemaMapping()).toThrow(/invalid/i);
  });

  it('tells the operator about the env var when no mapping exists at all', async () => {
    delete process.env.SCHEMA_MAPPING_JSON;
    const mod = await freshImport<typeof import('../src/config/schema.mapping.js')>(
      '../src/config/schema.mapping.js',
    );
    expect(() => mod.loadSchemaMapping('/nonexistent/x.json')).toThrow(/SCHEMA_MAPPING_JSON/);
  });
});

describe('BigQuery credentials from GOOGLE_CREDENTIALS_JSON', () => {
  const fakeKey = {
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'svc@test-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n',
  };

  it('builds a client from inline JSON without touching the filesystem', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify(fakeKey);
    // A stale key-file path must NOT be consulted when inline creds are present.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/key.json';
    delete process.env.GOOGLE_CLOUD_PROJECT;

    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    const client = mod.getBigQueryClient();
    expect(client).toBeDefined();
    // Falls back to the credential's own project_id when none is configured.
    expect(await client.getProjectId()).toBe('test-project');
  });

  it('accepts base64-encoded credentials', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = Buffer.from(JSON.stringify(fakeKey)).toString('base64');
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_CLOUD_PROJECT;

    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(await mod.getBigQueryClient().getProjectId()).toBe('test-project');
  });

  it('lets an explicit GOOGLE_CLOUD_PROJECT override the credential project', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify(fakeKey);
    process.env.GOOGLE_CLOUD_PROJECT = 'billing-project';

    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(await mod.getBigQueryClient().getProjectId()).toBe('billing-project');
  });

  it('rejects credentials that are neither raw JSON nor base64', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = 'not-json-not-base64-!!!';
    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(() => mod.getBigQueryClient()).toThrow(/not valid JSON/);
  });

  it('rejects credentials missing the private key', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({ client_email: 'a@b.com' });
    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(() => mod.getBigQueryClient()).toThrow(/private_key/);
  });

  it('repairs literal \\n sequences, which dashboards commonly introduce', async () => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({
      ...fakeKey,
      private_key: '-----BEGIN PRIVATE KEY-----\\nQUJD\\n-----END PRIVATE KEY-----\\n',
    });
    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(() => mod.getBigQueryClient()).not.toThrow();
  });

  it('fails loudly when the key file path is set but missing', async () => {
    delete process.env.GOOGLE_CREDENTIALS_JSON;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/key.json';
    const mod = await freshImport<typeof import('../src/config/bigquery.js')>('../src/config/bigquery.js');
    expect(() => mod.getBigQueryClient()).toThrow(/does not exist/);
  });
});

describe('bundler safety (serverless builders bundle to CJS)', () => {
  it('no source file depends on import.meta, which is empty once bundled to CJS', async () => {
    // Regression: src/app.ts resolved the static directory with
    // fileURLToPath(import.meta.url). Bundled to CJS, import.meta is empty, so
    // fileURLToPath(undefined) threw at module load and the whole function died
    // with FUNCTION_INVOCATION_FAILED before it could serve a single request.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });

    // Strip comments first — the fix is documented in prose that names the very
    // thing being banned, and that explanation must not trip the check.
    const stripComments = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = [...walk('src'), ...walk('api')].filter((file) =>
      /import\s*\.\s*meta/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders, `these files use import.meta and will crash when bundled: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the logger declares no pino transport, which would spawn a worker thread', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/utils/logger.ts', 'utf8');
    expect(source).not.toMatch(/transport\s*:/);
  });

  it('tolerates a missing public/ directory instead of crashing', async () => {
    // On Vercel the CDN serves /public ahead of any rewrite, so the function
    // bundle may legitimately not contain it.
    process.env.SCHEMA_MAPPING_JSON = JSON.stringify(joinOrdersMapping);
    const cwd = process.cwd();
    try {
      process.chdir('/tmp');
      const mod = await freshImport<typeof import('../src/app.js')>('../src/app.js');
      expect(() => mod.createApp()).not.toThrow();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('serverless entry point', () => {
  it('exports an Express handler as the default export', async () => {
    process.env.SCHEMA_MAPPING_JSON = JSON.stringify(joinOrdersMapping);
    const mod = await freshImport<{ default: unknown }>('../api/index.js');
    expect(typeof mod.default).toBe('function');
  });
});
