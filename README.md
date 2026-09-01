# Pincode Metrics Service

Node.js + TypeScript microservice that returns **Average Order Value** and **Conversion Rate**
for a given pincode over the **last 6 months**, computed inside Google BigQuery.

```
Pincode  ->  API  ->  one parameterized BigQuery job  ->  JSON { AOV, conversionRate }
```

---

## Status: live and validated against BigQuery

Connected to project **`devx-tsc`** (`asia-south1`) via the supplied service account.

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=400092"
```

| Pincode | Orders | Total value (₹) | **AOV (₹)** | Leads | Converted | **Conversion** |
| --- | --- | --- | --- | --- | --- | --- |
| 400092 | 537 | 1,32,75,384 | **24,721.38** | 1,477 | 196 | **13.27%** |
| 560076 | 1,735 | 4,20,34,186 | **24,227.20** | 3,006 | 542 | **18.03%** |
| 500084 | 1,707 | 4,43,32,786 | **25,971.17** | 4,215 | 567 | **13.45%** |
| 122001 | 987 | 2,19,04,097 | **22,192.60** | 3,153 | 154 | **4.88%** |
| 201301 | 1,117 | 2,86,79,313 | **25,675.30** | 2,670 | 252 | **9.44%** |

Window `2026-03-01 … 2026-08-31`; ~0.09 GB per request; 106 tests pass.

---

## ⚠️ Corrected: the first mapping produced wrong numbers

An earlier version of this service read orders from `production.fact_order_item` and returned
materially wrong values. Three separate defects, all found by querying the real data:

### 1. The order table was silently abandoned mid-window

`production.fact_order_item` **stopped receiving retail-store orders on 2026-05-24.** All ~215
named stores have zero orders after that date; only online/D2C continues.

| Month | fact_order_item orders | of which retail | AOV (₹) |
| --- | --- | --- | --- |
| 2026-03 | 26,970 | 23,213 | 35,703 |
| 2026-04 | 25,896 | 21,836 | 37,008 |
| 2026-05 | 21,342 | 23,708 | 34,788 |
| **2026-06** | **4,024** | **0** | **19,550** |
| **2026-07** | **4,376** | **0** | **19,322** |
| **2026-08** | **4,276** | **0** | **18,823** |

Any 6-month window covering June onward mixed three complete months with three online-only
months. Order counts were understated by ~80% in the tail, and AOV was dragged down because the
higher-value retail orders vanished. Even in the "good" months it was missing ~40% of orders
(marketplaces).

The company migrated to a new OMS around May/June 2026 — the `migration_*` and `oms_uc_leakage`
tables are the fingerprint. Orders now live in **`view_reports.oms_sales_raw_optimized`**, which
is partitioned on `date`, spans 2024-01-01 → today, and combines retail + D2C
(`oms_retail` 952,392 + `oms_shopify_d2c` 1,187,246 ≈ its 2,106,469 rows). Its monthly volume is
continuous and growing: 42,207 orders in March → 55,670 in August.

### 2. Rows are at shipment grain, so `sales` was overcounted

The new table has one row per *shipment/tracking record*, not per order item. Order
`OD-453007253-9187` has **1,600 rows for a single item** — summing raw `sales` gives ₹2,622,688
instead of ₹1,639. Across the window, undeduplicated totals overcount by **9.2%**.

Fixed by deduplicating on `order_item_doc_id` before aggregation. Verified safe: no NULL keys,
and no `order_item_doc_id` spans more than one `order_id`, `date`, or `shipping_pincode`.

### 3. Deduplication was nondeterministic

`record_updated_at` alone ties for **11,863 items whose `sales` differ**, so `ROW_NUMBER()` chose
arbitrarily and the same query returned different totals run to run. Fixed by ordering on
`record_updated_at DESC, sales DESC, tracking_doc_id DESC`. Two consecutive validation runs are
now byte-identical. The residual max-vs-min spread across tied rows is **≤0.2% of AOV** — a
source-data quality issue worth raising with whoever owns the OMS pipeline.

### Effect of the corrections

| Pincode | Orders before → after | AOV before → after | Conversion before → after |
| --- | --- | --- | --- |
| 400092 | 221 → **537** | ₹25,552.87 → **₹24,721.38** | 6.09% → **13.27%** |
| 560076 | 623 → **1,735** | ₹28,741.58 → **₹24,227.20** | 7.65% → **18.03%** |
| 500084 | 582 → **1,707** | ₹35,383.44 → **₹25,971.17** | 5.91% → **13.45%** |

**A correction to earlier advice:** I previously reported that the order-backed and CRM-stage
conversion definitions disagreed by ~3×, and framed that as a business decision. Most of that gap
was the broken order table. With correct orders, order-backed conversion (13.27% / 18.03% /
13.45%) is much closer to the CRM's `prospect_stage` figures (17.21% / 23.05% / 23.15%). Two
independently-derived definitions now roughly agreeing is good evidence both are sane. The
remaining gap is genuine and explainable — see [Metric 2](#metric-2--conversion-rate) — but it is
a refinement, not a fork in the road.

The superseded mapping is kept at `config/schema.mapping.fact-order-item.broken.json` for
reference. Do not use it.

> ### ⚠️ Rotate the service-account key
>
> The contents of `credentials/Key.json` were pasted into a chat transcript, so treat that key as
> compromised. Rotate it in the GCP console (IAM → Service Accounts → Keys), drop the new key at
> the same path, and restart. The file is gitignored.

---

## Deploying

**[DEPLOYMENT.md](DEPLOYMENT.md)** — target comparison (Vercel vs Cloud Run), configuration
contract, secrets handling, deploy and rollback runbooks, a prioritised risk register, and the
cost model. Read it before deploying anywhere that is not a laptop.

Two items in it are blockers for a public deployment: the service-account key needs rotating, and
the API has no authentication.

---

## Architecture

```
HTTP request
    │
    ▼
routes/metrics.routes.ts        route wiring only
    │
    ▼
