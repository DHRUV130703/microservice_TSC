# Deployment Plan — Pincode Metrics Service

**Author:** DevOps review
**Date:** 2026-09-01 (revised — orders now read from `oms_sales_union`)
**Scope:** Taking this service from "runs on a laptop" to "runs in production"
**Status:** Deployable today with caveats. Two items below are blockers for a public deployment.

---

## 1. Executive summary

The service is a small, well-tested read-only API: **~3,000 lines of source, 152 passing tests,
one BigQuery job per request**. It is stateless apart from an in-process cache, has no database
of its own, and its only downstream dependency is BigQuery (`view_reports.oms_sales_union` for orders, `temp.source_wise_funnel` for leads).

That makes it easy to deploy. The risk is not the code — it is the operational surface around it:

| Verdict | Area |
| --- | --- |
| 🔴 **Blocker** | Service-account key is compromised and must be rotated |
| 🔴 **Blocker** | API is unauthenticated — anyone with the URL can bill queries to your warehouse |
| 🟠 High | No CI: nothing runs the 155 tests before a deploy |
| 🟠 High | Deploys are not landing reliably (production is pinned to an old commit) |
| 🟠 High | 6 moderate CVEs, all from one transitive `uuid` dependency, fix available |
| 🟡 Medium | Cache is per-instance, so the weekly-refresh guarantee does not hold on serverless |
| 🟡 Medium | No rate limiting → unbounded BigQuery spend from a single caller |
| 🟡 Medium | No metrics, no alerting; logs only |

Nothing here prevents an internal deployment behind SSO **today**. Items 1 and 2 must be closed
before the URL is reachable by anyone outside the team.

---

## 2. What is actually being deployed

```
                       ┌────────────────────────────┐
   Browser ──────────► │  public/index.html         │  static, CDN-cacheable
                       └────────────────────────────┘
                                    │ fetch /api/v1/metrics
                                    ▼
                       ┌────────────────────────────┐
   HTTP ─────────────► │  Express app               │  api/index.ts (serverless)
                       │   route → controller       │  src/server.ts  (long-running)
                       │   → service → repository   │
                       └────────────────────────────┘
                                    │ 1 parameterized job, ~112 MB scanned
                                    ▼
                       ┌────────────────────────────┐
                       │  BigQuery — asia-south1    │  devx-tsc
                       │  view_reports.oms_sales_*  │  read-only
                       │  view_reports.lead_base    │
                       └────────────────────────────┘
```

Two entry points share one app factory (`createApp()`):

| Entry | Used by | Lifecycle |
| --- | --- | --- |
| `src/start.ts` | local, Docker, Cloud Run, any VM | calls `listen()`, long-running |
| `api/index.ts` | Vercel | exports the app, invoked per request |

**Statelessness:** the only in-memory state is a TTL cache of computed metrics. Losing it costs a
BigQuery query, never correctness. The service can be scaled to N replicas or killed at will.

---

## 3. Choosing a target

The workload is unusual in one respect: **requests are rare, individually expensive (~1–8 s of
BigQuery), and highly cacheable**. That shapes the recommendation.

| | **Vercel** (current) | **Cloud Run** | **GKE / VM** |
| --- | --- | --- | --- |
| Setup effort | Lowest — already wired | Low | High |
| Cold start | 10–12 s incl. query | 0 with `min-instances=1` | none |
| Cache effectiveness | Poor — per-instance, dies on freeze | Good with min-instances | Good |
| Auth to BigQuery | Static key in env var | **Workload Identity, no key at all** | Workload Identity |
| Proximity to data | `bom1` (Mumbai) ✓ | `asia-south1` — same region ✓ | same region |
| Cost at low traffic | ~free | ~$5–8/mo with 1 warm instance | highest |
| Ops burden | none | low | real |

### Recommendation

**Short term — stay on Vercel.** It is already configured, the code supports it, and at this
traffic level the cache inefficiency costs cents.

**Medium term — move to Cloud Run.** One reason dominates: **Workload Identity removes the
service-account key entirely.** The key rotation problem below stops being a recurring risk
because there is no key. Secondary wins: `min-instances=1` makes the cache and the weekly refresh
actually work, and eliminates the 10-second cold start.

`src/start.ts` already does everything Cloud Run needs — graceful `SIGTERM` handling, a `PORT`
env var, and `/health` + `/health/ready` probes. A Dockerfile is the only missing piece.

---

## 4. Configuration contract

All configuration is environment variables, validated by Zod at boot (`src/config/env.ts`).
Invalid values fail fast with a named error; blank values are treated as unset.

### Required

