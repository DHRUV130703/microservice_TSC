# Pincode Metrics API — v1

Base URL (local): `http://localhost:3000`

Live against BigQuery project `devx-tsc`. Pincodes with data: `400092`, `560076`, `500084`,
`500072`, `201301`, `122001`.

All responses are JSON and follow one of two envelopes.

**Success**
```json
{ "success": true, "data": { ... }, "message": "optional" }
```

**Error**
```json
{ "success": false, "error": { "code": "…", "message": "…", "details": [ ... ] }, "requestId": "…" }
```

Every response carries an `x-request-id` header. Send your own to correlate logs; a UUID is
generated when you don't.

---

## `GET /api/v1/metrics`

Returns Average Order Value and Conversion Rate for one pincode over the last 6 months.

### Query parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pincode` | string | Yes | Pincode for which metrics are required. Leading/trailing whitespace is trimmed. Must match `PINCODE_PATTERN` (default: 3–12 characters of `A–Z a–z 0–9`, space, hyphen, starting alphanumeric). Not restricted to 6 Indian digits. |

### Example

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=400092"
```

The response below is a verbatim capture of that call.

---

## `POST /api/v1/metrics`

Identical semantics; the pincode travels in the body. Useful when a pincode must not appear in
access logs or URLs.

```bash
curl -X POST http://localhost:3000/api/v1/metrics \
  -H 'Content-Type: application/json' \
  -d '{"pincode":"400092"}'
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pincode` | string | Yes | As above. Must be a JSON string — `400092` (number) is rejected. |

Body limit: 16 kB.

---

## Success response — `200`

```json
{
  "success": true,
  "data": {
    "pincode": "400092",
    "period": {
      "from": "2026-03-01",
      "to": "2026-08-30",
      "months": 6,
      "mode": "calendar_months",
      "anchor": "week",
      "timezone": "Asia/Kolkata",
      "nextRolloverOn": "2026-09-06"
    },
    "metrics": {
      "averageOrderValue": 24721.38,
      "conversionRate": 13.27
    },
    "supporting": {
      "totalOrders": 537,
      "totalOrderValue": 13275383.5,
      "totalLeads": 1477,
      "convertedLeads": 196
    },
    "definitions": {
      "averageOrderValue": "SUM(sales) / COUNT(DISTINCT order_id) over orders whose shipping_pincode matches the requested pincode and whose date falls in 2026-03-01..2026-08-31, restricted to status in [valid] and pre_post_order_type in [pre_order] and flag not in [inf_test] and is_deleted is not true and order value > 0 and duplicate rows collapsed to one per order_item_doc_id (latest by record_updated_at)",
      "conversionRate": "COUNT(DISTINCT converted phone) / COUNT(DISTINCT phone) * 100 over leads whose recent_pincode matches the requested pincode and whose lead_created_on falls in 2026-03-01..2026-08-31; a lead is converted when a qualifying order shares its phone (matched against orders.phone within the same period)"
    },
    "meta": {
      "hasData": true,
      "generatedAt": "2026-08-31T10:24:15.768Z",
      "cached": false,
      "bytesProcessed": 41287360
    }
  }
}
```

### Field reference

| Field | Type | Notes |
| --- | --- | --- |
| `data.pincode` | string | The normalised (trimmed) pincode that was queried |
| `data.period.from` / `.to` | string `YYYY-MM-DD` | **Inclusive** window bounds, derived from the clock at request time |
| `data.period.months` | number | Window length in months (default 6) |
| `data.period.mode` | `calendar_months` \| `rolling` | How the window was derived |
| `data.period.anchor` | `day` \| `week` \| `month` | How often the window moves — and therefore how often BigQuery is queried |
| `data.period.nextRolloverOn` | string `YYYY-MM-DD` | Date the window next moves; until then responses are served from cache |
| `data.period.timezone` | string | IANA zone used to resolve "today" |
| `data.metrics.averageOrderValue` | number \| **null** | `totalOrderValue / totalOrders`, 2 dp. `null` when `totalOrders = 0` |
| `data.metrics.conversionRate` | number \| **null** | `convertedLeads / totalLeads × 100`, 2 dp. `null` when `totalLeads = 0` |
| `data.supporting.totalOrders` | number | Distinct valid orders in the window |
| `data.supporting.totalOrderValue` | number | Summed order value, 2 dp |
| `data.supporting.totalLeads` | number | Distinct eligible leads in the window |
| `data.supporting.convertedLeads` | number | Distinct converted leads. Always ≤ `totalLeads` |
| | | The exact conversion definition is environment-configured; `data.definitions.conversionRate` states which one produced the number |
| `data.definitions.*` | string | Human-readable statement of the exact formula and filters in force, generated from the schema mapping |
| `data.meta.hasData` | boolean | `false` when both orders and leads are zero |
| `data.meta.generatedAt` | ISO 8601 | Server time the payload was computed |
| `data.meta.cached` | boolean | `true` when served from the in-process cache |
| `data.meta.fetchedAt` | ISO 8601 | When the numbers were last computed from BigQuery |
| `data.meta.ageSeconds` | number | Age of the underlying BigQuery result; `0` on a fresh fetch |
| `data.meta.bytesProcessed` | number? | BigQuery bytes processed; absent on cached responses |
| `message` | string? | Present only when there is no data |

Both metrics are `null`, never `NaN` or `Infinity`, when their denominator is zero — always
null-check before formatting.

---

## No data — `200`

A valid pincode with no matching rows is a successful, empty answer — not an error.

```json
{
  "success": true,
  "data": {
    "pincode": "999999",
    "period": { "from": "2026-03-01", "to": "2026-08-31", "months": 6, "mode": "calendar_months", "timezone": "Asia/Kolkata" },
    "metrics": { "averageOrderValue": null, "conversionRate": null },
    "supporting": { "totalOrders": 0, "totalOrderValue": 0, "totalLeads": 0, "convertedLeads": 0 },
    "definitions": { "averageOrderValue": "…", "conversionRate": "…" },
    "meta": { "hasData": false, "generatedAt": "2026-08-31T10:24:15.788Z", "cached": false }
  },
  "message": "No data found for the requested pincode and period."
}
```

A partially-empty result is also `200` with `hasData: true` — e.g. leads but no orders yields
`averageOrderValue: null` alongside a real `conversionRate`.

---

## Errors

### `400 INVALID_PINCODE`

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PINCODE",
    "message": "Pincode is required.",
    "details": [{ "field": "pincode", "message": "Pincode is required." }]
  },
  "requestId": "09d9da7e-7e86-406d-8399-061df2446465"
}
```