controllers/metrics.controller  validate input → delegate → shape HTTP response
    │
    ▼
services/metrics.service.ts    resolve date window, derive AOV + conversion rate,
    │                          describe the formulas, cache the result
    ▼
repositories/bigquery.repository.ts   build + run ONE parameterized query,
    │                                 coerce results, translate BigQuery errors
    ▼
repositories/sql/metrics.query.ts     pure SQL builder driven by the schema mapping
    │
    ▼
BigQuery
```

Supporting modules:

| Path | Responsibility |
| --- | --- |
| `src/config/env.ts` | environment schema + validation (blank values treated as unset) |
| `src/config/bigquery.ts` | BigQuery client singleton, cost ceiling, timeout |
| `src/config/schema.mapping.ts` | the schema contract: shape, identifier safety, cross-field rules |
| `src/utils/date.ts` | dynamic 6-month window, timezone handling, shard suffix ranges |
| `src/utils/validation.ts` | pincode validation (configurable pattern) |
| `src/utils/errors.ts` | `AppError` — the only errors whose text reaches a client |
| `src/middleware/requestContext.ts` | correlation id + per-request child logger |
| `src/middleware/errorHandler.ts` | single error boundary; scrubs internals |
| `src/cli/discover-schema.ts` | BigQuery introspection → Markdown report |
| `src/cli/validate-metrics.ts` | runs real queries and prints the arithmetic |

**Why a mapping file rather than hardcoded SQL:** the brief forbids inventing table and column
names. A mapping file makes the unknown facts explicit, validates them at load time, fails loudly
when absent, and keeps the SQL builder and the business logic fully testable without BigQuery.

---

## BigQuery tables and columns used

Discovered by `npm run discover:schema` and confirmed by profiling real rows. The full report
is written to `reports/schema-discovery.md`.

### Orders — `devx-tsc.view_reports.oms_sales_raw_optimized`

2,106,469 rows, **partitioned on `date` (DAY)**, clustered on `tracking_doc_id`, `store_name`.
Covers 2024-01-01 → today, retail + D2C combined. Grain is one row per **shipment/tracking
record**.

| Purpose | Column | Type | Notes |
| --- | --- | --- | --- |
| Order identifier | `order_id` | STRING | `COUNT(DISTINCT order_id)` — rows are far coarser than orders |
| Pincode | `shipping_pincode` | STRING | 530,151 / 530,759 valid 6-digit in-window; 608 missing |
| Date | `date` | DATE | **Partition key** — the 6-month filter prunes partitions |
| Order value | `sales` | FLOAT | Item-level net sales. See below |
| Validity | `order_status` | STRING | Only two values: `valid` (275,978 orders) / `cancelled` (9,775) |
| Validity | `pre_post_order_type` | STRING | `pre_order` = a real sale; `post_order` = returns, replacements, part orders, packaging, complimentary |
| Validity | `is_deleted` | BOOLEAN | Excluded when true |
| Validity | `flag` | STRING | `inf_test` marks test rows (387 in-window) — excluded |
| Dedupe key | `order_item_doc_id` | STRING | One logical item; no NULLs, never spans two orders |
| Dedupe order | `record_updated_at` | TIMESTAMP | Plus `sales`, `tracking_doc_id` tiebreaks for determinism |
| Join key | `phone` | STRING | 524,046 valid 10-digit, vs 460,887 for `shipping_phone` — `phone` is better populated |

**Value column choice.** `final_invoice_value` and `customer_payable_amount` are **order-level
values repeated on every row** (verified: 0 orders have more than one distinct value), so summing
them across rows inflates the total 5.3×. They must be taken once per order if used at all.
`sales` is the genuine item-level figure and is what every downstream reporting table in this
warehouse uses (`oms_sales_dash.Order_Sales`, `oms_retail.order_level_sales`), so AOV uses
**`sales`**.

For reference, on pincode 400092 the two framings give ₹24,721 (`sales`) versus ₹27,915
(order-level `final_invoice_value`, i.e. customer-paid including tax and shipping) — a 12.8%
difference. If the business reports AOV on invoice value rather than net sales, change
`orders.columns.orderValue` and drop the dedupe; **worth confirming against a known dashboard
figure.**

**`sales` is a FLOAT**, so summation order changes the last few paise. Immaterial to AOV, but it
is why two hand-written cross-checks can differ by ₹0.06.

### Leads — `devx-tsc.view_reports.lead_base`

4,181,431 rows = **4,181,431 distinct `phone`** — exactly one row per lead.
Partitioned on `lead_created_on` (DAY), clustered on `source`, `quality`, `lead_type`.
2024-03-02 → today.

| Purpose | Column | Type | Notes |
| --- | --- | --- | --- |
| Lead identifier | `phone` | STRING | The table's natural key; 100% clean 10-digit |
| Pincode | `recent_pincode` | STRING | 1,806,876 valid; 2,361,429 blank. `pincodes` is an equivalent column with marginally better coverage (1,837,157) |
| Date | `lead_created_on` | DATE | **Partition key** — the 6-month filter prunes partitions |
| Join key | `phone` | STRING | Joined to `oms_sales_raw_optimized.phone` |

**Why this table and not the raw CRM.** `production.lsq_all_leads` is the LeadSquared source of
truth, but it is a stage-**history** table: 37,833,986 rows for 4,185,572 distinct `lead_number`
(~9 rows per lead), and `prospect_stage` varies across a lead's rows (up to 13 distinct stages
for one lead). It is also unpartitioned, so each query scans ~1.5–2.2 GB versus ~0.09 GB.
`lead_base` is pre-deduplicated, partitioned and clustered. Its cost is that it carries no stage
column — hence the order-backed conversion definition. `custom_rnk` in `lsq_all_leads` is *not* a
deduplication key (rank 1 still yields 5,577,122 rows for 4,181,441 leads).

Tables considered and rejected: `view_reports.d2c` (order-like but derived, `ord_date_time` is
STRING), `production.amp_orders` (subset, 288,658 rows), `temp.source_wise_funnel` (deduped and
has both pincode and stage, but lives in the `temp` dataset).

### Supported physical layouts

The mapping is not tied to this shape. `source.kind` covers:

| `source.kind` | Use when | Generated SQL |
| --- | --- | --- |
| `table` | one canonical table or view (**used here**) | `FROM \`p.d.t\`` |
| `wildcard` | history split across `orders_2026_03`, `orders_2026_04`, … | `FROM \`p.d.orders_*\` WHERE _TABLE_SUFFIX BETWEEN @min AND @max` — only the shards inside the window are scanned |
| `tables` | non-uniformly named tables (e.g. `leads_current` + `leads_archive`) | `UNION ALL` of the required columns only |

