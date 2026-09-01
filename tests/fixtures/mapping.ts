import { schemaMappingSchema, type SchemaMapping } from '../../src/config/schema.mapping.js';

/**
 * Fixtures are *shaped* like a real mapping but use obviously synthetic names.
 * They exist to test the query builder and metric maths, not to assert anything
 * about the real BigQuery schema.
 */
export const joinOrdersMapping: SchemaMapping = schemaMappingSchema.parse({
  meta: { project: 'test-project', notes: 'fixture' },
  orders: {
    source: { kind: 'table', table: 'test-project.analytics.fact_orders' },
    columns: {
      orderId: 'order_id',
      pincode: 'shipping_pincode',
      orderDate: 'order_created_at',
      orderValue: 'grand_total',
      status: 'order_status',
      joinKey: 'customer_phone',
    },
    orderDateType: 'TIMESTAMP',
    pincodeMatch: { columnType: 'STRING', trim: true },
    excludeStatuses: ['cancelled', 'refunded'],
    requirePositiveValue: true,
  },
  leads: {
    source: { kind: 'table', table: 'test-project.analytics.fact_leads' },
    columns: {
      leadId: 'lead_id',
      pincode: 'lead_pincode',
      createdAt: 'lead_created_date',
      status: 'lead_status',
      joinKey: 'lead_phone',
    },
    createdAtType: 'DATE',
    excludeStatuses: ['spam'],
    conversion: {
      strategy: 'join_orders',
      orderWithinPeriod: true,
      normalizeJoinKey: true,
      joinKeyStripCharacters: '+-() ',
      joinKeyLastCharacters: 10,
    },
  },
});

export const statusFlagMapping: SchemaMapping = schemaMappingSchema.parse({
  meta: { project: 'test-project' },
  orders: {
    source: { kind: 'wildcard', table: 'test-project.analytics.orders_*', suffixFormat: 'YYYY_MM' },
    columns: {
      orderId: 'order_id',
      pincode: 'pincode',
      orderDate: 'order_date',
      orderValue: 'net_amount',
      status: 'status',
    },
    orderDateType: 'DATE',
    pincodeMatch: { columnType: 'INT64' },
    includeStatuses: ['Delivered', 'Shipped'],
    requirePositiveValue: false,
    dedupe: { keyColumns: ['order_id'], orderByColumn: 'updated_at', direction: 'DESC' },
  },
  leads: {
    source: { kind: 'tables', tables: ['test-project.crm.leads_current', 'test-project.crm.leads_archive'] },
    columns: { leadId: 'lead_id', pincode: 'pin', createdAt: 'created_on', status: 'stage' },
    createdAtType: 'DATETIME',
    excludeStatuses: ['duplicate'],
    conversion: { strategy: 'status_flag', convertedStatuses: ['Order Placed', 'Won'] },
  },
});

/**
 * Mirrors the real `devx-tsc` shape: order validity expressed as BOOLEAN flags
 * (`is_cancelled` / `is_refunded`) rather than a status string.
 */
export const booleanFlagsMapping: SchemaMapping = schemaMappingSchema.parse({
  meta: { project: 'test-project' },
  orders: {
    source: { kind: 'table', table: 'test-project.production.fact_order_item' },
    columns: {
      orderId: 'order_id',
      pincode: 'shipping_pincode',
      orderDate: 'order_date',
      orderValue: 'item_subtotal',
      joinKey: 'shipping_phone',
    },
    orderDateType: 'TIMESTAMP',
    booleanFlags: { excludeWhenTrue: ['is_cancelled', 'is_refunded'], requireTrue: [] },
    requirePositiveValue: true,
  },
  leads: {
    source: { kind: 'table', table: 'test-project.view_reports.lead_base' },
    columns: { leadId: 'phone', pincode: 'recent_pincode', createdAt: 'lead_created_on', joinKey: 'phone' },
    createdAtType: 'DATE',
    conversion: {
      strategy: 'join_orders',
      orderWithinPeriod: true,
      normalizeJoinKey: true,
      joinKeyStripCharacters: '+-() ',
      joinKeyLastCharacters: 10,
    },
  },
});