Raised when `pincode` is absent, empty, not a string, or fails the pattern. The pattern message is
`"Pincode contains invalid characters or has an unsupported length."`

Validation runs before any BigQuery access, so this is returned even while the backend is
misconfigured.

### `400 VALIDATION_ERROR`

Malformed JSON body on `POST`.

### `404 NOT_FOUND`

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Route GET /nope does not exist." }, "requestId": "…" }
```

### `500 CONFIGURATION_ERROR`

The service is reachable but cannot query. Causes and their messages:

| Cause | Message |
| --- | --- |
| Schema mapping missing/invalid | `The analytics schema mapping is missing or invalid. The service cannot compute metrics until it is configured.` |
| Table or dataset not found | `The configured analytics tables could not be found. Verify the schema mapping against BigQuery.` |
| Permission denied | `The service account is not permitted to query the configured analytics tables.` |
| Generated query invalid for the schema | `The generated analytics query is invalid for the configured schema. Verify the schema mapping column names and types.` |
| Cost ceiling exceeded | `The analytics query would exceed the configured cost ceiling. Narrow the reporting window or raise BIGQUERY_MAXIMUM_BYTES_BILLED.` |
| Credentials missing/invalid | `Analytics credentials are missing or invalid.` |

Check `/health/ready` — it returns the full operator-facing diagnostic.

### `500 INTERNAL_ERROR`

```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred." }, "requestId": "…" }
```

Always this exact generic message. The real cause is logged against the same `requestId`.

### `502 UPSTREAM_ERROR`

BigQuery was unreachable or failed for a transient reason. Safe to retry with backoff.

### `504 UPSTREAM_TIMEOUT`

The query exceeded `BIGQUERY_TIMEOUT_MS` (default 60 s). Safe to retry.

### Guarantees

No error response ever contains SQL text, dataset/table/column names, project ids, stack traces,
or credential material. This is enforced by tests in `tests/api.test.ts`.

---

## Health

### `GET /health` — liveness

```json
{ "success": true, "data": { "status": "ok", "uptimeSeconds": 42 } }
```

Never touches BigQuery. Use for load-balancer liveness probes.

### `GET /health/ready` — readiness

`200` when the schema mapping loads and validates:

```json
{
  "success": true,
  "data": {
    "status": "ready",
    "schemaMapping": { "loaded": true, "ordersSourceKind": "table", "leadsSourceKind": "table", "conversionStrategy": "join_orders" },
    "period": { "from": "2026-03-01", "to": "2026-08-31", "months": 6, "mode": "calendar_months" }
  }
}
```

`503` otherwise, with the operator-facing diagnostic. It reports the mapping's *shape* only —
never dataset or table identifiers.

---

## CORS

`GET`, `POST` and `OPTIONS` are allowed. `Access-Control-Allow-Origin` comes from
`CORS_ALLOW_ORIGIN` (default `*` — set the real frontend origin in production).
Allowed request headers: `Content-Type`, `x-request-id`.

---

## Caching

- BigQuery's own query cache is enabled.
- An in-process TTL cache keyed on `pincode + period` holds responses for
  `METRICS_CACHE_TTL_SECONDS` (currently 604800 = 7 days, `0` disables). Cache hits are marked
  `meta.cached: true` and carry `meta.ageSeconds`.
- **`METRICS_PERIOD_ANCHOR` (currently `week`) is what actually caps refresh frequency**, because
  the period is part of the cache key. With `week`, BigQuery is queried at most once per pincode
  per week; `period.nextRolloverOn` says when that happens next.
- The cache is per-process and in-memory: it is lost on restart, and each instance behind a load
  balancer maintains its own.
- No HTTP cache headers are set; add them at the edge if you want browser caching.

---

## Client example

```ts
interface MetricsResponse {
  success: boolean;
  data?: {
    pincode: string;
    period: { from: string; to: string; months: number; mode: string; timezone: string };
    metrics: { averageOrderValue: number | null; conversionRate: number | null };
    supporting: { totalOrders: number; totalOrderValue: number; totalLeads: number; convertedLeads: number };
    definitions: { averageOrderValue: string; conversionRate: string };
    meta: { hasData: boolean; generatedAt: string; cached: boolean; bytesProcessed?: number };
  };
  error?: { code: string; message: string; details?: unknown };
  message?: string;
}

export async function fetchMetrics(pincode: string, signal?: AbortSignal): Promise<MetricsResponse> {
  const res = await fetch(`/api/v1/metrics?pincode=${encodeURIComponent(pincode)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return (await res.json()) as MetricsResponse;
}
```

Formatting for display:

```ts
const inr = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`);
```