`discover:schema` detects sharded families automatically. Duplicate rows are handled by an
optional `dedupe` block (`QUALIFY ROW_NUMBER() … = 1`), used by the `lsq-status` mapping.

## Metric definitions

### Metric 1 — Average Order Value

```
AOV = SUM(sales) / COUNT(DISTINCT order_id)
```

over `view_reports.oms_sales_raw_optimized`, after collapsing shipment duplicates to one row per
`order_item_doc_id`, where all of the following hold **inside BigQuery**:

- `TRIM(shipping_pincode)` equals the requested pincode
- `date` falls inside the 6-month window
- `order_status = 'valid'` — excludes `cancelled`
- `pre_post_order_type = 'pre_order'` — excludes returns, replacements, part orders, packaging
  material and complimentary orders, which are post-order artefacts rather than new sales
- `flag != 'inf_test'` — excludes test rows
- `is_deleted` is not true
- `sales > 0`

`COUNT(DISTINCT order_id)` rather than `COUNT(*)`: for pincode 400092 that is 537 orders across
~1,800 raw rows. Returns `null`, never `NaN`, when there are no orders.

Validity here needs **four different columns**, which a single status allow/deny list cannot
express — hence the mapping's `columnFilters` (any column, `in`/`not_in`) and `booleanFlags`
alongside the simpler `includeStatuses`/`excludeStatuses`. NULL is never treated as excluded
unless you ask for it (`treatNullAsExcluded`).

### Metric 2 — Conversion Rate

```
Conversion Rate = COUNT(DISTINCT converted leads) / COUNT(DISTINCT eligible leads) × 100
```

Eligible leads = rows in `view_reports.lead_base` whose `recent_pincode` matches and whose
`lead_created_on` falls in the window. One row per lead, so no deduplication is needed.

**This is the one place where the data does not settle the business question.** Two defensible
definitions exist and they disagree by roughly 3×:

| | **A. Order-backed** *(default)* | **B. CRM stage** |
| --- | --- | --- |
| Mapping | `config/schema.mapping.json` | `config/schema.mapping.lsq-status.json` |
| Lead table | `view_reports.lead_base` | `production.lsq_all_leads` |
| Converted when | the lead's phone placed a valid order in the window | latest `prospect_stage` ∈ `Converted`, `Deal Closed`, `Already Converted`, `Bought From Marketplace`, `Bought From Another Number` |
| 400092 | 6.09% (90 / 1,477) | 17.21% (264 / 1,534) |
| 560076 | 7.65% (230 / 3,006) | 23.05% (725 / 3,146) |
| 500084 | 5.91% (249 / 4,215) | 23.15% (1,052 / 4,545) |
| Cost / request | ~0.09 GB | ~1.5 GB |

To switch:

```bash
SCHEMA_MAPPING_PATH=config/schema.mapping.lsq-status.json npm start
```

**Why they differ, concretely:**

- **B counts outcomes A cannot see.** A store walk-in, a marketplace purchase, or an order placed
  from a different phone all move the CRM stage but leave no matching row in
  the order table under that lead's phone. `Bought From Marketplace` (45,239 rows) and
  `Bought From Another Number` (41,341 rows) are explicit evidence of this.
- **B is "current stage", not "ever converted".** `prospect_stage` varies across a lead's history
  rows; the mapping deduplicates on `last_modified_on DESC`, so a lead that converted and then
  moved to another stage is *not* counted. An ever-reached-converted variant would score higher
  still. This is a genuine third option, not implemented — say the word.
- **A is objective but narrow.** It only counts revenue actually recorded against that phone and
  pincode in the window, so it under-counts; but it cannot be inflated by CRM hygiene, and it
  ties directly to the same orders that produce AOV.
- **B depends on lead_zip coverage.** Only 1,806,088 of 4,185,572 deduped leads have a valid
  `lead_zip`, so B's denominator is drawn from a differently-shaped population.

**My recommendation: keep A (order-backed) as the API default**, because it is reproducible from
first principles, consistent with the AOV numerator, 17× cheaper, and immune to CRM data-entry
drift. Use B when the question is "how well is the sales team converting its pipeline?" — that
is a CRM-performance question, and the CRM's own stage is the right authority for it.

Caveats that apply to A specifically, all checked:

- **Phone-key quality is good.** Both sides are ~100% clean 10-digit; the mapping still
  normalises (strip `+-() `, keep last 10) before joining.
- **No join fan-out.** Order keys are `SELECT DISTINCT` and leads are counted with
  `COUNT(DISTINCT)`, so one lead can never be counted twice. A *shared* number (household
  landline, call-centre line) would mark every lead behind it converted; `validate:metrics`
  warns if `convertedLeads > totalLeads` or the rate exceeds 100%. Neither triggered.
- **In-period, not lifetime.** `orderWithinPeriod: true` requires the order inside the same
  window. Set `false` for cohort-lifetime conversion (costs one extra scan).
- Across the whole window, 48,933 of 73,013 order phone keys matched a lead phone key — so ~67%
  of orders are lead-attributable, and the rest are genuinely outside the funnel.

The exact definition in force is returned in **every API response** under `data.definitions`,
so consumers never have to guess which one produced a number.

### Date range

Always derived from the clock, never hardcoded. Two modes (`METRICS_PERIOD_MODE`):

