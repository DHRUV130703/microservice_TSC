# Deployment Plan — Pincode Metrics Service

**Author:** DevOps review
**Date:** 2026-09-01
**Scope:** Taking this service from "runs on a laptop" to "runs in production"
**Status:** Deployable today with caveats. Two items below are blockers for a public deployment.

---

## 1. Executive summary

The service is a small, well-tested read-only API: **~3,000 lines of source, 152 passing tests,
one BigQuery job per request**. It is stateless apart from an in-process cache, has no database
of its own, and its only downstream dependency is BigQuery.

That makes it easy to deploy. The risk is not the code — it is the operational surface around it:

| Verdict | Area |
| --- | --- |
| 🔴 **Blocker** | Service-account key is compromised and must be rotated |
| 🔴 **Blocker** | API is unauthenticated — anyone with the URL can bill queries to your warehouse |
| 🟠 High | No CI: nothing runs the 152 tests before a deploy |
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
                                    │ 1 parameterized job, ~90 MB scanned
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
| `src/server.ts` | local, Docker, Cloud Run, any VM | calls `listen()`, long-running |
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

`src/server.ts` already does everything Cloud Run needs — graceful `SIGTERM` handling, a `PORT`
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
| `METRICS_PERIOD_ANCHOR` | `week` | Defaults to `day` — 7× more BigQuery jobs |
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

- `roles/bigquery.dataViewer` on the **two datasets actually used** (`view_reports`, and
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
  "deployment": { "commit": "e625df9", "bigQueryLocation": "asia-south1",
                  "periodAnchor": "week", "credentialSource": "inline_env_json" } }
```

```bash
curl 'https://<app>.vercel.app/api/v1/metrics?pincode=560076'
```

Expected: `averageOrderValue 24251.27`, `conversionRate 17.98`, 1,731 orders, 3,003 leads.
These are cross-checked against independently written SQL — treat them as the golden values.

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
CMD ["node", "dist/server.js"]
```

```bash
gcloud run deploy pincode-metrics \
  --source . --region asia-south1 \
  --service-account pincode-metrics@devx-tsc.iam.gserviceaccount.com \
  --min-instances 1 --max-instances 5 --concurrency 40 \
  --set-env-vars BIGQUERY_LOCATION=asia-south1,GOOGLE_CLOUD_PROJECT=devx-tsc,METRICS_PERIOD_ANCHOR=week,METRICS_CACHE_TTL_SECONDS=604800 \
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
BigQuery queries against the warehouse. Each is ~90 MB, so a naive script costs real money and
exposes commercial metrics. Options, cheapest first:

- Vercel Authentication (SSO for the whole deployment) — zero code, right answer for internal use
- A shared bearer token checked in middleware — ~20 lines, right answer for a frontend
- Cloud Run `--no-allow-unauthenticated` + IAP

### 🟠 P1 — within the first week

**3. Add CI.** 152 tests exist and nothing runs them before deploy. A single workflow closes this:

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
`METRICS_PERIOD_ANCHOR=week` guarantee degrades to "weekly per warm instance". Upstash Redis from
the Vercel Marketplace makes it real. Cloud Run with `min-instances=1` sidesteps it entirely.

**8. Security headers.** No `helmet`. Add CSP, HSTS, `X-Content-Type-Options`.

**9. Observability beyond logs.** 19 structured log sites and a request ID is a good baseline, but
there are no metrics and no alerting. Minimum viable: alert on 5xx rate, on p95 latency > 15 s,
and on BigQuery bytes-scanned per day exceeding a threshold — the last is the cost tripwire.

**10. Tighten CORS.** `*` today. Set it to the frontend origin.

---

## 9. Cost model

Per request: **~90 MB scanned ≈ $0.0006** at $6.25/TB. Query cost is flat across pincodes because
the order table is not partitioned or clustered by pincode.

| Scenario | BigQuery/month | Hosting | Total |
| --- | --- | --- | --- |
| 100 req/day, cache working | ~$0.05 | Vercel Hobby $0 | **~$0** |
| 1,000 req/day, cache per-instance | ~$3–8 | Vercel Pro $20 | ~$25 |
| Cloud Run, `min-instances=1` | ~$0.50 | ~$6 | ~$7 |

Two controls are already in place: `BIGQUERY_MAXIMUM_BYTES_BILLED` (20 GB) fails a runaway query
rather than billing it, and every response reports `meta.bytesProcessed`.

**Optimisation available:** clustering `oms_sales_raw_optimized` on `shipping_pincode` would cut
the scan by roughly an order of magnitude. That is a change to the warehouse, not this service,
and needs the data team.

---

## 10. Known data caveats — read before trusting the output

These are properties of the source data, not bugs, and consumers should know them.

**Conversion rate is a lower bound.** Roughly 40% of leads carry no pincode. For pincode 400058
only 194 leads carry that pincode against 174 orders shipped there — 103 of 143 buying phone
numbers are known leads, but only 9 are recorded under 400058. The UI shows a warning when the
lead cohort is thin, and refuses to print a percentage below 30 leads.

**Conversion definitions disagree.** Order-backed matching (the default) and the CRM's own
`prospect_stage` (`config/schema.mapping.lsq-status.json`) give materially different answers. The
definition in force is returned in every response under `data.definitions`.

**The order table changed under us.** `production.fact_order_item` stopped receiving retail-store
orders on 2026-05-24; the service reads `view_reports.oms_sales_raw_optimized` instead. If order
counts ever drop sharply again, check for a similar migration before suspecting the code.

**Rows are shipment-grain.** They are deduplicated on `order_item_doc_id` before summing —
without that, revenue overcounts by ~9% overall and up to 1600× on individual orders.

---

## 11. Definition of done

- [ ] Service-account key rotated; old key deleted
- [ ] Authentication in front of the API
- [ ] CI running typecheck + 152 tests + audit on every push
- [ ] `/health/ready` reports the expected commit, `asia-south1`, and `week`
- [ ] Golden values verified: 560076 → AOV 24251.27, CR 17.98
- [ ] `npm audit --omit=dev` clean at high severity
- [ ] Alerting on 5xx rate and daily bytes scanned
- [ ] Rollback rehearsed once, deliberately
