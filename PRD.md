# Bidspoke — Product Requirements Document

**Version:** 1.0
**Author:** Dan Wright
**Date:** April 1, 2026
**Status:** Draft

> **This is the original design spec, kept for rationale and history.** For how the platform actually behaves today, the code-grounded docs under [docs/](./docs/README.md) (published at the public `/docs` site) are the source of truth. Known places where shipped behavior diverged from this spec are marked inline with a **Drift** note (see Sections 10.4 and 11.1). When this document and `docs/` disagree, trust `docs/`.

---

## 1. Overview

### 1.0 Name

**Bidspoke** is a portmanteau of two concepts:

- **Bid + spoke** — the hub-and-spoke model, where inbound leads (the hub) fan out to multiple bidding partners (the spokes) in parallel
- **Bespoke** — a custom-built, purpose-built system, as opposed to an off-the-shelf tool like Pipedream

### 1.1 What We're Building

Bidspoke is a visual workflow builder and real-time execution engine for lead routing and partner bidding. The tool replaces Pipedream as the primary platform for Pennie's lead evaluation, enrichment, and distribution workflows.

### 1.2 Why We're Building It

Pennie's current lead routing runs through Pipedream workflows that execute steps sequentially. With 2 direct partners (Tripoint, M1) plus Engine as a fallback, this works. But the architecture breaks as partners scale — each additional partner adds latency to a sequential waterfall. The tool also lacks per-partner controls (daily caps, bid thresholds, dedup) and depends on a single external developer (Bruno) for changes.

This tool solves those problems by providing parallel partner bidding, visual configuration for non-technical staff, and full ownership of the execution infrastructure.

### 1.3 Who Uses It

At least 3 people — a mix of engineers and business/ops staff. Two user profiles:

**Visual users (ops/business):** Configure partner rules, set daily caps and bid thresholds, toggle partners on/off, run tests with sample payloads. Never touch code.

**Engineer users:** All of the above, plus write custom logic in inline code editors, build new integrations, manage environment variables and secrets.

---

## 2. Technical Architecture

### 2.1 Stack

| Layer | Technology | Cost |
|---|---|---|
| Frontend | Next.js on Cloudflare Pages | Free |
| Workflow execution | Cloudflare Workers (application-level orchestration) | $0–5/mo |
| Code node sandboxing | Cloudflare Dynamic Workers (V8 isolates) | $0.002/unique worker/day + standard CPU |
| Daily cap enforcement | Cloudflare Durable Objects | Included in Workers plan |
| Database & auth | Supabase (Postgres + Auth + Realtime) | Free tier, $25/mo Pro when needed |
| Version control | GitHub | Free |
| Secrets management | Cloudflare Worker secrets (encrypted, injected into Worker env) | Included in Workers plan |
| Monitoring/alerts | Slack integration | Free |

Total cost: **$0/mo to start**, scaling to ~$30/mo.

### 2.2 Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      Cloudflare Pages                         │
│                    (Next.js Frontend)                         │
│                                                               │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────────┐ │
│  │ Canvas  │  │ Step     │  │ Test    │  │ Version       │ │
│  │ Editor  │  │ Config   │  │ Runner  │  │ History       │ │
│  └─────────┘  └──────────┘  └─────────┘  └───────────────┘ │
└────────────────────────┬─────────────────────────────────────┘
                         │ API calls (JWT auth)
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers                          │
│                 (API Layer + Execution)                        │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Workflow API  │  │ Execution    │  │ Schema          │   │
│  │ (CRUD,       │  │ Engine       │  │ Connector       │   │
│  │  versions)   │  │              │  │ (SF, Supa,      │   │
│  │              │  │              │  │  Snowflake)     │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ Workers KV   │  │ Durable      │  │ Secrets         │   │
│  │ (def cache,  │  │ Objects      │  │ (API keys,      │   │
│  │  idempotency)│  │ (daily caps, │  │  credentials —  │   │
│  │              │  │  circuit      │  │  encrypted by   │   │
│  │              │  │  breakers)   │  │  Cloudflare)    │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└────────────────────────┬─────────────────────────────────────┘
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
┌─────────────────┐ ┌─────────┐ ┌──────────────┐
│    Supabase     │ │ GitHub  │ │ External APIs│
│                 │ │ (backup)│ │              │
│ ┌─────────┐    │ │         │ │ Salesforce   │
│ │Workflow │    │ └─────────┘ │ Equifax      │
│ │Defs &   │    │             │ LendSwift    │
│ │Versions │    │             │ Elig. Scout  │
│ ├─────────┤    │             │ Partner APIs │
│ │Execution│    │             │ (Tripoint,   │
│ │Logs     │    │             │  M1, Engine) │
│ ├─────────┤    │             └──────────────┘
│ │Users &  │    │
│ │Auth     │    │
│ │(G. SSO) │    │
│ ├─────────┤    │
│ │Audit Log│    │
│ └─────────┘    │
└─────────────────┘
```

### 2.3 API Layer

The backend exposes a REST API via Cloudflare Workers. All endpoints require a valid JWT (from Supabase Auth) except the webhook execution endpoint, which uses API key authentication (Section 12.2).

**Workflow execution (external callers):**

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/:workflow_id` | Execute a workflow (external trigger — API key auth, synchronous response) |