| Mode | On `2026-08-31` | Meaning |
| --- | --- | --- |
| `calendar_months` *(default)* | `2026-03-01 … 2026-08-31` | 6 whole calendar months ending with the current partial month — matches the documented contract |
| `rolling` | `2026-02-28 … 2026-08-31` | exactly 6 months back from today, day-clamped for short months |

"Today" resolves in `METRICS_TIMEZONE` (`Asia/Kolkata`), so a request at 01:00 IST does not
silently use yesterday's UTC date. This matters here: an order stamped
`2026-02-28T19:37:54Z` is `2026-03-01 01:07 IST` and correctly falls **inside** the window.

Both bounds are inclusive. The window is bound as BigQuery `DATE` parameters and compared as
`col >= @from AND col < DATE_ADD(@to, INTERVAL 1 DAY)` — the column is never wrapped in
`DATE(...)`, so partition pruning still applies on `lead_base.lead_created_on`. TIMESTAMP
columns are bounded with `TIMESTAMP(@from, @timezone)`.

## API

### `GET /api/v1/metrics?pincode={pincode}`
### `POST /api/v1/metrics` — body `{ "pincode": "400092" }`

Both are supported. `GET` is the primary contract: the operation is a pure, cacheable read.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pincode` | string | Yes | Pincode to report on. Trimmed. Validated against `PINCODE_PATTERN` (default: 3–12 alphanumerics, spaces, hyphens — deliberately **not** locked to 6 Indian digits). |

Full request/response reference, including every error code: **[docs/API.md](docs/API.md)**.

### Success

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=400092"
```

```json
{
  "success": true,
  "data": {
    "pincode": "400092",
    "period": { "from": "2026-03-01", "to": "2026-08-31", "months": 6, "mode": "calendar_months", "timezone": "Asia/Kolkata" },
    "metrics": { "averageOrderValue": 25552.87, "conversionRate": 6.09 },
    "supporting": { "totalOrders": 221, "totalOrderValue": 5647185, "totalLeads": 1477, "convertedLeads": 90 },
    "definitions": {
      "averageOrderValue": "SUM(item_subtotal) / COUNT(DISTINCT order_id) over orders whose shipping_pincode matches the requested pincode and whose order_date falls in 2026-03-01..2026-08-31, restricted to is_cancelled is not true and is_refunded is not true and order value > 0",
      "conversionRate": "COUNT(DISTINCT converted phone) / COUNT(DISTINCT phone) * 100 over leads whose recent_pincode matches the requested pincode and whose lead_created_on falls in 2026-03-01..2026-08-31; a lead is converted when a qualifying order shares its phone (matched against orders.shipping_phone within the same period)"
    },
    "meta": { "hasData": true, "generatedAt": "2026-08-31T13:09:29.031Z", "cached": false, "bytesProcessed": 85511425 }
  }
}
```

This is a **verbatim response from the live service**, and the numbers reproduce
independently-written SQL exactly. `supporting` lets the metrics be validated and debugged;
`definitions` makes the response self-documenting; `bytesProcessed` makes query cost visible.

### No data — `200`

```json
{
  "success": true,
  "data": {
    "pincode": "999999",
    "period": { "from": "2026-03-01", "to": "2026-08-31", "months": 6, "mode": "calendar_months", "timezone": "Asia/Kolkata" },
    "metrics": { "averageOrderValue": null, "conversionRate": null },
    "supporting": { "totalOrders": 0, "totalOrderValue": 0, "totalLeads": 0, "convertedLeads": 0 },
    "meta": { "hasData": false, "generatedAt": "2026-08-31T10:24:15.788Z", "cached": false }
  },
  "message": "No data found for the requested pincode and period."
}
```

An unknown pincode is not an error — it is a valid question with an empty answer.

### Errors

```json
{ "success": false, "error": { "code": "INVALID_PINCODE", "message": "Pincode is required." }, "requestId": "09d9da7e-…" }
```

| HTTP | `error.code` | When |
| --- | --- | --- |
| 400 | `INVALID_PINCODE` | missing, empty, non-string, or pattern mismatch |
| 400 | `VALIDATION_ERROR` | malformed JSON body |
| 404 | `NOT_FOUND` | unknown route |
| 500 | `CONFIGURATION_ERROR` | schema mapping missing/invalid, table not found, permission denied, cost ceiling exceeded, credentials missing |
| 500 | `INTERNAL_ERROR` | anything unexpected (message is always generic) |
| 502 | `UPSTREAM_ERROR` | BigQuery unavailable |
| 504 | `UPSTREAM_TIMEOUT` | query exceeded `BIGQUERY_TIMEOUT_MS` |

Validation runs **before** the BigQuery layer is touched, so a bad request gets its `400` even
when the backend is misconfigured. No response ever contains SQL, table names, project ids,
stack traces or credential material — enforced by tests.

### Health

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness; never touches BigQuery |
| `GET /health/ready` | readiness; `503` with actionable text while the mapping is unconfigured |

---

## Refresh cadence — how often BigQuery is actually queried

Two layers control this, and **the first one is the one that matters**:

| Layer | Code | Setting |
| --- | --- | --- |
| Reporting-window anchor | [`src/utils/date.ts`](src/utils/date.ts) — `anchorDate()` / `resolveDateWindow()` | `METRICS_PERIOD_ANCHOR` |
| In-process response cache | [`src/services/metrics.service.ts`](src/services/metrics.service.ts) — `TtlCache` | `METRICS_CACHE_TTL_SECONDS` |
| BigQuery's own query cache | [`src/config/bigquery.ts`](src/config/bigquery.ts) — `useQueryCache: true` | 24 h, auto-invalidated on table change |

**The cache key is `pincode + period.from + period.to`.** So the TTL alone cannot make refreshes
less frequent than the window moves: if the window ends "today", the key rotates at midnight and
the next request is a cache miss no matter how long the TTL is. Raising only the TTL gets you
daily refreshes at best.

`METRICS_PERIOD_ANCHOR` fixes that by snapping the window's end date:

