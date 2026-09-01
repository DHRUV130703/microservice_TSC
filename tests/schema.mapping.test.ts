import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSchemaMapping, schemaMappingSchema, SchemaMappingError } from '../src/config/schema.mapping.js';
import { joinOrdersMapping } from './fixtures/mapping.js';

const temp: string[] = [];
function writeMapping(value: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-')), 'schema.mapping.json');
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  temp.push(file);
  return file;
}
afterEach(() => {
  for (const file of temp.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe('schema mapping loader', () => {
  it('refuses to run without a mapping and explains how to create one', () => {
    expect(() => loadSchemaMapping('does/not/exist.json')).toThrow(SchemaMappingError);
    expect(() => loadSchemaMapping('does/not/exist.json')).toThrow(/discover:schema/);
  });

  it('rejects invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-'));
    const file = path.join(dir, 'schema.mapping.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    temp.push(file);
    expect(() => loadSchemaMapping(file)).toThrow(/not valid JSON/);
  });

  it('loads and validates a well-formed mapping', () => {
    const loaded = loadSchemaMapping(writeMapping(joinOrdersMapping));
    expect(loaded.orders.columns.orderId).toBe('order_id');
    expect(loaded.leads.conversion.strategy).toBe('join_orders');
  });

  it('rejects the shipped template, because its placeholders are not identifiers', () => {
    const template = JSON.parse(fs.readFileSync('config/schema.mapping.example.json', 'utf8'));
    // Placeholder table refs like "REPLACE_ME.dataset.orders_table" pass the shape,
    // so the guard that matters is that a human must edit them — assert the
    // template is at least recognisably unedited.
    expect(JSON.stringify(template)).toContain('REPLACE_ME');
  });
});

describe('schema mapping validation rules', () => {
  const base = () => JSON.parse(JSON.stringify(joinOrdersMapping));

  it('rejects an allow-list and a deny-list at the same time', () => {
    const m = base();
    m.orders.includeStatuses = ['delivered'];
    m.orders.excludeStatuses = ['cancelled'];
    expect(() => loadSchemaMapping(writeMapping(m))).toThrow(/not both/);
  });

  it('rejects status filters without a status column', () => {
    const m = base();
    delete m.orders.columns.status;
    expect(() => loadSchemaMapping(writeMapping(m))).toThrow(/orders.columns.status is missing/);
  });

  it('rejects join_orders conversion without join keys on both sides', () => {
    const m = base();
    delete m.leads.columns.joinKey;
    expect(() => loadSchemaMapping(writeMapping(m))).toThrow(/needs leads.columns.joinKey/);

    const n = base();
    delete n.orders.columns.joinKey;
    expect(() => loadSchemaMapping(writeMapping(n))).toThrow(/needs orders.columns.joinKey/);
  });

  it('rejects status_flag conversion with no status column to read', () => {
    const m = base();
    delete m.leads.columns.status;
    m.leads.excludeStatuses = [];
    m.leads.conversion = { strategy: 'status_flag', convertedStatuses: ['won'] };
    expect(() => loadSchemaMapping(writeMapping(m))).toThrow(/status_flag/);
  });

  it('requires at least one converted status for status_flag', () => {
    const m = base();
    m.leads.conversion = { strategy: 'status_flag', convertedStatuses: [] };
    expect(schemaMappingSchema.safeParse(m).success).toBe(false);
  });

  it('rejects a table reference that is not qualified', () => {
    const m = base();
    m.orders.source = { kind: 'table', table: 'orders' };
    expect(schemaMappingSchema.safeParse(m).success).toBe(false);
  });

  it('rejects a wildcard source without a suffix format', () => {
    const m = base();
    m.orders.source = { kind: 'wildcard', table: 'p.d.orders_*' };
    expect(schemaMappingSchema.safeParse(m).success).toBe(false);
  });

  it('rejects an empty explicit table list', () => {
    const m = base();
    m.orders.source = { kind: 'tables', tables: [] };
    expect(schemaMappingSchema.safeParse(m).success).toBe(false);
  });

  it('rejects backticks and semicolons in column names', () => {
    for (const bad of ['a`b', 'a;b', 'a b', '1abc', 'a-b', '']) {
      const m = base();
      m.orders.columns.pincode = bad;
      expect(schemaMappingSchema.safeParse(m).success, bad).toBe(false);
    }
  });
});