| Variable | Value | Why it matters |
| --- | --- | --- |
| `GOOGLE_CREDENTIALS_JSON` | base64 or raw service-account JSON | **Secret.** Not needed on Cloud Run with Workload Identity |
| `BIGQUERY_LOCATION` | `asia-south1` | **A mismatch reports as `Access Denied`, not a location error.** This has cost debugging time twice |

### Strongly recommended

| Variable | Value | Effect if unset |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | `devx-tsc` | Falls back to the credential's project |
| `METRICS_PERIOD_ANCHOR` | `week` | Defaults to `day` — the window would then move daily instead of weekly |
| `METRICS_CACHE_TTL_SECONDS` | `604800` | Defaults to 300 s |
| `NODE_ENV` | `production` | Affects logging verbosity only |
| `CORS_ALLOW_ORIGIN` | your frontend origin | Defaults to `*` |

### Defaults that are already correct

`METRICS_TIMEZONE=Asia/Kolkata`, `METRICS_PERIOD_MONTHS=6`, `METRICS_PERIOD_MODE=calendar_months`,
`BIGQUERY_MAXIMUM_BYTES_BILLED=20000000000` (20 GB ceiling), `BIGQUERY_TIMEOUT_MS`,
`PINCODE_PATTERN`.

### Schema mapping

`config/schema.mapping.json` is **committed** (the repo is private and it holds no credentials —
only table, column and status names). `vercel.json` declares `includeFiles: "config/**"` so it
ships inside the function bundle; serverless bundlers trace `import`s, not `fs` paths.

`SCHEMA_MAPPING_JSON` overrides the file and is the escape hatch for a public repo or a
per-environment mapping. **If it is set, it wins** — a stale value there silently shadows the
committed file.

---

## 5. Secrets

### 🔴 Rotate the current key before going further

The active key `39f416b1…` for `for-abhishekh-pre-order@devx-tsc.iam.gserviceaccount.com` has been
pasted into a chat transcript, stored in Vercel, and written to disk at `credentials/Key.json`.
Treat it as public.

```
GCP Console → IAM & Admin → Service Accounts → for-abhishekh-pre-order
  → Keys → Add key (JSON)        # create the replacement
  → update GOOGLE_CREDENTIALS_JSON, redeploy, verify
  → Keys → delete key 39f416b1…  # only after the new one is confirmed working
```

### Least privilege

Confirm the account holds only:

- `roles/bigquery.dataViewer` on the **two datasets actually used** (`view_reports`, plus
  `production` only if the alternative mapping is adopted) — not project-wide
- `roles/bigquery.jobUser` on `devx-tsc` for job submission

It currently has READER on all four datasets, which is broader than the service needs.

### Rules

- Never commit `credentials/`, `.env` — both are gitignored and verified absent from the remote
- Mark `GOOGLE_CREDENTIALS_JSON` **Sensitive** in Vercel
- Pipe secrets, never paste: `base64 -i credentials/Key.json | tr -d '\n' | vercel env add …`
  (a truncated paste has already caused one outage)

---

## 6. Deploy runbook — Vercel

### 6.1 First deploy

1. Import `DHRUV130703/microservice-TSC` at vercel.com/new. Framework preset **Other**; leave
   build, output and install commands at their defaults.
2. Add the environment variables from §4 to **Production, Preview and Development**.
3. Deploy.

### 6.2 Verify — do not skip

```bash
curl 'https://<app>.vercel.app/health/ready'
```

Returns the running commit and live configuration. Check all four:

```json
{ "status": "ready",
  "deployment": { "commit": "b1cd9f2", "bigQueryLocation": "asia-south1",
                  "periodAnchor": "week", "credentialSource": "inline_env_json" } }
```

```bash
curl 'https://<app>.vercel.app/api/v1/metrics?pincode=560076'
```

Golden values, verified against the business's own canonical SQL:

Golden values depend on the window, which moves every Sunday. Reproduce them with the canonical
query for the window `/health/ready` reports, e.g. for `2026-02-28 .. 2026-08-30`:

| Pincode | AOV | Orders | Total value | Leads | Converted | Rate |
| --- | --- | --- | --- | --- | --- | --- |
| 400058 | 40,497.20 | 155 | 6,277,066.76 | 155 | 8 | 5.16% |
| 400092 | — | — | — | 1,431 | 402 | 28.09% |
| 560076 | 24,595.59 | 1,691 | 41,591,148.82 | 2,762 | 963 | 34.87% |
| 411057 | 22,017.69 | 1,446 | 31,837,585.82 | 3,176 | 563 | 17.73% |