| Anchor | Window ends | BigQuery jobs | Data staleness |
| --- | --- | --- | --- |
| `day` | today | ≤ 1 per pincode per day | ≤ 24 h |
| `week` *(current)* | most recent Sunday | **≤ 1 per pincode per week** | ≤ 7 days |
| `month` | last day of previous month | ≤ 1 per pincode per month | ≤ 31 days |

Both bounds are derived from the *anchored* date, not from today, so a week-anchored window is
still exactly `METRICS_PERIOD_MONTHS` long. On Tuesday 2026-09-01 with `week`:

```json
"period": {
  "from": "2026-03-01", "to": "2026-08-30", "months": 6,
  "mode": "calendar_months", "anchor": "week",
  "timezone": "Asia/Kolkata", "nextRolloverOn": "2026-09-06"
}
```

Every response reports `period.anchor` and `period.nextRolloverOn`, plus `meta.cached`,
`meta.fetchedAt` and `meta.ageSeconds`, so a consumer can always tell how old the numbers are.

### Caveats for production

- **The cache is per-process and in-memory.** It is lost on restart, and N instances behind a
  load balancer will each query BigQuery once per window. For a strict once-per-week guarantee
  across a fleet, put the result in a shared store (Redis) or precompute the table on a schedule.
- **The window jumps, it does not slide.** With `week`, Sunday's rollover shifts the window by a
  full 7 days at once. Expect a step change in the numbers each Sunday, not a daily drift.
- Switching anchor changes the reported figures, because the window end changes. Moving from
  `day` to `week` on 2026-09-01 shortened the window from 08-31 to 08-30.

## BigQuery efficiency

- **One job per request.** Both metrics come from a single query with CTEs, returning one row.
  With `join_orders` and `orderWithinPeriod: true`, the conversion join reuses the already
  scanned `orders_scoped` CTE — the orders table is read once, not twice.
- **No full-table reads into Node.** All filtering and aggregation happen in BigQuery; exactly
  one row crosses the wire.
- **No `SELECT *`.** Only the mapped columns are projected (asserted by test).
- **Partition/cluster friendly.** Date predicates keep the column bare on the left-hand side.
- **Shard pruning.** Wildcard sources restrict `_TABLE_SUFFIX` to the window.
- **Fully parameterized.** Pincodes, dates and status lists are bound parameters — never string
  interpolation. Identifiers come only from the validated mapping and are re-checked against a
  strict pattern in the SQL builder.
- **Cost ceiling.** `maximumBytesBilled` (default 20 GB) makes a runaway query fail instead of
  running up a bill. `--dry-run` in `validate:metrics` prints the estimate first.
- **Result caching.** BigQuery's own query cache plus a small in-process TTL cache
  (`METRICS_CACHE_TTL_SECONDS`, default 300) — 6-month aggregates change slowly.

Measured on `devx-tsc`: **~0.086 GB per request** (~$0.0005 at $6.25/TB), one job, ~1–2 s cold.
The order table is unpartitioned, so its scan is bounded by column projection rather than
partition pruning; `lead_base` is partitioned on `lead_created_on` and does prune. The
`lsq-status` alternative mapping costs ~1.5 GB per request — 17× more — because
`lsq_all_leads` is unpartitioned and 37.8 M rows.

---

## Security

- Credentials are **never** in source, in responses, or in logs. Only the *path* to the key file
  is configured (`GOOGLE_APPLICATION_CREDENTIALS`), or ADC / Workload Identity is used.
- `.gitignore` excludes `credentials/`, `.env`, `*-key.json`, `*service-account*.json`,
  `Key.json`, `reports/` and the filled-in `config/schema.mapping.json`.
- The logger redacts `private_key`, `client_email`, `authorization`, `cookie` and the credentials
  path.
- The error boundary lets only `AppError` messages reach clients; everything else becomes a
  generic `INTERNAL_ERROR` with the detail logged server-side.
- `x-powered-by` disabled; JSON body capped at 16 kB.
- **Recommended for production:** mount the key as a secret (or drop it entirely in favour of
  Workload Identity), grant the service account only `roles/bigquery.dataViewer` on the two
  datasets plus `roles/bigquery.jobUser`, and set `CORS_ALLOW_ORIGIN` to the real frontend origin
  instead of `*`.

---

## Local setup

Requires Node.js ≥ 20.

```bash
npm install
cp .env.example .env
```

`.env.example` is already set up for this project:

```ini
GOOGLE_CLOUD_PROJECT=devx-tsc
GOOGLE_APPLICATION_CREDENTIALS=./credentials/Key.json
BIGQUERY_LOCATION=asia-south1    # MUST match the datasets' location
```

> **`BIGQUERY_LOCATION` is a trap worth knowing about.** The `devx-tsc` datasets live in
> `asia-south1`. Running jobs against them from `US` does not fail with a location error — it
> fails with `Access Denied: User does not have permission to query table`, which looks exactly
> like a missing IAM grant. If every table reports access denied while `getTables()` and
> `SELECT 1` both succeed, check the location before touching IAM.

`config/schema.mapping.json` is already written for `devx-tsc`, so the service runs as-is. To
re-derive it (after a schema change, or for a different project):

