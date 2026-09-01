import type { BigQuery, Dataset } from '@google-cloud/bigquery';

/**
 * BigQuery introspection that does NOT depend on INFORMATION_SCHEMA.
 *
 * Many service accounts are granted `bigquery.tables.list` / `.get` and data
 * read access, but not the permission required to query
 * `<dataset>.INFORMATION_SCHEMA.*`. The metadata REST API works in that case,
 * so it is the primary path here.
 */

export interface FieldInfo {
  /** Dotted path for nested RECORD fields, e.g. `customer.address.pincode`. */
  path: string;
  type: string;
  mode: string;
  /** True when this field (or an ancestor) is REPEATED. */
  repeated: boolean;
}

export interface TableInfo {
  dataset: string;
  table: string;
  type: string;
  numRows: number | null;
  numBytes: number | null;
  partitionField: string | null;
  partitionType: string | null;
  requirePartitionFilter: boolean;
  clusterFields: string[];
  fields: FieldInfo[];
  /** Populated when metadata could not be read. */
  error?: string;
}

/** Flattens a BigQuery schema into dotted paths so nested pincodes are visible. */
export function flattenFields(
  fields: Array<Record<string, any>> | undefined,
  prefix = '',
  repeated = false,
): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const field of fields ?? []) {
    const path = prefix ? `${prefix}.${field.name}` : String(field.name);
    const isRepeated = repeated || field.mode === 'REPEATED';
    out.push({ path, type: String(field.type), mode: String(field.mode ?? 'NULLABLE'), repeated: isRepeated });
    if (field.type === 'RECORD' || field.type === 'STRUCT') {
      out.push(...flattenFields(field.fields, path, isRepeated));
    }
  }
  return out;
}

/** Runs `worker` over `items` with a bounded number of concurrent operations. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function listDatasets(client: BigQuery, only?: string): Promise<string[]> {
  if (only) return only.split(',').map((d) => d.trim()).filter(Boolean);
  const [datasets] = await client.getDatasets();
  return datasets.map((d) => d.id!).filter(Boolean).sort();
}

export interface IntrospectOptions {
  /** Skip tables whose type is in this set (e.g. EXTERNAL sheets). */
  skipTypes?: Set<string>;
  concurrency?: number;
  onProgress?: (done: number, total: number, dataset: string) => void;
}

export async function introspectDataset(
  client: BigQuery,
  datasetId: string,
  options: IntrospectOptions = {},
): Promise<TableInfo[]> {
  const dataset: Dataset = client.dataset(datasetId);
  const [tables] = await dataset.getTables();

  const candidates = tables.filter((t) => {
    const type = (t.metadata?.type as string) ?? 'TABLE';
    return !options.skipTypes?.has(type);
  });

  let done = 0;
  return mapWithConcurrency(candidates, options.concurrency ?? 16, async (table) => {
    const base = { dataset: datasetId, table: table.id!, type: (table.metadata?.type as string) ?? 'TABLE' };
    try {
      const [md] = await table.getMetadata();
      const partitioning = md.timePartitioning ?? md.rangePartitioning;
      const info: TableInfo = {
        ...base,
        type: String(md.type ?? base.type),
        numRows: md.numRows === undefined ? null : Number(md.numRows),
        numBytes: md.numBytes === undefined ? null : Number(md.numBytes),
        partitionField: partitioning?.field ?? (md.timePartitioning ? '_PARTITIONTIME' : null),
        partitionType: md.timePartitioning?.type ?? (md.rangePartitioning ? 'RANGE' : null),
        requirePartitionFilter: Boolean(md.requirePartitionFilter ?? md.timePartitioning?.requirePartitionFilter),
        clusterFields: (md.clustering?.fields ?? []) as string[],
        fields: flattenFields(md.schema?.fields),
      };
      options.onProgress?.(++done, candidates.length, datasetId);
      return info;
    } catch (error) {
      options.onProgress?.(++done, candidates.length, datasetId);
      return {
        ...base,
        numRows: null,
        numBytes: null,
        partitionField: null,
        partitionType: null,
        requirePartitionFilter: false,
        clusterFields: [],
        fields: [],
        error: String((error as Error).message).split('\n')[0],
      } satisfies TableInfo;
    }
  });
}