```bash
curl 'https://<app>.vercel.app/api/v1/metrics?pincode=ab'      # 400 INVALID_PINCODE
curl 'https://<app>.vercel.app/api/v1/metrics'                 # 400 INVALID_PINCODE
curl -I 'https://<app>.vercel.app/'                            # 200 text/html
```

### 6.3 Interpreting failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `FUNCTION_INVOCATION_FAILED` | Crash at module init | Check the runtime log; historically `import.meta` under CJS |
| `CONFIGURATION_ERROR` on `/health/ready` | Bad env var | The message names the variable and the byte count received |
| `"not permitted to query"` | **Region mismatch**, usually not IAM | Set `BIGQUERY_LOCATION=asia-south1` |
| `Schema mapping not found` | File absent from the bundle | Confirm `includeFiles: "config/**"` in `vercel.json` |
| Old behaviour after a deploy | Serving a previous commit | Compare `deployment.commit` against `git rev-parse HEAD` |

### 6.4 Rollback

Vercel keeps every build. **Deployments → pick the last good one → Promote to Production.**
Instant, no rebuild. Note that environment-variable changes are *not* versioned — a rollback
restores code, not configuration.

---

## 7. Deploy runbook — Cloud Run (recommended path)

No Dockerfile exists yet; this is the work required.

```dockerfile
# Dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY config ./config
USER node
EXPOSE 3000
CMD ["node", "dist/start.js"]
```

```bash
gcloud run deploy pincode-metrics \
  --source . --region asia-south1 \
  --service-account pincode-metrics@devx-tsc.iam.gserviceaccount.com \
  --min-instances 1 --max-instances 5 --concurrency 40 \
  --set-env-vars BIGQUERY_LOCATION=asia-south1,GOOGLE_CLOUD_PROJECT=devx-tsc,METRICS_PERIOD_MODE=rolling,METRICS_PERIOD_ANCHOR=week,METRICS_CACHE_TTL_SECONDS=604800 \
  --no-allow-unauthenticated
```

`--service-account` with Workload Identity means **no `GOOGLE_CREDENTIALS_JSON` at all** — the
client library picks up Application Default Credentials, which `src/config/bigquery.ts` already
supports as its third fallback. `min-instances 1` keeps the cache warm and removes cold starts.

---

## 8. Risk register

### 🔴 P0 — before any public exposure

**1. Rotate the service-account key.** See §5. One hour of work.

**2. Put authentication in front of the API.** Today anyone with the URL can issue unlimited
BigQuery queries against the warehouse. Each is ~112 MB, so a naive script costs real money and
exposes commercial metrics. Options, cheapest first:

- Vercel Authentication (SSO for the whole deployment) — zero code, right answer for internal use
- A shared bearer token checked in middleware — ~20 lines, right answer for a frontend
- Cloud Run `--no-allow-unauthenticated` + IAP

### 🟠 P1 — within the first week