```bash
npm run discover:schema -- --profile --out=reports/schema-discovery.md
cp config/schema.mapping.example.json config/schema.mapping.json
# fill in using reports/schema-discovery.md, then:
npm run validate:metrics -- --top=3
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | pino level |
| `GOOGLE_CLOUD_PROJECT` | — | billing project for BigQuery jobs (`devx-tsc`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | path to service-account JSON; empty ⇒ use ADC |
| `BIGQUERY_LOCATION` | `asia-south1` | job location; **must** match the datasets or every query reports access denied |
| `BIGQUERY_MAXIMUM_BYTES_BILLED` | `20000000000` | per-query cost ceiling in bytes |
| `BIGQUERY_TIMEOUT_MS` | `60000` | query timeout |
| `SCHEMA_MAPPING_PATH` | `config/schema.mapping.json` | mapping file; set to `config/schema.mapping.lsq-status.json` for the CRM-stage conversion definition |
| `METRICS_PERIOD_MODE` | `calendar_months` | `calendar_months` \| `rolling` |
| `METRICS_PERIOD_MONTHS` | `6` | window length in months |
| `METRICS_TIMEZONE` | `Asia/Kolkata` | IANA zone used to resolve "today" |
| `PINCODE_PATTERN` | `^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$` | validation regex; use `^[1-9][0-9]{5}$` for strict Indian pincodes |
| `METRICS_PERIOD_ANCHOR` | `week` | how often the window moves — `day` \| `week` \| `month`. **This governs how often BigQuery is queried.** |
| `METRICS_CACHE_TTL_SECONDS` | `604800` | in-process cache TTL; `0` disables. Keep ≥ the anchor interval |
| `METRICS_CACHE_MAX_ENTRIES` | `5000` | max cached pincode+period entries |
| `CORS_ALLOW_ORIGIN` | `*` | allowed frontend origin |

Blank values are treated as unset, so commenting out a value in `.env` falls back to the default.

---

## Running

```bash
npm run dev      # watch mode
npm run build    # compile to dist/
npm start        # run the compiled service
```

```bash
npm run typecheck
npm test
npm run test:watch
```

Utilities:

| Command | Purpose |
| --- | --- |
| `npm run discover:schema` | introspect BigQuery, write the schema report |
| `npm run validate:metrics -- --pincode=400092` | run the real query and print the arithmetic |
| `npm run print:sql` | print the exact SQL the service will run, from the real mapping (no BigQuery needed) |

---

## Testing the API

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=400092"
```

```bash
curl -X POST -H 'Content-Type: application/json' -d '{"pincode":"400092"}' http://localhost:3000/api/v1/metrics
```

Pincodes with live data to try: `400092`, `560076`, `500084`, `500072`, `201301`, `122001`.

```bash
curl "http://localhost:3000/api/v1/metrics"                  # 400 INVALID_PINCODE
```

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=ab"       # 400 INVALID_PINCODE
```

```bash
curl "http://localhost:3000/health/ready"
```

### Automated tests — 106 passing

| File | Covers |
| --- | --- |
| `tests/date.test.ts` | 6-month window in both modes, year/leap boundaries, timezone resolution, shard suffix ranges, proof the window is not hardcoded |
| `tests/metrics.query.test.ts` | no `SELECT *`, parameterization, pincode + date pushdown, partition-friendly predicates, status allow/deny lists, **boolean validity flags**, dedupe, wildcard pruning, `UNION ALL`, all three conversion strategies, **DATE-parameter binding regression**, SQL-injection resistance |
| `tests/metrics.service.test.ts` | AOV maths incl. rounding and divide-by-zero, conversion-rate maths, no-data path, window orchestration, generated definitions, caching |
| `tests/bigquery.repository.test.ts` | request shape, one job per request, numeric coercion (`BigInt`/wrapper/string/`NULL`), full BigQuery error-translation matrix, no leakage of raw messages |
| `tests/api.test.ts` | valid pincode, GET + POST, missing/invalid/non-string pincode, alphanumeric postcodes, no-data response, error envelopes, secret-leak assertions, health, 404, CORS, validation-before-configuration regression |
| `tests/schema.mapping.test.ts` | missing/invalid mapping, every cross-field rule, rejection of unsafe identifiers |

BigQuery is mocked throughout — `npm test` needs no credentials and costs nothing.

Two of these tests exist because of bugs this work actually hit against real BigQuery:

1. **Wrong order table.** `production.fact_order_item` was abandoned mid-window — see
   [the corrections section](#-corrected-the-first-mapping-produced-wrong-numbers). No unit test
   can catch this; the guard is data-quality check 1 in the validation section.
2. **Nondeterministic deduplication.** A tied dedupe ordering key made totals vary run to run.
3. **DATE parameters bound as NULL.** Passing an ISO string with `types: { from: 'DATE' }` makes
   the client bind the parameter as NULL, so every date predicate silently evaluated false and
   the API returned zeros for every pincode — no error, no warning. Dates must be `BigQueryDate`
   instances. `types` is still required for empty array parameters, so both mechanisms coexist.
4. **Validation ordering.** The route used to build the metrics service (loading the schema
   mapping) *before* validating input, so a malformed pincode returned `500 CONFIGURATION_ERROR`
   instead of `400 INVALID_PINCODE`.

A third fix has no test because it is configuration, not code: `BIGQUERY_LOCATION` must be
`asia-south1`, and a mismatch presents as `Access Denied`, not as a location error.

---

## Validating the metrics against real data

Run against live BigQuery and checked against SQL written independently of the service code:

| Pincode | | Orders | Total value (₹) | AOV (₹) | Leads | Converted | Conversion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400092 | service | 537 | 13,275,383.50 | 24,721.38 | 1,477 | 196 | 13.27% |
| 400092 | cross-check | 537 | 13,275,383.50 | 24,721.38 | 1,477 | 196 | 13.27% |
| 560076 | service | 1,735 | 42,034,186.17 | 24,227.20 | 3,006 | 542 | 18.03% |
| 560076 | cross-check | 1,735 | 42,034,186.17 | 24,227.20 | 3,006 | 542 | 18.03% |
| 500084 | service | 1,707 | 44,332,785.77 | 25,971.17 | 4,215 | 567 | 13.45% |
| 500084 | cross-check | 1,707 | 44,332,785.77 | 25,971.17 | 4,215 | 567 | 13.45% |

Two consecutive runs are **byte-identical**, which is the check that catches the nondeterministic
dedupe described above. Edge cases verified live:

- `999999` — 63 leads, 0 orders → `averageOrderValue: null`, `conversionRate: 0`
- `000000` — 914 leads, 0 orders → same shape
- a pincode with neither → all zeros, `hasData: false`, plus the no-data `message`

### Reproducing it

```bash
npm run validate:metrics -- --pincode=400092 --pincode=560076 --pincode=500084
```

```bash
npm run validate:metrics -- --top=3 --print-sql
```

```bash
npm run validate:metrics -- --pincode=400092 --dry-run
```

For each pincode it prints distinct order ids, raw row count, total order value, the observed
order-date range in the business timezone, the AOV division, eligible leads, converted leads and
the conversion division — then flags anything suspicious:

- `convertedLeads > totalLeads` → the conversion join is fanning out
- conversion rate > 100%
- orders present but zero leads → wrong lead source or pincode column
- an order date outside the window → wrong date column or type
- raw rows ≠ distinct order ids → shipment/line grain or duplicates (expected here)

**Run it twice and diff the output.** If the numbers move, a dedupe ordering key is tied.

### Cross-check SQL

Run in the BigQuery console (**location `asia-south1`**):

```sql
-- AOV cross-check
WITH deduped AS (
  SELECT order_id, shipping_pincode, sales
  FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
  WHERE date >= DATE '2026-03-01'
    AND date <  DATE_ADD(DATE '2026-08-31', INTERVAL 1 DAY)
    AND TRIM(shipping_pincode) IN ('400092', '560076', '500084')
    AND LOWER(TRIM(order_status))         = 'valid'
    AND LOWER(TRIM(pre_post_order_type))  = 'pre_order'
    AND (flag IS NULL OR LOWER(TRIM(flag)) != 'inf_test')
    AND COALESCE(is_deleted, FALSE) = FALSE
    AND sales > 0
  -- Tiebreaks are required: record_updated_at alone is not unique.
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY order_item_doc_id
    ORDER BY record_updated_at DESC, sales DESC, tracking_doc_id DESC) = 1
)
SELECT TRIM(shipping_pincode) AS pincode,
       COUNT(DISTINCT order_id)                                AS orders,
       ROUND(SUM(sales), 2)                                    AS total_value,
       ROUND(SUM(sales) / COUNT(DISTINCT order_id), 2)         AS aov
