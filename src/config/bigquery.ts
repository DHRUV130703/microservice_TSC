import fs from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let client: BigQuery | null = null;

/**
 * Lazily builds a singleton BigQuery client.
 *
 * Credentials are resolved by the official client in this order:
 *   1. GOOGLE_APPLICATION_CREDENTIALS  -> service-account JSON file path
 *   2. Application Default Credentials -> gcloud / metadata server / Workload Identity
 *
 * The key material is never read, logged, or held by this module.
 */
export function getBigQueryClient(): BigQuery {
  if (client) return client;

  // 1. Inline credentials (Vercel / Cloud Run / Lambda — no writable filesystem).
  const inline = env.GOOGLE_CREDENTIALS_JSON;
  if (inline) {
    let parsed: { client_email?: string; private_key?: string; project_id?: string };
    try {
      const text = inline.trim().startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        'GOOGLE_CREDENTIALS_JSON is set but is not valid JSON (raw or base64). ' +
          'Paste the whole service-account file, or base64-encode it.',
      );
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_CREDENTIALS_JSON is missing client_email or private_key.');
    }

    client = new BigQuery({
      projectId: env.GOOGLE_CLOUD_PROJECT ?? parsed.project_id,
      credentials: {
        client_email: parsed.client_email,
        // Some dashboards store the key with literal \n rather than newlines.
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
      },
      location: env.BIGQUERY_LOCATION,
    });

    logger.info(
      {
        location: env.BIGQUERY_LOCATION,
        credentialSource: 'inline_env_json',
        project: env.GOOGLE_CLOUD_PROJECT ?? parsed.project_id,
      },
      'BigQuery client initialised',
    );
    return client;
  }

  // 2. Key file on disk (local development).
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS points to "${keyFile}", which does not exist. ` +
          `Provide the service-account JSON at that path, set GOOGLE_CREDENTIALS_JSON instead ` +
          `(for serverless platforms), or unset both to use Application Default Credentials.`,
      );
    }
    if (fs.statSync(keyFile).size === 0) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS points to "${keyFile}", but the file is empty (0 bytes). ` +
          `Populate it with the real service-account JSON before starting the service.`,
      );
    }
  }

  client = new BigQuery({
    ...(env.GOOGLE_CLOUD_PROJECT ? { projectId: env.GOOGLE_CLOUD_PROJECT } : {}),
    ...(keyFile ? { keyFilename: keyFile } : {}),
    location: env.BIGQUERY_LOCATION,
  });

  logger.info(
    {
      location: env.BIGQUERY_LOCATION,
      credentialSource: keyFile ? 'service_account_file' : 'application_default_credentials',
      project: env.GOOGLE_CLOUD_PROJECT ?? '(resolved from credentials)',
    },
    'BigQuery client initialised',
  );

  return client;
}

/** Job options applied to every query: cost ceiling, timeout, cache reuse. */
export function baseJobOptions() {
  return {
    location: env.BIGQUERY_LOCATION,
    maximumBytesBilled: env.BIGQUERY_MAXIMUM_BYTES_BILLED,
    useLegacySql: false,
    useQueryCache: true,
    timeoutMs: env.BIGQUERY_TIMEOUT_MS,
  };
}

/** Test hook. */
export function __setBigQueryClient(next: BigQuery | null): void {
  client = next;
}