**3. Add CI.** 155 tests exist and nothing runs them before deploy. A single workflow closes this:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high
```

Then set Vercel to deploy only on a green check.

**4. Fix the 6 moderate CVEs.** All six trace to one `uuid` advisory reached through
`@google-cloud/bigquery` 7.x. `npm audit fix` resolves it; upgrading the client to 9.x is the
durable fix but is a two-major-version jump — run the full suite plus
`npm run validate:metrics -- --top=3` against real data afterwards.

**5. Make deploys deterministic.** Production is currently pinned to `438f852` while `main` is
several commits ahead. Confirm the Git integration targets `main` as the production branch, and
always verify `deployment.commit` after a deploy.

**6. Add rate limiting.** Even behind auth, one runaway client can spend real money. A per-IP
limit of ~30 requests/minute is generous for this workload.

### 🟡 P2 — within the month

**7. Shared cache.** On serverless the TTL cache is per-instance and dies on freeze, so the
`METRICS_CACHE_TTL_SECONDS` guarantee degrades to "per warm instance". Upstash Redis from
the Vercel Marketplace makes it real. Cloud Run with `min-instances=1` sidesteps it entirely.

**8. Security headers.** No `helmet`. Add CSP, HSTS, `X-Content-Type-Options`.

**9. Observability beyond logs.** 19 structured log sites and a request ID is a good baseline, but
there are no metrics and no alerting. Minimum viable: alert on 5xx rate, on p95 latency > 15 s,
and on BigQuery bytes-scanned per day exceeding a threshold — the last is the cost tripwire.

**10. Tighten CORS.** `*` today. Set it to the frontend origin.

---

**Run the function in the same region as the data.** `vercel.json` pins `regions: ["bom1"]`
(Mumbai) to match the `asia-south1` datasets. Vercel defaulted to `iad1` (US East), which sent
every query across the planet: mean response fell from ~3,400 ms to ~2,390 ms after the move, and
the cold-start window — where a slow round trip can surface as
`UPSTREAM_ERROR: The analytics backend is currently unavailable` — shrank with it. If the
datasets are ever moved, move this too.

## 9. Cost model

Per request: **~112 MB scanned ≈ $0.0006** at $6.25/TB. Query cost is flat across pincodes because
the order table is not partitioned or clustered by pincode.

| Scenario | BigQuery/month | Hosting | Total |
| --- | --- | --- | --- |
| 100 req/day, cache working | ~$0.05 | Vercel Hobby $0 | **~$0** |
| 1,000 req/day, cache per-instance | ~$3–8 | Vercel Pro $20 | ~$25 |
| Cloud Run, `min-instances=1` | ~$0.50 | ~$6 | ~$7 |

Two controls are already in place: `BIGQUERY_MAXIMUM_BYTES_BILLED` (20 GB) fails a runaway query
rather than billing it, and every response reports `meta.bytesProcessed`.

**Optimisation available:** clustering `oms_sales_union` on `shipping_pincode` would cut
the scan by roughly an order of magnitude. That is a change to the warehouse, not this service,
and needs the data team.

---

## 10. Known data caveats — read before trusting the output

These are properties of the source data, not bugs, and consumers should know them.

**Conversion comes off the lead row, not from a join.** A lead counts as converted when
`Total_Orders > 0` in `temp.source_wise_funnel`. No order table is consulted, so a lead who
ordered from a different pincode or a different phone still counts — which is why this reads far
higher than the phone-join definition it replaced (34.87% against 17.92% for 560076). The join
variant is kept as `config/schema.mapping.phonejoin.json`.

**The cohort filter does heavy lifting.** `mapping IN ('Ho','Store')` excludes 1,072,364 `Test`
leads plus `Support`, `BD`, `Progressive` and NULL — 1.14 M of 3.66 M rows. If that column's
vocabulary ever changes, the denominator moves silently. Re-check it with
`SELECT mapping, COUNT(*) FROM temp.source_wise_funnel GROUP BY 1`.

**Pincode coverage still bounds the denominator.** 1,887,942 of 3,664,379 leads (52%) carry no
pincode, so only leads whose pincode was captured are counted. The UI warns when a cohort is thin
and refuses to print a percentage below 30 leads.

**A production metric depends on the `temp` dataset.** Leads come from
`temp.source_wise_funnel`, which is the business's canonical source for the conversion query but
sits in a scratch namespace with no stability guarantee. If it is ever dropped or rebuilt,
conversion rate breaks while AOV keeps working — an asymmetric failure that will look confusing.
`config/schema.mapping.lead-base.json` swaps in `view_reports.lead_base`, in a stable dataset,
at the cost of a slightly larger denominator (3,030 vs 2,997 leads for 560076). Worth asking the
data team to promote `source_wise_funnel` into `view_reports`.

**The warehouse migrated mid-window.** `production.fact_order_item` stopped receiving retail-store
orders on 2026-05-24 — every named store shows zero orders after that date, and AOV in the tail
months collapsed from ₹35,000 to ₹19,000 as higher-value retail sales vanished. Any window
spanning that date against the old table silently under-reports by ~80%. If order counts drop
sharply again, look for another migration before suspecting the code.

**AOV is `SUM(sales) / COUNT(DISTINCT order_id)`** — the true average per order, matching the
business's canonical query (`orders.aovMethod: total_over_orders`).

Beware the alternative: `AVG(sales)` over the same table reads 25–55% lower, because
`oms_sales_union` carries ~1.75 rows per order and so averages LINE ITEMS, not orders. It is
still returned as `supporting.averageRowValue` for comparison, and
`definitions.averageOrderValue` always states which reading produced the headline figure.

**Table choice is load-bearing.** `oms_sales_union` is the business's reporting table and carries
no status or validity columns, so no rows are excluded. The stricter alternative
(`config/schema.mapping.oms-raw.json`) reads `oms_sales_raw_optimized`, excludes cancelled,
returns, replacements and test rows, and deduplicates shipment-grain rows. The two disagree; the
union table is authoritative because it is what the business already reports from.

---

## 11. Definition of done

- [ ] Service-account key rotated; old key deleted
- [ ] Authentication in front of the API
- [ ] CI running typecheck + 155 tests + audit on every push
- [ ] `/health/ready` reports the expected commit, `asia-south1`, and `week`
- [ ] Golden values match the canonical query for the window `/health/ready` reports
- [ ] `npm audit --omit=dev` clean at high severity
- [ ] Alerting on 5xx rate and daily bytes scanned
- [ ] Rollback rehearsed once, deliberately