FROM deduped GROUP BY 1 ORDER BY 1;
```

```sql
-- Conversion cross-check (default: order-backed, same pincode)
WITH deduped AS (
  SELECT order_id, shipping_pincode, phone
  FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
  WHERE date >= DATE '2026-03-01'
    AND date <  DATE_ADD(DATE '2026-08-31', INTERVAL 1 DAY)
    AND LOWER(TRIM(order_status)) = 'valid'
    AND LOWER(TRIM(pre_post_order_type)) = 'pre_order'
    AND (flag IS NULL OR LOWER(TRIM(flag)) != 'inf_test')
    AND COALESCE(is_deleted, FALSE) = FALSE AND sales > 0
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY order_item_doc_id
    ORDER BY record_updated_at DESC, sales DESC, tracking_doc_id DESC) = 1
), okeys AS (
  SELECT DISTINCT TRIM(shipping_pincode) AS pincode,
         RIGHT(REGEXP_REPLACE(phone, r'[+\-() ]', ''), 10) AS k
  FROM deduped WHERE phone IS NOT NULL
), l AS (
  SELECT TRIM(recent_pincode) AS pincode, phone,
         RIGHT(REGEXP_REPLACE(phone, r'[+\-() ]', ''), 10) AS k
  FROM `devx-tsc.view_reports.lead_base`
  WHERE TRIM(recent_pincode) IN ('400092', '560076', '500084')
    AND lead_created_on >= DATE '2026-03-01'
    AND lead_created_on <  DATE_ADD(DATE '2026-08-31', INTERVAL 1 DAY)
)
SELECT l.pincode,
       COUNT(DISTINCT l.phone)                                      AS total_leads,
       COUNT(DISTINCT IF(o.k IS NOT NULL, l.phone, NULL))           AS converted_leads,
       ROUND(COUNT(DISTINCT IF(o.k IS NOT NULL, l.phone, NULL))
             / COUNT(DISTINCT l.phone) * 100, 2)                    AS conversion_rate
FROM l LEFT JOIN okeys o ON l.k = o.k AND l.pincode = o.pincode
GROUP BY 1 ORDER BY 1;
```

### Data-quality checks — re-run these if numbers ever look wrong

```sql
-- 1. Has the order table been abandoned? Look for a monthly cliff.
--    This is what caught the fact_order_item failure.
SELECT FORMAT_DATE('%Y-%m', date) AS ym,
       COUNT(DISTINCT order_id) AS orders,
       COUNT(DISTINCT IF(store_name IS NOT NULL AND store_name != '', order_id, NULL)) AS retail_orders,
       ROUND(SUM(sales)/1e7, 2) AS sales_cr
FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
WHERE date >= '2025-09-01' GROUP BY ym ORDER BY ym;
-- Healthy: 42,207 (Mar) -> 55,670 (Aug), retail non-zero throughout.

-- 2. How badly do shipment rows duplicate items?
SELECT COUNT(*) AS rows_n, COUNT(DISTINCT order_id) AS orders,
       COUNT(DISTINCT order_item_doc_id) AS items
FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
WHERE date BETWEEN '2026-03-01' AND '2026-08-31';   -- 530,759 / 280,421 / 433,335

-- 3. Is the dedupe ordering key actually unique? (non-zero = nondeterminism)
SELECT COUNT(*) AS items_with_ambiguous_sales FROM (
  SELECT order_item_doc_id FROM (
    SELECT order_item_doc_id, sales, record_updated_at,
           MAX(record_updated_at) OVER (PARTITION BY order_item_doc_id) AS mx
    FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
    WHERE date BETWEEN '2026-03-01' AND '2026-08-31')
  WHERE record_updated_at = mx
  GROUP BY 1 HAVING COUNT(DISTINCT sales) > 1);      -- 11,863 -> tiebreaks required

-- 4. Are order-level value columns repeated across rows? (0 = yes, repeated)
SELECT COUNTIF(n > 1) AS orders_with_varying_final_invoice_value FROM (
  SELECT order_id, COUNT(DISTINCT final_invoice_value) AS n
  FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
  WHERE date BETWEEN '2026-03-01' AND '2026-08-31' GROUP BY 1);   -- 0