**Workflow management (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List workflows for the organization |
| `POST` | `/api/workflows` | Create a new workflow |
| `GET` | `/api/workflows/:id` | Get workflow definition |
| `PUT` | `/api/workflows/:id` | Save workflow definition (creates version snapshot, invalidates KV, pushes to GitHub) |
| `DELETE` | `/api/workflows/:id` | Delete a workflow |
| `GET` | `/api/workflows/:id/versions` | List version history |
| `GET` | `/api/workflows/:id/versions/:version_id` | Get a specific version's definition (for preview) |
| `POST` | `/api/workflows/:id/versions/:version_id/restore` | Restore a previous version (creates new version) |
| `POST` | `/api/workflows/:id/test` | Execute a workflow with a test payload (same engine, flagged as test in execution logs) |

**Execution history (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/executions` | List executions (filterable by workflow, status, date range, source) |
| `GET` | `/api/executions/:id` | Get execution detail with all steps |
| `POST` | `/api/executions/:id/resume` | Resume from failed step |
| `POST` | `/api/executions/:id/replay` | Replay from start with original payload |

**Partner management (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/partners` | List partner configs |
| `POST` | `/api/partners` | Create a partner |
| `PUT` | `/api/partners/:id` | Update partner config (writes audit log) |
| `DELETE` | `/api/partners/:id` | Delete a partner |
| `POST` | `/api/partners/:id/circuit/reset` | Force-close a circuit breaker |
| `GET` | `/api/partners/:id/stats` | Partner performance metrics |

**Environment & secrets (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/env` | List environment variables (secret values omitted) |
| `POST` | `/api/env` | Create a variable or secret (secrets write to Cloudflare via API) |
| `PUT` | `/api/env/:id` | Update a variable or rotate a secret |
| `DELETE` | `/api/env/:id` | Delete a variable or secret |

**Service connections (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/connections` | List service connections |
| `POST` | `/api/connections` | Create a connection |
| `PUT` | `/api/connections/:id` | Update a connection |
| `POST` | `/api/connections/:id/sync-schema` | Trigger schema metadata refresh |

**Audit log (frontend):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/audit-log` | List audit entries (filterable by entity type, user, date range) |

### 2.4 Execution Model

All workflows execute synchronously within a single Cloudflare Worker invocation — the caller (form frontend, Engine, or any external network) holds an HTTP connection open and waits for the response. There is no platform-level workflow orchestrator; the Worker itself is the execution engine.

The engine must:

1. Receive the HTTP request via a Cloudflare Worker
2. **Authenticate the request** — validate the `X-API-Key` header against the source key lookup. Reject with 401 if invalid. The API key identifies the source (e.g., "wallet_owl"), which is attached to the execution context as `trigger.source` for logging and in-workflow branching (see Section 12.2). The workflow to execute is determined by the `:workflow_id` in the URL, not by the source.
3. **Idempotency check** — if the request includes an `X-Idempotency-Key` header (or a derived key is generated from the payload), check Workers KV for a cached response. If found, return the cached response immediately without executing the workflow (see Section 2.9)
4. Load the workflow definition from Supabase (cached at the edge via Workers KV) and capture the `workflow_version_id` for the execution record
5. Execute steps in order, with parallel fan-out where configured
6. Log each step's input/output to Supabase as each step completes
7. **Cache the response** in Workers KV under the idempotency key with a short TTL
8. Return the HTTP response (offer, rejection, or error)

**Time limits:** Workflows are I/O-bound — credit pulls, partner API calls, and Salesforce writes consume wall-clock time but negligible CPU time. On the Workers paid plan (30s CPU / multi-minute wall clock), this is not a practical constraint. A worst-case workflow (5s credit pull + 15s parallel partner bids + 2s Salesforce write) uses ~22s of wall clock but only milliseconds of CPU.

**Parallel execution** uses `Promise.allSettled()` within the Worker. When execution reaches a parallel node, it fans out to all configured child requests simultaneously. `Promise.allSettled()` (not `Promise.all()`) ensures that one child's failure doesn't abort the others — each child result is inspected individually. Failed children are logged, and downstream logic receives both successes and failures for evaluation.

**Retry logic** is handled per-step. Each step can configure max retries, backoff strategy, and timeout. Retries execute inline within the same request, bounded by the step's configured timeout. Only transient errors are retried — permanent errors and business rejections skip retries entirely. See Section 11 for the full error classification and per-step error behavior (`on_error`, `fallback_node`).

**Resume execution:** The engine accepts an optional `resume_from_execution_id` parameter. When provided, it loads all `execution_steps` with `status = completed` from that execution and pre-populates the step context before beginning execution. Steps with pre-loaded outputs are skipped (not re-executed). Execution begins at the first step without a pre-loaded output. A new `workflow_executions` record is created linked to the original via `parent_execution_id`.

**Parallel resume:** When a parallel node had some children complete before failure, resume skips completed children and only re-runs the incomplete ones. The engine uses `parallel_group_id` on `execution_steps` to identify which children within the group have `status = completed` and pre-populates their outputs. Only children without a completed step are re-executed. The parallel node then merges the pre-loaded results with the fresh results before passing downstream.

### 2.5 Partner Traffic Controls (Durable Objects)

Partner daily caps and circuit breakers are enforced using **Cloudflare Durable Objects** — not Postgres. At concurrent request volumes (hundreds of parallel Workers hitting the same partner simultaneously), a Postgres row lock on a shared counter becomes a serialization bottleneck that degrades p95 latency across every bid check.

A Durable Object provides a single-threaded, in-memory counter per partner. It processes requests sequentially without lock contention, responding in sub-millisecond time.

**Persistence:** Durable Objects use built-in durable storage (`ctx.storage`) so state survives restarts and deploys. Supabase writes are for the dashboard only — not for enforcement correctness.

**Caveat:** A Durable Object lives in a single Cloudflare region. For globally distributed Workers, the check adds a cross-region round-trip (~20–50ms). For US-focused lead routing this is acceptable.

#### 2.5.1 Daily Caps

**DO identifier:** `cap-{partner_slug}-{YYYY-MM-DD}` (e.g., `cap-tripoint-2026-04-01`). One DO per partner per day. At midnight UTC the next DO takes over with a fresh counter. UTC is intentional — midnight UTC is ~7-8pm Eastern, which effectively resets caps at end of business day for US operations. If org-timezone-aware resets are needed later, the date component can be derived from the org's configured timezone instead of UTC.

**Cap check flow:**
1. Worker calls `PartnerCapDO.checkAndIncrement(cap)` before sending the partner bid request
2. DO atomically checks counter < cap, increments if allowed, returns `{ allowed: true, count: N }` or `{ allowed: false }`
3. If not allowed, the Partner Bid node skips this partner entirely
4. After the execution completes, the Worker asynchronously writes the day's count to `partner_daily_counts` in Supabase for dashboard reporting

#### 2.5.2 Circuit Breakers

When a partner's API starts failing (503s, timeouts, rate limiting), the circuit breaker stops sending requests to that partner until it recovers. This prevents: adding 10-15s of wasted latency per workflow waiting for a partner that's down, piling on requests that make the partner's problem worse, and burning retry budget on requests that won't succeed.

**DO identifier:** `circuit-{partner_id}` (e.g., `circuit-tripoint`). One DO per partner (not per day).

**States:**
- **Closed** (normal) — requests flow through. The DO tracks errors in a sliding time window.
- **Open** (tripped) — all requests are immediately rejected without calling the partner. The Partner Bid node skips this partner entirely (same behavior as a failed cap check). Returns `{ allowed: false, reason: "circuit_open", opens_at: timestamp }`.
- **Half-open** (probing) — after the cooldown expires, the next single request is allowed through as a probe. If it succeeds, the circuit closes. If it fails, the circuit reopens with a longer cooldown.

**Configuration (per-partner, on `partner_configs`):**
- **`circuit_error_threshold`** — number of errors in the window that trips the circuit (default: 5)
- **`circuit_window_seconds`** — sliding window for counting errors (default: 60)
- **`circuit_cooldown_seconds`** — how long the circuit stays open before half-opening (default: 300)
- **`circuit_enabled`** — on/off toggle (default: on)

**Circuit breaker flow:**
1. Before sending a partner bid, the Worker calls `PartnerCircuitDO.check()`
2. If open → skip partner immediately (zero latency cost)
3. If closed → proceed with bid. After the bid completes, report the outcome back: `PartnerCircuitDO.recordSuccess()` or `PartnerCircuitDO.recordError()`
4. If the error count in the window exceeds the threshold → circuit opens
5. After cooldown → half-open. Next request is the probe.

**Interactions with error handling (Section 11):** Only transient errors (Section 11.1) count toward the circuit breaker threshold. Permanent errors and business rejections do not trip the circuit — a partner rejecting leads for business reasons is normal, and a 401 from bad credentials is a config problem, not an outage.

**Slack alert:** When a circuit opens, a Slack alert fires immediately with the partner name, error count, and when the circuit will half-open. When the circuit closes (probe succeeded), a recovery alert fires.

#### 2.5.3 Upstream Service Circuit Breakers

The same circuit breaker pattern applies to upstream services like Equifax. If Equifax starts returning 429s consistently, the circuit opens and all credit pull requests route directly to Eligibility Scout (via the fallback mechanism in Section 11.3) without waiting for Equifax to time out first.

**DO identifier:** `circuit-{service_name}` (e.g., `circuit-equifax`). Checked by Integration nodes that have a `fallback_node` configured. If the circuit is open and a fallback exists, the engine skips straight to the fallback without attempting the primary service.

#### 2.5.4 Future: Per-Second Rate Limiting

At Pennie's current scale, per-second rate limiting (proactive throttling) is not needed. If a partner communicates a requests-per-second limit in the future, the same Durable Object pattern can enforce it — a sliding-window counter with a sub-second window. This is noted as a future enhancement, not a Phase 1-3 requirement.

### 2.6 Workflow Definition Storage

Workflow definitions are stored as JSON in Supabase and cached in Cloudflare Workers KV for fast edge reads. The definition includes:

- All nodes (steps) and their configuration
- Edge connections — the single source of truth for graph topology, including conditional routing (see Section 4.1)
- Environment variable references
- Per-step variable overrides

When a workflow is saved in the UI, the definition is written to Supabase, a version snapshot is created, the KV cache is invalidated, and a commit is pushed to GitHub.

**Version-pinned execution:** The KV cache stores the definition keyed by workflow ID and tagged with the `workflow_version_id`. When a Worker loads the definition at the start of a request, it captures both the definition and the version ID. That version ID is recorded on the `workflow_executions` record. The definition is used for the entire execution — even if the KV cache updates mid-execution, in-flight requests are unaffected (the definition is already loaded into Worker memory).

**KV propagation window:** Workers KV is eventually consistent — updates can take up to 60 seconds to propagate globally. During this window, some requests may execute against the previous version. This is acceptable: workflow changes are infrequent, each execution is independent, and the `workflow_version_id` on every execution record makes it clear which version ran. If an ops user needs a change to take effect immediately (e.g., disabling a partner), partner config changes are enforced via Durable Objects (caps, circuit breakers) which are strongly consistent — the KV propagation delay only affects workflow *definition* changes, not partner controls.

**Rollback:** Restoring a previous version from the version history creates a new version (doesn't delete history), writes it to Supabase and KV, and follows the same propagation path. There is no blue/green deployment — the simplicity tradeoff is appropriate given the low change frequency and the strong consistency of the controls that matter most (partner caps, circuit breakers, active/inactive toggles).

**GitHub backup:** All workflow definitions are committed to a single private repository. File structure: `workflows/{workflow_id}/{workflow_name}.json` (the full definition JSONB). Commits are made from a service account (`bidspoke-bot` or similar) on the `main` branch, with the commit message including the workflow name, version number, and the user who saved it (e.g., `"Update Main Credit Decisioning v12 (Dan)"`). This is a backup and audit trail — GitHub is not the source of truth (Supabase is). The `commit_sha` on `workflow_versions` links back to the exact commit for diff viewing.

### 2.7 Authentication

Google SSO via Supabase Auth. Supabase handles the OAuth flow, session management, and JWT tokens. The frontend sends the JWT with every API request. Cloudflare Workers validate the JWT on each request.

Row-Level Security (RLS) in Supabase ensures users can only access workflows and data within their organization.

### 2.8 External Service Connections

Each integration (Salesforce, Supabase, Snowflake) supports both per-user OAuth credentials and shared service accounts. Connections are stored encrypted in Supabase.

For schema-awareness, the tool periodically syncs metadata from connected services:

- **Salesforce:** Object and field definitions via the Describe API
- **Supabase:** Table and column schemas via the Postgres information_schema
- **Snowflake:** Schema metadata via INFORMATION_SCHEMA views

This metadata powers autocomplete and dropdowns in the workflow editor — users pick fields from a list instead of typing them manually.

### 2.9 Trigger-Level Idempotency

Prevents duplicate workflow executions when the same lead hits the webhook twice in quick succession (double-click, source-side retry, network replay). This is distinct from partner-level dedup (which checks if a partner has already seen this lead) — trigger-level idempotency prevents running the workflow at all.

**Idempotency key resolution (in order of precedence):**
1. **Source-provided key:** The caller passes an `X-Idempotency-Key` header. This is the most reliable — the source knows what constitutes "the same request." Engine and other networks may already provide a request ID.
2. **Derived key:** If no header is provided, the Worker generates a key by hashing a configurable set of payload fields (e.g., `SHA-256(email + ssn_last4 + loan_amount + source_id)`). The fields used for derivation are configured per-workflow in the trigger config. This catches double-clicks from the website form where the frontend doesn't send an idempotency header.
3. **No key:** If neither is available (no header, no derivable fields configured), idempotency is skipped. The workflow executes normally.

**Mechanism:** Workers KV, keyed by `idempotent-{workflow_id}-{key}`.

**Check flow:**
1. Compute the idempotency key
2. Read from KV. If a cached response exists, return it immediately — no workflow execution, no credit pull, no partner bids. The response includes an `X-Idempotent-Replay: true` header so the caller knows it's a cached response.
3. If no cached response, write a placeholder to KV (`{ status: "processing" }`) to handle the race condition where a second request arrives while the first is still executing. The second request receives a `409 Conflict` with a `Retry-After` header.
4. After the workflow completes, overwrite the placeholder with the actual response.

**TTL:** Configurable per-workflow, default 5 minutes. Short enough that a legitimate re-application hours later isn't blocked, long enough to catch retries and double-clicks. The TTL starts when the first request arrives, not when it completes.

**KV eventual consistency caveat:** Workers KV is eventually consistent, so there's a small window (~seconds) where a near-simultaneous duplicate on a different edge node might not see the placeholder. This is acceptable — the worst case is two executions of the same lead, which the partner-level dedup endpoints catch downstream. The idempotency layer is a best-effort optimization, not a hard guarantee.

**Trigger config addition:**
```json
"trigger": {
  "type": "http_webhook",
  "config": {
    "method": "POST",
    "auth_method": "api_key",
    "idempotency": {
      "enabled": true,
      "derive_from_fields": ["personalInformation.email", "personalInformation.ssnLast4", "loanAmount"],
      "ttl_seconds": 300
    }
  }
}
```

---

## 3. Data Model

### 3.1 Core Tables

**RLS scoping:** Top-level entities (`workflows`, `partner_configs`, `environment_variables`, `service_connections`, `audit_log`) carry an `organization_id` column for direct Row-Level Security enforcement. Child tables (`workflow_versions`, `workflow_executions`, `execution_steps`, `partner_daily_counts`) inherit organization scope via foreign key to their parent — RLS policies join through the parent table.

**organizations**
```
id              UUID, primary key
name            TEXT (e.g., 'Pennie')
slug            TEXT, unique (used in URLs and Cloudflare secret namespacing)
created_at      TIMESTAMPTZ
```

Even with a single organization today, this table is the RLS anchor — every `organization_id` FK on every other table points here. Supabase RLS policies match `organization_id` against the user's org claim in their JWT.

**users**
```
id              UUID, primary key (matches auth.users.id from Supabase Auth)
organization_id UUID (ref: organizations)
email           TEXT
display_name    TEXT (shown in audit logs, version history, and "last updated by" labels)
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

This is the application-level user record, linked 1:1 to `auth.users` via matching `id`. Supabase Auth handles authentication (Google SSO, JWT issuance). This table adds organization membership and display name for UI attribution. All authenticated users have full access to all features — there is no role-based access control. The two user profiles (ops/engineer) described in Section 1.3 reflect how people naturally use the tool, not enforced permissions.

**workflows**
```
id              UUID, primary key
organization_id UUID (ref: organizations — RLS scoping)
name            TEXT
description     TEXT
definition      JSONB (full workflow graph)
is_active       BOOLEAN
created_by      UUID (ref: users)
updated_by      UUID (ref: users)
updated_by_email TEXT (denormalized — email of the user who last modified)
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

**workflow_versions**
```
id              UUID, primary key
workflow_id     UUID (ref: workflows)
version_number  INTEGER
definition      JSONB (snapshot of workflow graph)
commit_sha      TEXT (GitHub commit hash)
created_by      UUID (ref: users)
created_at      TIMESTAMPTZ
message         TEXT (optional change description)
```

**workflow_executions**
```
id                    UUID, primary key
workflow_id           UUID (ref: workflows)
workflow_version_id   UUID (ref: workflow_versions — which version was actually executed)
parent_execution_id   UUID (nullable, ref: workflow_executions)
source                TEXT (nullable — e.g., 'wallet_owl', 'reserve', 'website_form'; derived from API key at request time)
trigger_type          TEXT (http_webhook)
trigger_payload       JSONB
status                TEXT (running, completed, failed, exited)
started_at            TIMESTAMPTZ
completed_at          TIMESTAMPTZ
duration_ms           INTEGER
response_body         JSONB
error_message         TEXT
trace_id              TEXT
```

> **Retention:** JSONB payloads (`trigger_payload`, `response_body`) are compacted after 14 days; rows are purged after 90 days. See Section 10.4.

**execution_steps**
```
id              UUID, primary key
execution_id    UUID (ref: workflow_executions)
step_namespace  TEXT (e.g., 'equifax_credit_report')
step_type       TEXT (code, filter, branch, parallel, partner_bid, integration, transform, bid_evaluation, response, exit)
status          TEXT (running, completed, failed, skipped, failed_with_fallback)
input           JSONB
output          JSONB
error_message   TEXT
error_type      TEXT (nullable — transient, permanent, null if no error)
retries_used    INTEGER (default 0)
started_at      TIMESTAMPTZ
completed_at    TIMESTAMPTZ
duration_ms     INTEGER
step_order      INTEGER
parallel_group_id TEXT (nullable — set to the parent parallel node's ID when this step is part of a parallel fan-out, null for sequential steps)
```

> **Retention:** JSONB payloads (`input`, `output`) are compacted after 14 days; rows are purged after 90 days. See Section 10.4.

**environment_variables**
```
id              UUID, primary key
organization_id UUID (ref: organizations — RLS scoping)
key             TEXT
value           TEXT (nullable — populated for config variables, null for secrets)
is_secret       BOOLEAN (if true, value lives in Cloudflare Worker secrets, not here)
scope           TEXT (global, workflow)
workflow_id     UUID (nullable, ref: workflows)
created_by      UUID (ref: users)
created_at      TIMESTAMPTZ
updated_by      UUID (ref: users)
updated_by_email TEXT (denormalized — email of the user who last modified)
updated_at      TIMESTAMPTZ
```

**service_connections**
```
id              UUID, primary key
organization_id UUID (ref: organizations — RLS scoping)
service_type    TEXT (salesforce, supabase, snowflake)
auth_type       TEXT (oauth — token-based with refresh, e.g., Salesforce; api_key — single key in a header, e.g., Supabase service role key; credentials — username/password pair, e.g., Equifax API basic auth)
cf_secret_key   TEXT (name of the Cloudflare Worker secret holding credentials)
user_id         UUID (nullable — null means shared)
schema_cache    JSONB
schema_synced   TIMESTAMPTZ
created_at      TIMESTAMPTZ
updated_by      UUID (ref: users)
updated_by_email TEXT (denormalized — email of the user who last modified)
updated_at      TIMESTAMPTZ
```

**partner_configs**
```
id              UUID, primary key
organization_id UUID (ref: organizations — RLS scoping)
name            TEXT (e.g., 'Tripoint', 'M1')
slug            TEXT, unique (e.g., 'tripoint', 'm1' — lowercase, URL-safe. Used in Durable Object IDs, node configs, and logs. Database FKs use the UUID; all external references use the slug.)
api_endpoint    TEXT
cf_secret_key   TEXT (name of the Cloudflare Worker secret holding auth config)
daily_cap       INTEGER (nullable)
min_bid         DECIMAL (nullable)
bid_formula     TEXT (e.g., 'debt_amount * 0.65')
dedup_endpoint  TEXT (nullable)
response_classification JSONB (nullable — per-partner signal overrides, see Section 11.2)
alert_config    JSONB (nullable — per-partner alert tuning, see Section 11.5)
circuit_error_threshold  INTEGER (default 5 — errors in window to trip circuit)
circuit_window_seconds   INTEGER (default 60 — sliding window size)
circuit_cooldown_seconds INTEGER (default 300 — cooldown before half-open)
circuit_enabled BOOLEAN (default true)
is_active       BOOLEAN
priority        INTEGER (ordering for fallback)
created_at      TIMESTAMPTZ
updated_by      UUID (ref: users)
updated_by_email TEXT (denormalized — email of the user who last modified)
updated_at      TIMESTAMPTZ
```

**partner_daily_counts** *(reporting only — cap enforcement is in Durable Objects)*
```
id              UUID, primary key
partner_id      UUID (ref: partner_configs)
date            DATE
count           INTEGER
updated_at      TIMESTAMPTZ
```

**audit_log**
```
id              UUID, primary key
organization_id UUID (ref: organizations — RLS scoping)
entity_type     TEXT (partner_config, environment_variable, service_connection, workflow, circuit_breaker)
entity_id       UUID (ref to the modified record)
action          TEXT (created, updated, deleted, circuit_force_closed, secret_rotated)
changed_by      UUID (ref: users)
changes         JSONB (before/after snapshot of changed fields — secret values are never stored, only key names)
changed_at      TIMESTAMPTZ
```

Every mutation to partner configs, environment variables, service connections, and circuit breaker overrides writes a row to this table. The `changes` JSONB captures the before/after for each modified field (e.g., `{ "daily_cap": { "before": 250, "after": 500 }, "changed_by_name": "Dan" }`). For secrets, only the key name and the fact that it was rotated are logged — never the value.

Workflow definition changes are already captured in `workflow_versions` with full definition snapshots. The audit log covers everything else.

The audit log is append-only — rows are never updated or deleted. It is queryable from the UI on the partner management page, the environment variables page, and a dedicated audit log view accessible to all users.

---

## 4. Workflow Definition Schema

A workflow definition is a JSON document that fully describes the graph. This is what's stored in the `definition` column and what the canvas editor reads/writes.

```json
{
  "id": "wf_abc123",
  "name": "Main Credit Decisioning",
  "trigger": {
    "type": "http_webhook",
    "config": {
      "method": "POST",
      "custom_response": true,
      "auth_method": "api_key",
      "idempotency": {
        "enabled": true,
        "derive_from_fields": ["personalInformation.email", "personalInformation.ssnLast4", "loanAmount"],
        "ttl_seconds": 300
      }
    }
  },
  "nodes": [
    {
      "id": "node_1",
      "namespace": "validate_lead",
      "type": "code",
      "position": { "x": 250, "y": 100 },
      "config": {
        "code": "...",
        "timeout_ms": 5000,
        "retries": 0
      },
      "variables": {}
    },
    {
      "id": "node_2",
      "namespace": "equifax_credit_report",
      "type": "integration",
      "position": { "x": 250, "y": 250 },
      "config": {
        "service": "equifax",
        "action": "pull_credit_report",
        "timeout_ms": 10000,
        "retries": 1,
        "retry_backoff": "exponential",
        "on_error": "fallback",
        "fallback_node": "node_eligibility_scout"
      },
      "variables": {
        "equifaxUsername": "{{env.EQUIFAX_USERNAME}}",
        "equifaxPassword": "{{env.EQUIFAX_PASSWORD}}"
      }
    },
    {
      "id": "node_3",
      "namespace": "partner_bids",
      "type": "parallel",
      "position": { "x": 250, "y": 400 },
      "config": {
        "wait_for": "all",
        "timeout_ms": 15000
      },
      "children": ["node_3a", "node_3b"]
    },
    {
      "id": "node_3a",
      "namespace": "bid_tripoint",
      "type": "partner_bid",
      "parent": "node_3",
      "config": {
        "partner": "tripoint",
        "dedup_check": true
      }
    },
    {
      "id": "node_3b",
      "namespace": "bid_m1",
      "type": "partner_bid",
      "parent": "node_3",
      "config": {
        "partner": "m1",
        "dedup_check": false
      }
    },
    {
      "id": "node_4",
      "namespace": "pick_winner",
      "type": "bid_evaluation",
      "position": { "x": 250, "y": 550 },
      "config": {
        "strategy": "highest_bid",
        "min_bid_threshold": null,
        "tiebreaker": "partner_priority",
        "fallback_partner": "engine",
        "no_winner_behavior": "exit"
      }
    },
    {
      "id": "node_5",
      "namespace": "respond",
      "type": "response",
      "position": { "x": 250, "y": 700 },
      "config": {
        "status": 200,
        "body": "{{steps.pick_winner.output}}"
      }
    }
  ],
  "edges": [
    { "from": "trigger", "to": "node_1" },
    {
      "from": "node_1",
      "to": "node_2",
      "condition": {
        "rules": {
          "t": "and",
          "r": [
            { "a": "{{trigger.body.personalInformation.state}}", "op": "str!=", "b": "MN" },
            { "a": "{{trigger.body.personalInformation.state}}", "op": "str!=", "b": "OR" }
          ]
        }
      }
    },
    {
      "from": "node_1",
      "to": "exit",
      "condition": {
        "type": "else"
      },
      "exit_response": {
        "status": 200,
        "body": { "status": "rejected", "reason": "ineligible_state" }
      }
    },
    { "from": "node_2", "to": "node_3" },
    { "from": "node_3", "to": "node_4" },
    { "from": "node_4", "to": "node_5" }
  ]
}
```

### 4.1 Edge Schema

Edges are the single source of truth for the graph topology. Every connection between nodes — unconditional, conditional, and fallback — is an edge. There is no separate `branches` array.

**Edge types:**

- **Unconditional:** `{ "from": "node_1", "to": "node_2" }` — execution always follows this edge.
- **Conditional:** `{ "from": "node_1", "to": "node_2", "condition": { "rules": {...} } }` — execution follows this edge only if the condition passes. Uses the same rule format as filter/branch node configuration.
- **Else:** `{ "from": "node_1", "to": "exit", "condition": { "type": "else" } }` — followed when no other conditional edge from this node passes. At most one else edge per source node.
- **Fallback:** Specified per-node via `on_error: "fallback"` and `fallback_node` in the node config (Section 11.3). Not represented as an edge in the definition — fallback routing is an error-handling mechanism, not a data-flow decision.

When a node has multiple outgoing edges, the engine evaluates conditional edges in array order. The first edge whose condition passes is followed. If no conditional edge passes and an else edge exists, it is followed. If no edge matches and no else exists, the workflow fails with a routing error.

Filter and branch nodes in the visual editor are convenience wrappers — they generate conditional edges on the canvas. In the stored definition, the conditions live on the edges, not on a separate structure.

### 4.2 Node Types

| Type | Description | Visual Representation | Used By |
|---|---|---|---|
| `code` | Custom JavaScript/TypeScript logic | Code editor panel | Engineers |
| `filter` | Pass/exit gate — a branch constrained to two outputs (continue or exit). Visual shortcut for the most common routing pattern. | Rule builder UI with pass/exit | Both |
| `branch` | General-purpose multi-path routing with N conditional outputs. Filter and branch both produce conditional edges (Section 4.1) — the distinction is purely visual. | Diamond shape with labeled paths | Both |
| `parallel` | Fan-out to multiple children simultaneously | Horizontal split showing parallel lanes | Both |
| `partner_bid` | Hit a partner API for a bid (with dedup, caps, thresholds) | Partner card with status indicators | Ops via config |
| `integration` | Call an external service (Equifax, Salesforce, etc.) | Service icon with field mapping | Both |
| `response` | Send HTTP response back to caller | Terminal node | Both |
| `transform` | Map/reshape data between steps | Field mapping UI | Both |
| `bid_evaluation` | Select winning bid from parallel partner results | Strategy dropdown with config | Ops via config |
| `exit` | End workflow early with optional response | Stop sign icon | Both |

### 4.3 Data References

Steps reference data from previous steps using template syntax:

```
{{trigger.body.personalInformation.firstName}}
{{steps.equifax_credit_report.output.data.consumers}}
{{steps.pick_winner.output.winner.amount}}
{{env.EQUIFAX_USERNAME}}
{{workflow.config.multiplier}}
```

The canvas editor provides autocomplete for these references based on the known output schema of upstream steps and connected service schemas.

---

## 5. Node Type Details

### 5.1 Filter and Branch Nodes

Filter and branch are both visual wrappers for conditional edges (Section 4.1). They share the same rule builder, the same operator set, and the same underlying representation in the workflow definition. The distinction is purely a UX convenience — a filter is a branch constrained to exactly two outputs.

**Filter:** The common case. "Does this lead pass?" Two outputs: continue (conditional edge to the next node) or exit (else edge to an exit node with a configured response). Optimized for the pattern where ops users add a quick gate — state eligibility, minimum loan amount, name validation — without thinking about graph topology.

**Branch:** The general case. N conditional outputs, each with its own rule set, plus an optional else. Used when execution needs to take genuinely different paths — e.g., route high-credit leads to one enrichment flow and low-credit leads to another.

**In the stored definition,** both produce conditional edges. A filter node with "pass or exit on ineligible state" becomes two edges from that node: one conditional edge (state rules pass → next node) and one else edge (→ exit with rejection response). A branch node with three paths becomes three conditional edges (plus an optional else edge). The execution engine doesn't distinguish between them — it just evaluates the edges.

**Shared operator set (inherited from the existing Pipedream filter component):**

**String:** equals, not equals, contains, not contains, starts with, ends with, is blank, is not blank (all with optional case sensitivity)

**Number:** equals, not equals, greater than, greater than or equal, less than, less than or equal

**Boolean:** is true, is false, equals

**Existence:** exists, not exists, is null, is not null

**Type:** is string, is number, is boolean (and negations)

Rules can be grouped with AND/OR logic, and groups can be nested.

**Visual UI (filter):** Each rule is a row with three dropdowns (field reference, operator, comparison value). Groups are visually nested with AND/OR toggles. Two fixed outputs: pass and exit. Non-technical users can build complex conditions without writing code.

**Visual UI (branch):** Diamond-shaped node on the canvas with labeled output edges. Each edge shows a summary of its conditions. Users can add/remove output paths.

### 5.2 Parallel Node

Groups multiple child nodes and executes them simultaneously using `Promise.allSettled()`. Each child result is inspected individually — a failed child doesn't abort the others. Downstream logic receives both successes and failures. Configurable options:

- **wait_for:** `all` or `first`
  - `all`: Uses `Promise.allSettled()` directly. Waits for every child to resolve or reject. Downstream receives the full array of results (each marked `fulfilled` or `rejected`).
  - `first`: Wraps children in a custom race — each child is tracked individually. As soon as one fulfills successfully, its result is passed downstream and remaining children are abandoned (their in-flight fetches complete in the background but results are discarded). If all children reject, the node fails.
- **timeout_ms:** Maximum wall-clock time to wait for children.
- **on_timeout:** `partial` or `fail` (applies when `wait_for` is `all`)
  - `partial`: When the timeout fires before all children settle, the engine collects whatever results have settled so far and passes them downstream. Unsettled children are recorded as `{ status: "timeout" }` in the results array.
  - `fail`: The entire parallel node fails if any child hasn't settled by the timeout.
  - When `wait_for` is `first`: `on_timeout` is ignored. If the timeout fires before any child succeeds, the parallel node fails (same as if all children rejected). There is no partial result in `first` mode — either one child wins or the node fails.

**Visual UI:** Horizontal fork in the canvas showing parallel lanes that reconverge at a merge point.

### 5.3 Partner Bid Node

A specialized node type for the core bidding use case. Wraps the common pattern of: check circuit breaker → check caps → dedup → call partner API → report outcome to circuit breaker → evaluate response → return bid. Configuration is entirely visual:

- **Partner:** Select from configured partners
- **Dedup check:** Toggle on/off, auto-uses the partner's dedup endpoint
- **Daily cap:** Inherits from partner config, can be overridden per-workflow
- **Min bid threshold:** Inherits from partner config, can be overridden
- **Bid formula:** Expression for calculating bid value (see below)
- **Timeout:** Per-partner timeout

**Bid formula language:** Bid formulas are evaluated using a sandboxed expression parser (e.g., [expr-eval](https://github.com/silentmatt/expr-eval) or [mathjs](https://mathjs.org/) expression mode) — never `eval()`. The parser supports arithmetic operators (`+`, `-`, `*`, `/`), comparison operators, parentheses, and a fixed set of variables injected from the execution context:

- `debt_amount` — total debt from the enrichment step
- `credit_score` — credit score from the credit pull
- `loan_amount` — requested loan amount from the trigger payload
- `bid_amount` — the raw bid returned by the partner API
- `partner_response.*` — access to any field in the partner's response

Examples: `debt_amount * 0.65`, `bid_amount - 2.50`, `min(bid_amount, loan_amount * 0.10)`

Built-in functions: `min()`, `max()`, `round()`, `floor()`, `ceil()`, `abs()`. No access to `fetch`, `eval`, environment variables, or any side effects. The formula is pure math on known inputs.

The partner management UI provides a formula preview — ops users enter a formula and see it evaluated against a sample lead to verify the output before saving.

**Two bid models:**

- **Formula-only** — the bid value is calculated locally from the bid formula, without any `bid_amount` from the partner's API response. The API call serves other purposes (dedup check, lead posting). Example: Tripoint's value = `debt_amount * 0.65`.
- **API-returned** — the partner's API response includes a bid amount. The bid formula can transform it (e.g., `bid_amount - 2.50`) or pass it through as-is (`bid_amount`).

The `bid_formula` field handles both models: if the formula references `bid_amount`, it uses the value from the API response; if it only references enrichment data (`debt_amount`, `credit_score`, `loan_amount`), it's formula-only and the API response is irrelevant to bid calculation.

This node reads from the `partner_configs` table and applies all rules automatically. Ops users can add a new partner by configuring it in the partner management UI — no code changes needed.

### 5.4 Code Node

Full inline code editor for custom JavaScript logic. Code nodes are the escape hatch — anything that can't be expressed visually goes here.

**Editor:**
- Monaco editor (same as VS Code) with syntax highlighting
- Autocomplete for `steps.*` references and `env.*` variables
- Access to step inputs and outputs
- Console logging (captured in execution logs)
- Error handling with try/catch

**Execution via Dynamic Workers:**

Code nodes do NOT run inline in the orchestration Worker. Each Code node execution is loaded as a **Cloudflare Dynamic Worker** — an isolated V8 sandbox with millisecond startup and no performance penalty.

```javascript
let worker = env.LOADER.load({
  compatibilityDate: "2026-03-01",
  mainModule: "code_node.js",
  modules: { "code_node.js": node.config.code },
  env: { steps: stepContext, env: envVars },
  globalOutbound: outboundProxy  // controlled, not unrestricted
});
let result = await worker.getEntrypoint().run(input);
```

**Security boundary:**

- **Network control via `globalOutbound`:** By default, Code nodes have no direct internet access (`globalOutbound: null`). If a Code node needs to make HTTP requests (e.g., calling a partner API not covered by the Integration node), the workflow config can enable a controlled outbound proxy that:
  - Restricts requests to a domain allowlist configured per-workflow
  - Injects credentials server-side — the Code node never sees raw API keys
  - Logs all outbound requests for audit
- **Isolation:** Each Code node runs in its own V8 isolate. It cannot access the orchestration Worker's memory, other steps' in-flight data, or Cloudflare bindings (KV, DOs, secrets) unless explicitly passed via the `env` parameter.
- **Data access:** The Code node receives only its declared inputs (`steps.*` references and `env.*` variables). It cannot reach into arbitrary step outputs that weren't wired to it.

**Cost:** $0.002 per unique Code node definition loaded per day. With typical workflows having 2-5 Code nodes, this is ~$0.01/day — negligible compared to inference or API costs.

**What this means for users:** Code nodes feel the same — write JavaScript, reference step data, return a result. The sandboxing is invisible. The difference is that a buggy or malicious Code node can't exfiltrate data, call arbitrary endpoints, or crash the orchestration Worker.

### 5.5 Integration Node

Pre-built connector to an external service with schema-aware field mapping. The node knows the service's API and presents a visual configuration:

- **Service:** Salesforce, Supabase, Snowflake, Equifax, Eligibility Scout, LendSwift
- **Action:** Create record, query records, pull credit report, etc.
- **Field mapping:** Dropdowns populated from the service's schema
- **Auth:** Uses the configured service connection (per-user or shared)

### 5.6 Response Node

Constructs and sends the HTTP response back to the caller. Configuration:

- **Status code:** 200, 400, 500, etc.
- **Headers:** Key-value pairs
- **Body:** JSON template with data references

### 5.7 Transform Node

Visual data reshaping without writing code. The Transform node takes the output of any prior step and produces a new object with renamed, extracted, restructured, or filtered fields. Useful for normalizing partner API responses into a common shape, preparing payloads for downstream steps, or stripping unnecessary fields before a response.

**Configuration UI:**

The config panel shows a two-column mapping table:

| Source (left) | Target (right) |
|---|---|
| `steps.equifax.output.creditReport.score` | `credit_score` |
| `steps.validate_lead.output.personalInformation.firstName` | `first_name` |
| `"active"` | `status` |
| `steps.pick_winner.output.winner.amount * 0.85` | `adjusted_bid` |

- **Left column (source):** A dot-path reference to a prior step's output, a literal value (quoted string or number), or a simple expression
- **Right column (target):** The key name in the output object. Supports dot-paths for nested output (e.g., `applicant.name` creates `{ applicant: { name: ... } }`)
- Rows are added/removed with + / - buttons
- Autocomplete on the source column, populated from the schemas of prior steps' outputs

**Supported operations:**

- **Field rename:** Map `steps.x.output.oldName` → `newName`
- **Nested extraction:** Pull a deeply nested field to a top-level key, or the reverse
- **Static values:** Inject a hardcoded string, number, or boolean (e.g., `"v2"` → `api_version`)
- **Simple expressions:** Basic arithmetic and string concatenation on source values (e.g., `steps.bid.output.amount * 0.85`). Parsed by the same sandboxed expression evaluator used for bid formulas (Section 5.3) — no `eval()`, no arbitrary code
- **Drop fields:** Anything not mapped is excluded from the output. The transform is explicit — only mapped fields appear in the result
- **Array access:** Dot-path supports array indexing (e.g., `tradelines[0].balance`) and `[*]` for mapping over arrays (e.g., `tradelines[*].balance` → `balances` produces an array of all balance values)

**What it doesn't do:**

- Complex conditional logic (use Branch + Code nodes)
- HTTP requests or side effects (use Code or Integration nodes)
- Type coercion beyond what expressions handle (use Code node)

**Output:** A single JSONB object assembled from the mapping rows. Available to downstream steps as `steps.<transform_namespace>.output`.

**Example config (stored in definition JSONB):**
```json
{
  "type": "transform",
  "namespace": "normalize_credit",
  "config": {
    "mappings": [
      { "source": "steps.equifax.output.creditReport.score", "target": "credit_score" },
      { "source": "steps.equifax.output.creditReport.tradelines[*].balance", "target": "trade_balances" },
      { "source": "steps.validate_lead.output.personalInformation.firstName", "target": "first_name" },
      { "source": "steps.validate_lead.output.personalInformation.lastName", "target": "last_name" },
      { "source": "steps.validate_lead.output.loanAmount", "target": "requested_amount" },
      { "source": "\"pending\"", "target": "review_status" }
    ]
  }
}
```

### 5.8 Bid Evaluation Node

Receives the results of a Parallel node containing Partner Bid children and selects the winning bid. This is the core routing decision — the reason the system exists.

**Selection strategies** (dropdown in config panel):

- **Highest bid** — highest `amount` wins. The default and most common strategy.
- **Weighted score** — configurable formula combining bid amount with partner performance metrics: `(bid_amount * weight_bid) + (acceptance_rate * weight_acceptance) - (avg_response_ms * weight_speed)`.

  **Metrics:**
  - `acceptance_rate` — ratio of bids accepted to bids sent (`accepted / sent`) over a rolling 30-day window, calculated from `partner_daily_counts` and execution history
  - `avg_response_ms` — mean partner API response time over the same 30-day window, calculated from `execution_steps.duration_ms` for that partner's bid steps
  - Partners with fewer than 10 bids in the window default to `acceptance_rate = 0.5` and `avg_response_ms = 5000` (neutral assumptions that don't unfairly advantage or penalize new partners)

  **Weight configuration:** Three weight sliders on the Bid Evaluation node config panel, each a decimal between 0 and 1. Weights do not need to sum to 1 — they're independent multipliers. The UI shows a live preview of how each active partner would score against a sample lead.

**Additional configuration** (all visual, no code):

- **Minimum bid threshold** — bids below this amount are excluded before evaluation. Overrides per-partner `min_bid` from `partner_configs` if set.
- **Tiebreaker** — when two bids are equal: `partner_priority` (from `partner_configs.priority`) or `fastest_response` (lowest `duration_ms`)
- **Fallback partner** — if all bids are excluded (below threshold, all errored, all rejected), route to this partner unconditionally (e.g., Engine as the catch-all). The fallback partner is *not* part of the parallel fan-out — no bid is solicited from it. The lead is simply posted to it when no direct partner wins.
- **No-winner behavior** — if no fallback is configured and no bids qualify: `fail` (execution fails with error) or `exit` (respond with rejection to caller)

**Input contract:** Expects `steps.<parallel_node>.output` — an array of Partner Bid node results, each with `{ status: "bid"|"rejected"|"error", amount, partner_id, raw, ... }` as defined in Section 11.4.

**Output:** The full bid landscape is preserved for logging and debugging:
```json
{
  "winner": { "partner_id": "tripoint", "amount": 45.00, "raw": {...} },
  "all_bids": [...],
  "excluded": [...],
  "reason": "highest_bid"
}
```

If no winner is selected (fallback or exit), `winner` is `null` and `reason` explains why (e.g., `"all_below_threshold"`, `"all_rejected"`, `"all_errored"`).

**Example config (stored in definition JSONB):**
```json
{
  "type": "bid_evaluation",
  "namespace": "pick_winner",
  "config": {
    "strategy": "highest_bid",
    "min_bid_threshold": null,
    "tiebreaker": "partner_priority",
    "fallback_partner": "engine",
    "no_winner_behavior": "exit"
  }
}
```

---

## 6. Frontend Features

### 6.1 Canvas Editor

Built with **React Flow** on Next.js. The canvas is the primary interface for building and editing workflows.

**Core interactions:**
- Drag nodes from a sidebar palette onto the canvas
- Connect nodes by dragging edges between ports
- Click a node to open its configuration panel (right sidebar)
- Zoom, pan, and minimap for navigation
- Undo/redo
- Copy/paste nodes (within a workflow and across workflows — pasted nodes are independent copies, not shared references)
- Auto-layout for imported workflows

**Node sidebar palette categories:**
- Logic: Filter, Branch, Parallel
- Actions: Code, Integration, Partner Bid, Bid Evaluation, Transform
- Flow: Response, Exit
- Partners: Pre-configured partner bid nodes (one per active partner)

### 6.2 Step Configuration Panel

When a node is selected, the right sidebar shows its configuration. The panel adapts to the node type:

- **Filter/Branch:** Rule builder UI
- **Code:** Monaco editor
- **Integration:** Service selector → action selector → field mapping with autocomplete
- **Partner Bid:** Partner dropdown, cap/threshold overrides, bid formula
- **Response:** Status code, headers, body template editor

### 6.3 Workflow Settings Panel

Accessed via a gear icon. Contains:

- **Workflow name and description**
- **Trigger configuration** (webhook URL, method)
- **Workflow-level variables** (key-value pairs used across steps)
- **Environment variable references** (links to global secrets)

### 6.4 Partner Management

A dedicated page (not on the canvas) for managing partner configurations:

- Add/edit/remove partners
- Configure API endpoint, auth credentials, dedup endpoint
- Set default daily caps and minimum bid thresholds
- Define bid formulas
- Toggle partners active/inactive
- Configure circuit breaker thresholds (error count, window, cooldown)
- View circuit breaker status (closed/open/half-open) with manual override to force-close
- View partner performance (bids sent, accepted, rejected, revenue)

#### 6.4.1 Partners page redesign (#2114, settled 2026-10-14)

The settled design is [docs/design/partners-page.html](./docs/design/partners-page.html): every state of the page, with each decision and its reason. These are the requirements it carries beyond appearance.

- **PM-1 Layout.** One tab at a time, showing only the tabs that apply: Partner, Buyer profile (always, for a buyer), Bid Group (when a workflow's Bid Group names the partner or any Bid Group setting is set), Workflow values and History. A source partner has Partner, Workflow values and History. The partner list is grouped into Buyers and Sources, alphabetical, name only; list order is removed.
- **PM-2 Live merge.** While a person edits, a save by someone else updates every field they have not touched, live.
- **PM-3 Field level merge.** Only a field both people changed asks a question, grouped by section, with Keep yours or Use theirs; saving keeps those choices and adds the rest of the other save. This replaces "Take theirs", which discards every edit.
- **PM-4 Save bar.** The dark bar appears only when something is edited and names the change; it shows Saving with elapsed seconds, then Saved with Undo, then leaves. A failure stays, says why, and offers Try again. A refused save names the field and tab with Show me, and marks the tab and the field red.
- **PM-5 Leaving with unsaved changes.** On in app navigation, an in page dialog (never the browser's) with Keep editing, Discard and open the other partner, Save and open it. On a refresh or a closed tab, the browser's own leave warning, because browsers allow no page dialog there (Dan, 2026-10-15).
- **PM-6 Click delivery changes.** No second confirmation: the save bar states the consequence by route name (for example, clicks from WY will go to DI4 instead of DV1) beside the one Save button.
- **PM-7 Mark sent without a lead id.** The partner's lead id is optional when marking a held click sent. Without it the click is counted and Salesforce marks the sale Completed with no partner lead id.
- **PM-8 Salesforce retry.** A held click marked sent whose Salesforce update was incomplete lists every record with its result and Salesforce's own words, with Retry Salesforce and Remove from the list (which asks first).
- **PM-9 Bid mode removed.** The Commit and Ping only setting leaves the page. Nothing acts on it: the Partner Bid step used to copy it into its resolved input and ran the same path either way. Since #2182 nothing reads or writes it, and a later migration drops the column.
- **PM-10 Display time zone.** A buyer profile stores a time zone used only for display. Hours stay stored and judged in Eastern. Stored as `buyer_profiles.display_time_zone`, one of the four zones in `DISPLAY_TIME_ZONES` (`packages/buyer-profile/src/clock.ts`), NULL shown as Eastern (#2143).
- **PM-11 Default error rules shown.** The built in retry and never retry answers appear as fixed rows marked Default; a person's own rules are checked first, and each list has its own Alert switch. The rows are `DEFAULT_ERROR_RULES` (`packages/buyer-profile/src/error-rules.ts`), which the engine's classifier reads its decisions from; `defaultErrorRowsFor` picks the ones that apply to a partner's calls (#2143).
- **PM-12 Problems open where they are.** A partner with an issue (a missing credential, a refused field) opens on the tab holding it, with red dots on its list row and that tab.
- **PM-13 Delete.** In a pale red box at the foot of the Partner tab, confirmed by typing DELETE (case sensitive); the consequence names only what the partner has. When sales refer to the partner, the box says why it cannot be deleted, with no field, and that turning off Active stops it. The page knows this before offering Delete.
- **PM-14 Editors by name.** History groups changes by day with the time and the editor's name resolved from the users table, the old value struck through and the new one in bold.
- **PM-15 Workflow values tab.** Each value workflows read by name, with that exact name and the workflows that read it. The click URL moves here from the Sale row.
- **PM-16 Colour.** Navy #1D212F marks a selection; blue #1B72BA is for buttons only; red is reserved for a genuine problem. Grey hint and secondary text is the `hint` token, #697081, which clears WCAG AA on the beige page (Dan, 2026-10-16). The rule holds on the partners page now (#2144, enforced by `partner-page-colour-guard.test.ts`); the rest of the app is #2126 (see `.impeccable.md`).
- **PM-17 Density and controls.** Compact: each section is a row, its name in a 124px column on the left and its settings 14px beside it starting on the name's first line, with a thin rule between sections (`PartnerSection`). Controls are outlined white boxes with a thin beige line and rounded corners. The header is the name and slug; Discard changes lives only in the save bar. The partner list is 198px wide with rows about 31px apart, and the tabs fit on one line. Add links, All and None are dark and a remove mark is a grey minus (`RemoveButton`); blue stays for buttons. `partner-page-density-guard.test.ts` holds the section row, the dark links and the remove mark (#2317).
- **PM-18 Page states.** Nothing selected: a short bold prompt to pick a partner or create one. Loading: beige placeholder bars with a moving shimmer in the list and the right side empty; the list read gives up after 30 seconds. Could not be loaded: the right side says the partners could not be loaded, why in words (a timeout by its ceiling, a server error by its status, an unreachable server), that nothing has changed, and offers Try again; the list is never shown as empty. New partner: its own page asking only the name, the slug and what it does (Sends us leads, Buys leads, either or both), with Cancel and Create partner in the dark bar; Create partner waits until it does at least one (#2321).
- **PM-19 Save bar and dialogs, as drawn.** The Saved bar slides away after Undo. A failed save says why in words: the route's own sentence, or the cause the page measured (a timeout by its ceiling, a server error by its status, an unreachable server), never the server's bare code. The leave dialog's three buttons sit on one line (600px). The merge dialog (600px) says nothing is lost and groups the changes: only you changed (kept) and only they changed (added), each with its value before and after, then what you both changed, one line each, yours then theirs, with Keep yours chosen to start so Save both is ready; a combination the save would refuse is never chosen for the person. No save bar shows behind the dialog (#2322).
- **PM-20 Partner tab.** Rows: Name in a white box with no hint; Does as two boxes, Sends us leads and Buys leads, where for a saved partner the last box ticked cannot be unticked, so the boxes always say what is stored (the same control as the new partner page, `DoesChoice`); Active, On or Off, with one line saying what off means ("Off: Bidspoke offers Liberty1 no leads through any step, and workflows see it as inactive."); and for a buyer, Sold through as flat rows, Set up or its button beside each label. The registry's sections follow the rows (Name, Does, Active), and the merge and live notes say Active as On or Off (#2323).

### 6.5 Test Runner

A panel that lets users execute a workflow with a sample payload and watch it step through in real time.

**How it works:**
1. User clicks "Test" and pastes a JSON payload (or selects from saved test payloads)
2. The workflow executes step by step
3. Each node on the canvas lights up as it runs: gray (pending) → blue (running) → green (success) → red (failed)
4. Clicking a completed node shows its input/output in the side panel
5. If a step fails, the error is displayed inline with the option to "Edit and re-run from here"

**Saved test payloads:** Users can save payloads for reuse. Each workflow can have multiple saved payloads (e.g., "happy path," "low credit score," "duplicate lead").

**Resume from failed step:** When a production execution fails, users can click "Resume from failed step" on the execution history row. The engine loads all successfully completed steps from the original execution, pre-populates the execution context with their stored outputs, and begins execution at the failed step. Prior steps are not re-executed — no duplicate Salesforce creates, credit pulls, or partner bids. The canvas shows skipped steps (gray with checkmark) and freshly executed steps (blue → green/red) so it's clear what ran vs. what was carried over.

**Replay from start:** A secondary option on failed executions. Re-executes the full workflow from step 1 with the original trigger payload. Creates a new execution record with no pre-loaded context. Useful when a bug fix affects early steps.

### 6.6 Execution History

A table view showing all workflow executions with:

- Timestamp
- Workflow name
- Status (success, failed, exited early)
- Duration
- Trigger summary (e.g., lead UUID)
- Error message (if failed)

Clicking a row opens the execution detail view:

- Full step-by-step timeline
- Each step's input/output
- Duration per step
- Visual highlight on the canvas showing which path executed

### 6.7 Version History

Accessed per-workflow. Shows a list of all saved versions:

- Version number
- Who saved it
- When
- Change message (optional)
- GitHub commit link

Users can preview any version (read-only canvas view) and restore it with one click. Restoring creates a new version (doesn't delete history).

### 6.8 Environment Variables & Secrets

A settings page for managing variables and secrets:

**Global variables:** Available across all workflows. Used for API keys, service credentials, and shared configuration.

**Workflow variables:** Scoped to a single workflow. Used for workflow-specific configuration (multiplier values, state lists, feature flags).

**Secrets** (API keys, passwords, OAuth tokens) are stored as Cloudflare Worker secrets via the Cloudflare API. They are encrypted at rest by Cloudflare and injected into the Worker's `env` binding at runtime — zero-latency access, no network call, no decryption logic to manage. When a user creates or updates a secret in the UI, the backend writes the value to Cloudflare via API and stores only the key name, scope, and audit metadata in Supabase (the `environment_variables` table). Secret values are never stored in Supabase and never displayed in the UI after creation. Updating a secret triggers a Worker redeployment via the Cloudflare API to pick up the new value.

**Configuration variables** (multiplier values, state lists, non-sensitive settings) are stored in the `environment_variables` table in Supabase and loaded alongside the workflow definition via Workers KV cache. No encryption needed.

---

## 7. Pipedream Import

### 7.1 Requirements

Users paste the raw JSON export of a Pipedream workflow. The tool parses it and reconstructs the workflow on the canvas with 1:1 fidelity — every step, every connection, every configuration.

### 7.2 Import Process

1. User clicks "Import from Pipedream" and pastes JSON
2. The parser identifies the trigger type and creates the trigger node
3. Each step in the `steps` array is parsed:
   - `namespace` → node namespace
   - `savedComponent.code` → code content
   - `savedComponent.configurableProps` → step variables
   - `savedComponent.apps` → service connections
   - Control flow components (`_filter`, `_controlFlow`) → filter/branch nodes with rule configuration extracted
4. Edges are created based on step order and control flow routing
5. The workflow is rendered on the canvas with auto-layout
6. A validation report highlights anything that needs manual attention

### 7.3 Component Mapping

| Pipedream Pattern | Mapped To |
|---|---|
| `_filter` prop with `evalRuleGroup` | Filter node with visual rule builder |
| `_controlFlow` prop with `ifelse` type | Branch node with conditions |
| `$.flow.exit()` | Exit node |
| `$.respond()` | Response node |
| `$.flow.trigger()` (sub-pipeline) | Noted as sub-workflow reference |
| `defineComponent` with code | Code node |
| Component with `app` connection (e.g., Salesforce) | Integration node |
| `process.env.*` references | Environment variable references |
| `steps.*.$return_value` references | Data references between nodes |

### 7.4 Code Translation

The existing Pipedream code uses `@pipedream/platform` axios and Pipedream-specific APIs (`$`, `steps`, `$.export`, `$.respond`, `$.flow`). The import process translates these:

| Pipedream | Translated |
|---|---|
| `import { axios } from "@pipedream/platform"` | `// Uses native fetch` |
| `axios($, config)` | `fetch(url, config)` |
| `$.respond({ status, body })` | `return { response: { status, body } }` |
| `$.flow.exit(reason)` | `return { exit: true, reason }` |
| `$.export("$summary", msg)` | `console.log(msg)` |
| `steps.namespace.$return_value` | `steps.namespace.output` |
| `steps.trigger.event.body` | `trigger.body` |
| `steps.trigger.context.trace_id` | `execution.trace_id` |
| `process.env.VAR_NAME` | `env.VAR_NAME` |
| `this.propName` | `config.propName` |

---

## 8. Slack Integration

### 8.1 Failure Alerts

When a workflow execution encounters an error, an alert is sent to a configured Slack channel. By default, all transient and permanent errors alert. Business rejections never alert. Alert frequency and filtering are configurable per-partner and per-workflow (see Section 11.5).

The alert includes:

- Workflow name
- Timestamp
- Which step failed
- Error classification (transient / permanent) and HTTP status code
- Error message and response body excerpt
- Link to the execution detail view in the tool
- "Replay" button (Slack action) that opens the test runner with the original payload

### 8.2 Webhook Support

For simpler notifications or integration with existing Slack workflows, any code node can send to a Slack webhook URL. The tool provides a built-in `slack.notify()` helper that handles formatting.

### 8.3 Configuration

Slack integration is configured at the organization level:

- OAuth connection to the Slack workspace
- Default alert channel
- Per-workflow channel overrides
- Alert severity levels (all failures, only production, etc.)

---

## 9. Two Modes: Outbound Routing & Inbound Bidding

### 9.1 Outbound Routing

Pennie's own leads (from the website form, Wallet Owl, Reserve, etc.) come in, get validated and enriched, screened for Penny fit, and — if not a Penny fit — routed to the highest-bidding partner.

**Typical flow:**
```
HTTP Trigger → Validate (fields, format, state eligibility) →
Pull Credit → Enrich (debt, scores) →
Screen for Penny Fit →
  [Yes] → Route to Penny front end → Update Salesforce → Respond with Penny Offer
  [No]  → Parallel Partner Bids → Pick Winner → Route to Winner →
           Update Salesforce → Respond with Partner Offer
```

**Validation** includes field presence checks, format validation, and state eligibility — leads from excluded states are rejected immediately.

**Penny-fit screening** is a Branch node after enrichment that evaluates whether the lead qualifies for Penny's own products. Penny-fit leads are routed directly to the Penny front end and never enter the partner bidding flow. Only non-Penny-fit leads proceed to parallel partner bids.

The **Bid Evaluation node** (Section 5.8) selects the winner from the parallel bid results using a configurable strategy — typically highest bid with Engine as fallback.

**Engine is not a bidding partner** — it does not participate in the parallel fan-out and no bid is solicited from it. It is the final repository for leads that no direct partner wins. When the Bid Evaluation node's fallback fires, the lead is posted to Engine unconditionally.

The response to the caller contains the selected offer (partner name, rate, click URL, details) or a rejection.

### 9.2 Inbound Bidding

External networks (like Engine) ping Pennie with a lead and ask for a bid. Pennie evaluates and responds with a structured offer or rejection.

**Typical flow:**
```
HTTP Trigger → Validate (state, name, loan amount, military) →
Parse & Transform → Create Salesforce Applicant (dedup) →
Ping Decision Engine (LendSwift) → Calculate Bid (amount × multiplier) →
Respond with Offer or Rejection
```

The response follows the network's expected schema (requestId, offers array with name, rate, click_url, product_type, logo, etc.).

### 9.3 Shared Building Blocks

Both modes use the same node types and execution engine. The difference is in how they're assembled. The tool makes it easy to:

- Duplicate an existing workflow and modify it for a new source
- Copy/paste nodes (or groups of nodes with their edges) between workflows — the canvas supports selecting multiple nodes, copying them to the clipboard, and pasting into a different workflow. Pasted nodes are independent copies, not shared references.
- Use the same partner configurations in both inbound and outbound flows

---

## 10. Performance & Scaling

### 10.1 Requirements

- Handle high-volume, all-day traffic with burst capacity
- Synchronous execution — caller waits for response
- Target: workflow completion within the time it takes to call external APIs (no meaningful overhead from the engine itself)
- Parallel partner bids must execute simultaneously, not sequentially

### 10.2 Approach

**Cloudflare Workers** scale automatically — each request gets its own isolate. There's no cold start problem (Workers boot in <5ms) and no concurrency limit to worry about at Pennie's scale.

**Application-level orchestration** handles step-by-step execution within a single Worker invocation. Each step's input/output is logged to Supabase as it completes. If a step fails mid-execution, the resume mechanism (Section 2.4) allows re-execution from the failure point without re-running prior steps — no platform-level durability primitive required.

**Workers KV** caches workflow definitions at the edge so execution doesn't require a database read on every request. Cache invalidation happens on save.

**Supabase writes** (execution logs) are fire-and-forget — the log is written asynchronously via `waitUntil()` so it doesn't block the response to the caller.

### 10.3 Observability

#### Structured Logging

Every Worker invocation emits structured JSON logs via `console.log()`. Cloudflare captures these automatically. Each log line includes:

- `trace_id` — unique per execution, propagated to all step logs and external API calls
- `workflow_id`, `workflow_version_id`
- `step_namespace`, `step_type`
- `event` — lifecycle event (`step_start`, `step_complete`, `step_error`, `partner_bid`, `circuit_open`, `cap_check`, etc.)
- `duration_ms`
- `error_type`, `error_message` (when applicable)
- `partner_id` (when applicable)

This format is consistent across all log lines, making it filterable and aggregatable without custom parsing.

#### Tracing

The `trace_id` on `workflow_executions` is generated at request entry (step 1 in Section 2.4) and threaded through the entire execution. It appears in:

- Every structured log line emitted by the Worker
- Every `execution_steps` row written to Supabase
- The Slack alert when an execution fails
- Outbound API calls to partners (as an `X-Trace-Id` header, where the partner supports it)

To trace a single lead end-to-end: search by `trace_id` in Cloudflare Logpush output or filter `execution_steps` in Supabase. The execution detail view in the UI groups everything by `trace_id` automatically.

#### Metrics & Dashboards

**Cloudflare Analytics** (built-in, no setup): request volume, error rates, CPU time, and wall-clock duration per Worker. Available in the Cloudflare dashboard immediately.

**Bidspoke dashboard** (built on Supabase execution data):
- Execution volume, success/failure/exit rates per workflow
- Average and p95 duration per workflow and per step
- Partner performance: bids sent, accepted, rejected, error rate, average bid value, revenue
- Circuit breaker status per partner (open/closed/half-open)
- Daily cap utilization per partner
- Slowest steps (identifies bottleneck integrations)

**Cloudflare Logpush** (Phase 3): exports structured Worker logs to a destination (R2, S3, or Datadog) for long-term retention and advanced querying beyond what Supabase execution logs provide. Useful when Supabase log volume grows large enough that querying becomes slow.

#### Alerting

- **Slack alerts** for execution failures, circuit breaker state changes, and threshold breaches (see Section 11.5)
- **Duration alerts**: configurable per-workflow threshold (e.g., alert if any execution exceeds 20s). Catches degradation in external API performance before it becomes user-visible.
- **Volume anomaly alerts** (Phase 3): alert if execution volume drops below or exceeds a configurable baseline for a time window. Catches upstream source outages (no leads arriving) or traffic spikes.

### 10.4 Execution Log Retention

> **Drift (what shipped):** retention is implemented as **daily partitions with ~7-day retention** (nightly partition drops, plus the Snowflake lead-sightings export for long-term analytics), not the 14-day compaction / 90-day purge model below. Partition drops reclaim space instantly and avoid the UPDATE churn the compaction queries would generate. The 14/90-day retention notes on the Section 3 schemas describe this original plan, not current behavior.

Every step of every execution writes to `execution_steps` with JSONB `input`/`output` payloads. At ~5,000 leads/day × ~10 steps × ~2KB average JSONB per step, that's roughly 100MB/day — 3GB/month. Without cleanup, the 8GB Supabase Pro storage limit is reached in under 3 months.

#### Three-tier retention model

| Tier | Age | What's stored | Where |
|------|-----|---------------|-------|
| **Hot** | 0–14 days | Full detail — all JSONB `input`/`output` on `execution_steps`, full `trigger_payload` and `response_body` on `workflow_executions` | Supabase |
| **Warm** | 14–90 days | Metadata only — JSONB payloads stripped to `null`. Step and execution rows remain for querying by status, duration, partner, error type | Supabase |
| **Cold** | 90+ days | Rows deleted from Supabase. If Logpush is configured (Phase 3), full-detail logs are already archived externally before deletion | Cloudflare R2 / Snowflake via Logpush |

#### Implementation

A **pg_cron** job runs nightly (e.g., 03:00 UTC):

1. **Compact step payloads**: `UPDATE execution_steps SET input = NULL, output = NULL WHERE started_at < now() - interval '14 days' AND input IS NOT NULL`
2. **Compact execution payloads**: `UPDATE workflow_executions SET trigger_payload = NULL, response_body = NULL WHERE started_at < now() - interval '14 days' AND trigger_payload IS NOT NULL`
3. **Purge old executions**: `DELETE FROM workflow_executions WHERE started_at < now() - interval '90 days'` (cascades to `execution_steps`)

Retention windows (14d / 90d) are configurable via `environment_variables` — not hardcoded.

#### Table partitioning

`execution_steps` and `workflow_executions` should be partitioned by month on `started_at` using Postgres native range partitioning. This enables O(1) partition drops instead of slow `DELETE` scans on large tables.

#### Storage budget

With 14-day JSONB compaction, the hot tier stays at ~1.4GB (14 days × 100MB/day). Warm-tier rows are metadata-only (~50 bytes/row), adding negligible overhead. This leaves ~6GB headroom for indexes, other tables, and growth.

---

## 11. Error Handling

### 11.1 Error Classification

> **Drift (what shipped):** the engine classifies **errors** as transient vs permanent, as described below. A business rejection is not a third engine error type — it is a successful step whose output downstream nodes route on (a Filter/Branch/BidGroup reads the "no" and takes the rejection path). The never-retried / never-alerted behavior still holds because the step completes normally. See the error-handling pages under docs/ for current behavior.

Every step outcome falls into one of three categories:

**Transient error** — the request failed in a way that suggests retrying may work. Retried automatically up to the step's configured retry count.
- Network failures: timeouts, connection refused, DNS resolution failure
- HTTP 429 (rate limited), 502, 503, 504
- Any non-HTTP transport failure

**Permanent error** — the request reached the server and was definitively rejected. Retrying won't help.
- HTTP 4xx (except 429)
- Response body that doesn't match the expected schema (e.g., HTML instead of JSON)
- Unhandled exception in a code node
- Authentication failure (invalid credentials)

**Business rejection** — the API returned a successful response that communicates a "no." This is a normal business outcome, not an error.
- Partner returns a valid response indicating no bid, duplicate, or ineligible
- Decision engine returns a decline
- Salesforce dedup finds an existing record

Business rejections are never retried, never trigger alerts, and flow through downstream logic normally. A partner saying "no" is data, not a failure.

**Default classification rules:** The engine classifies based on observable signals — HTTP status codes and transport errors. No error catalog to maintain. Unrecognized errors default to permanent (safe — won't waste retries on something that won't recover).

### 11.2 Per-Partner Classification Overrides

Partners don't always follow conventions. Some return HTTP 200 with an error in the body. Others use 403 to mean "ineligible" instead of "unauthorized." Per-partner signal-based overrides handle this without code changes.

Overrides are configured in the partner management UI and stored on `partner_configs.response_classification` (JSONB). They are evaluated **before** the default rules — if a signal matches, it wins.

**Signal types:**

- **Rejection signals** — "How do I know this partner said no?" Match on response body fields.
  - Example: `{ field: "status", equals: "rejected" }` or `{ field: "accepted", equals: false }`

- **Transient signals** — "What looks permanent but is actually retryable?" Match on status code + body/header.
  - Example: `{ status_code: 200, body_field: "error", contains: "service unavailable" }`
  - Example: `{ status_code: 403, header: "Retry-After", present: true }`

- **Permanent signals** — "What looks transient but is actually terminal?" Match on status code + body.
  - Example: `{ status_code: 503, body_field: "error", contains: "account suspended" }`

**Workflow for a misclassified error:**
1. Execution fails (or succeeds when it shouldn't), Slack alert fires
2. Ops user views execution detail — sees HTTP status, response body, and how it was classified
3. Opens partner config, adds a signal override
4. Next execution uses the new rule. Failed execution can be replayed with corrected classification.

### 11.3 Per-Step Error Behavior

Each node configures what happens when it encounters a permanent error (after retries are exhausted for transient errors):

- **`on_error: "fail"`** (default) — the workflow fails immediately. The step is marked failed, remaining steps are skipped, and the error propagates to the workflow response.
- **`on_error: "skip"`** — the step is marked skipped, and execution continues to the next step. The step's output is `null` in the execution context. Useful for non-critical enrichment steps.
- **`on_error: "fallback"`** — execution routes to the node specified in `fallback_node`. The fallback node receives the original step's input plus the error details. The failed step is marked `failed_with_fallback` in the execution log.

**Fallback example — Equifax → Eligibility Scout:**
```json
{
  "id": "node_equifax",
  "type": "integration",
  "config": {
    "service": "equifax",
    "timeout_ms": 10000,
    "retries": 1,
    "retry_backoff": "exponential",
    "on_error": "fallback",
    "fallback_node": "node_eligibility_scout"
  }
}
```
If Equifax times out → retry once → still fails → route to Eligibility Scout. If Equifax returns 401 (permanent) → skip retries, go straight to fallback.

### 11.4 Partner Bid Node Error Handling

The Partner Bid node wraps error classification into its response parsing. Each partner bid resolves as one of:

- **Bid** — valid response with a bid amount. `{ status: "bid", amount: 45.00, raw: {...} }`
- **Rejection** — valid response indicating no bid. `{ status: "rejected", reason: "duplicate", raw: {...} }`
- **Error** — API failure. `{ status: "error", error_type: "transient"|"permanent", message: "...", raw: {...} }`

In `Promise.allSettled()`, both bids and rejections are **fulfilled** promises — they're successful API calls. Only transport failures and unparseable responses show up as **rejected** promises. The bid evaluation logic downstream receives all three types and decides the winner from the bids, ignoring rejections and errors.

A partner whose API errors out is simply absent from the bid pool for that lead — not a workflow failure. The workflow only fails if *all* partners error out and no fallback (like Engine) is configured.

### 11.5 Alert Configuration

**Default: alert on everything.** Every transient and permanent error fires a Slack alert. Business rejections never alert. All tuning turns alerts *down*, never up — new error types are always alerted by default.

Alert configuration lives on `partner_configs.alert_config` (JSONB) with per-workflow overrides on the Partner Bid node.

**Tuning knobs:**

- **`transient_errors.alert`** — on/off. Default on. Turn off once you've confirmed a partner's occasional flakiness self-resolves with retries.
- **`transient_errors.only_after_retries_exhausted`** — on/off. Default off. When on, transient errors that are recovered by retries don't alert. Only fires if all retries failed. This is the sweet spot for most partners post-launch.
- **`transient_errors.exclude`** — array of error subtypes to suppress (e.g., `["timeout"]`). Silences specific transient errors you've decided are noise.
- **`transient_errors.always_alert`** — array of error subtypes that always alert regardless of other settings (e.g., `["rate_limit"]`). Use for signals that indicate a systemic problem.
- **`permanent_errors.alert`** — on/off. Default on. Rarely turned off.
- **`threshold`** — alert only when error count exceeds N in a time window. `{ count: 5, window_minutes: 10 }`. Catches outages vs one-off flakes. Fires in addition to (not instead of) per-error alerts unless per-error alerts are turned off.

**Alert content includes error classification** so the recipient immediately knows whether it was transient, permanent, what the HTTP status was, and how the engine classified it. This makes it easy to spot misclassifications and add overrides.

---

## 12. Security

### 12.1 Authentication & Authorization

- Google SSO via Supabase Auth
- All API requests require valid JWT
- Row-Level Security in Supabase scopes data to the organization

### 12.2 Webhook Authentication

Inbound webhook endpoints are the entry point for PII and financial data. Every request is authenticated before the workflow executes — before any credit pulls, partner bids, or Salesforce writes.

**Per-source API keys:** Each source (website form, Wallet Owl, Reserve, Engine, future partners) is assigned a unique API key. The caller passes it in the `X-API-Key` header. The Worker validates the key against a lookup table before loading the workflow definition. Invalid or missing keys receive a `401 Unauthorized` response immediately.

**Source identification:** The API key also identifies *which* source is calling (e.g., website form, Wallet Owl, Reserve, Engine). The source identity is available in the execution context as `trigger.source`, enabling per-source logging, rate limiting, and conditional branching within workflows. Note: the source does not determine which workflow runs — that's determined by the webhook URL (`/webhooks/:workflow_id`). Multiple sources can (and will) hit the same workflow.

**Key management:**
- API keys are stored as Cloudflare Worker secrets (same mechanism as other secrets)
- Keys can be rotated per-source without affecting other sources
- Revoking a key immediately blocks that source (after Worker redeployment)
- The partner management UI and a new source management UI handle key creation/rotation

**Future extensibility:** Some external networks may require HMAC signature validation or other auth mechanisms instead of API keys. The trigger configuration supports a per-workflow `auth_method` field so different workflows can use different authentication strategies. API key is the default and the only method implemented in Phase 1.

### 12.3 Secrets Management

- All API keys, passwords, and credentials stored as **Cloudflare Worker secrets** — encrypted at rest by Cloudflare, injected into the Worker `env` binding at runtime
- Secret values are never stored in Supabase — only key names and audit metadata
- Secrets are never returned to the frontend after creation
- Creating or updating a secret writes to Cloudflare via API and triggers a Worker redeployment
- All secret changes logged in the `audit_log` table (key name only, never the value — see Section 3.1)
- Naming convention: `EQUIFAX_USERNAME`, `PARTNER_TRIPOINT_API_KEY`, etc. (flat namespace)

### 12.4 Data Handling

- PII (SSNs, credit data) flows through Cloudflare Workers in memory only — not persisted to disk
- HTTPS everywhere (enforced by Cloudflare)

#### PII Redaction

The execution engine supports a **global redaction blocklist** that scrubs sensitive fields from `execution_steps.input` and `execution_steps.output` before writing to Supabase. The in-memory step context retains full unredacted data so downstream steps still work — only the persisted log is scrubbed.

**Configuration:** A list of dot-path field patterns stored as an `environment_variable` (e.g., `PII_REDACTION_FIELDS`). Editable in the UI under settings by any team member.

**Pattern matching:** A recursive field matcher walks each JSONB object. Any key matching a blocklist pattern has its value replaced with `"[REDACTED]"`. Supports exact keys (`ssn`) and wildcard prefixes (`*.ssn` to match at any nesting depth).

**Default:** Empty — no fields are redacted out of the box. When the team is ready to enable redaction, common patterns to add include: `ssn`, `social_security_number`, `date_of_birth`, `credit_score`, `tradelines`, `account_number`.

**Scope:** Global, not per-workflow. The same PII fields are sensitive everywhere — a single blocklist avoids the risk of forgetting to configure redaction on a new workflow.

---

## 13. Phasing

### Phase 1: Foundation
- Cloudflare Workers execution engine (application-level orchestration)
- Supabase database, auth (Google SSO), and secrets (Cloudflare Worker secrets)
- Canvas editor with basic node types: Code, Filter, Branch, Response, Exit
- Step-by-step execution logging
- Slack failure alerts
- Environment variables and secrets management
- Pipedream JSON import (core component mapping — requires Branch for `_controlFlow` fidelity)
- Version history (internal snapshots)
- Webhook authentication (per-source API keys)
- Trigger-level idempotency
- Execution log retention (pg_cron compaction and purge)
- Audit log (all mutations — workflow saves, partner changes, secret rotations)
- Circuit breakers for upstream services (Equifax, Salesforce — Section 2.5.3)
- PII redaction mechanism (ships disabled by default — Section 12.4)

### Phase 2: Partner Bidding
- Partner management UI
- Partner Bid node type with caps, thresholds, dedup
- Parallel execution node
- Bid evaluation and winner selection logic
- Partner circuit breakers (Durable Objects — Section 2.5)
- Error classification and three-category taxonomy (Section 11.1)
- Per-partner signal overrides (Section 11.2)
- Alert configuration (per-partner, per-workflow — Section 11.5)
- Outbound routing workflow template
- Inbound bidding workflow template
- Observability dashboard (structured logging, tracing, metrics — Section 10.3)
- Integration node type with visual field mapping (Section 5.5)
- Transform node for visual data mapping (Section 5.7)
- Test runner with saved payloads and replay (Section 6.5)

### Phase 3: Schema Awareness & Polish
- Salesforce schema sync and autocomplete
- Supabase schema sync and autocomplete
- Snowflake schema sync and autocomplete
- GitHub backup integration
- Execution history dashboard with partner performance
- Cross-workflow copy/paste of nodes and node groups
- Cloudflare Logpush (full-detail archival to R2/Snowflake before cold-tier purge)
- Volume anomaly alerts (Section 10.3)