-- 5. Validity vocabulary — re-check if new statuses appear
SELECT order_status, pre_post_order_type, order_type, COUNT(*) n
FROM `devx-tsc.view_reports.oms_sales_raw_optimized`
WHERE date BETWEEN '2026-03-01' AND '2026-08-31'
GROUP BY 1,2,3 ORDER BY n DESC LIMIT 20;

-- 6. Is lead_base still one row per lead, and continuous?
SELECT COUNT(*) AS rows_total, COUNT(DISTINCT phone) AS distinct_phone
FROM `devx-tsc.view_reports.lead_base`;              -- 4,181,431 / 4,181,431
```

To see the exact SQL the service runs — read from the live mapping, no credentials needed:

```bash
npm run print:sql
```

```bash
npm run print:sql -- --pincode=560076 --mapping=config/schema.mapping.lsq-status.json
```

It prints the query plus every bound parameter, so you can paste it straight into the BigQuery
console (location `asia-south1`) or diff it after a mapping change.

## Frontend

A single self-contained page is served by the same Express process at **`/`** — no build step,
no second deploy, no CORS. Open [http://localhost:3000](http://localhost:3000) after `npm run dev`.

```
Pincode input  ->  GET /api/v1/metrics  ->  two headline cards + supporting counters
```

What it handles:

| State | Behaviour |
| --- | --- |
| Valid pincode with data | Two hero cards (AOV, Conversion Rate) plus orders / order value / leads / converted |
| Valid pincode, no data | "No orders" / "No leads" rather than a misleading `₹0` or `0%` |
| Metric with no denominator | `null` renders as "No orders"/"No leads", never as zero |
| Thin lead coverage | Amber banner warning the conversion rate is a lower bound (see below) |
| Invalid / missing pincode | The API's own message, inline |
| Service unreachable | "Could not reach the metrics service" |
| Loading | Skeleton cards |

Details worth knowing:

- **Deep links.** `/?pincode=400092` loads that pincode directly, and the URL updates after each
  lookup, so a result can be shared or bookmarked.
- **Indian number formatting.** `en-IN` locale, so ₹4,19,78,941 (lakh grouping), not ₹41,978,941.
- **Freshness is visible.** A green dot for a fresh BigQuery read, amber for cached with the age,
  plus the refresh cadence and next rollover date — so nobody mistakes week-old figures for live.
- **The formulas are in the page.** "How these are calculated" expands to show
  `data.definitions`, generated from the schema mapping, so the numbers are auditable in the UI.
- **Honest about the conversion caveat.** When the lead cohort is small relative to orders
  (`totalLeads < totalOrders * 1.5`), the page says the rate is understated and warns against
  comparing pincodes. This is a real limitation of lead-pincode coverage in the source data —
  around 40% of leads carry no pincode at all.
- Light and dark themes follow the OS; layout is responsive down to mobile.

The file is [`public/index.html`](public/index.html); it is mounted in
[`src/app.ts`](src/app.ts) via `express.static`, ahead of the API and health routers, with
`Cache-Control: no-cache` so a stale shell never masks new data.

### If you would rather build a separate SPA

The API is CORS-enabled and framework-agnostic:

```js
const res  = await fetch(`/api/v1/metrics?pincode=${encodeURIComponent(pincode)}`);
const body = await res.json();

if (!body.success)            showError(body.error.message);   // INVALID_PINCODE etc.
else if (!body.data.meta.hasData) showEmpty(body.message);      // valid pincode, no data
else {
  const { averageOrderValue, conversionRate } = body.data.metrics;
  render({
    aov:  averageOrderValue === null ? '—'
          : averageOrderValue.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }),
    rate: conversionRate === null ? '—' : `${conversionRate.toFixed(2)}%`,
  });
}
```

Set `CORS_ALLOW_ORIGIN` in `.env` to the SPA's origin instead of `*`.

## Project layout

```
src/
├── app.ts                          Express app assembly
├── server.ts                       process bootstrap, graceful shutdown
├── config/
│   ├── env.ts                      environment schema + validation
│   ├── bigquery.ts                 BigQuery client, cost ceiling, timeout
│   └── schema.mapping.ts           schema contract + identifier safety
├── controllers/
│   ├── metrics.controller.ts
│   └── health.controller.ts
├── routes/
│   ├── metrics.routes.ts
│   └── health.routes.ts
├── services/metrics.service.ts     business logic, metric derivation, cache
├── repositories/
│   ├── bigquery.repository.ts      query execution + error translation
│   └── sql/
│       ├── metrics.query.ts        single-job query builder
│       └── expressions.ts          safe SQL fragments
├── middleware/
│   ├── requestContext.ts
│   └── errorHandler.ts
├── utils/{date,validation,errors,logger}.ts
├── types/metrics.ts
└── cli/
    ├── discover-schema.ts                  BigQuery introspection -> Markdown report
    ├── validate-metrics.ts                 real queries + arithmetic + warnings
    └── lib/
        ├── introspect.ts                   metadata-API introspection (no INFORMATION_SCHEMA)
        └── heuristics.ts                   candidate scoring for order/lead tables

public/index.html                           the frontend (served at /)
config/schema.mapping.json                  LIVE mapping for devx-tsc (gitignored)
config/schema.mapping.fact-order-item.broken.json  superseded — do not use
config/schema.mapping.lsq-status.json       alternative: CRM prospect_stage conversion
config/schema.mapping.example.json          single-table template
config/schema.mapping.sharded.example.json  sharded/union template
credentials/Key.json                        service-account key (gitignored — ROTATE IT)
reports/schema-discovery.md                 generated: 672 tables, 122 with a pincode column
docs/API.md                                 full API reference
docs/REQUIREMENTS.md                        the original brief
scripts/print-generated-sql.ts              renders production SQL from the mapping, offline
tests/                                      106 tests, BigQuery mocked
```
