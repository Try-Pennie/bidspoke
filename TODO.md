# Bidspoke — Planning Doc / To-Do List

> **Start every session by reading this file. Check items off as they're completed.**
> Reference: [PRD.md](./PRD.md) for full specs.

---

## 0. Project Setup

- [x] Initialize repo and push to GitHub
- [x] Set up monorepo structure (frontend + worker)
- [x] Configure Cloudflare Workers project (wrangler.toml, including Dynamic Worker Loader binding)
- [x] Configure Cloudflare Pages project (Next.js)
- [x] Set up Supabase project (database, auth, RLS)
- [x] Configure GitHub Actions for CI/CD (lint, type-check, deploy)
- [x] Verify CI passes on GitHub (fixed ESLint config, Node 24, pre-commit/pre-push hooks)
- [x] Set up local dev environment (wrangler dev, Supabase local)
- [x] Create CLAUDE.md with project conventions

> **Future:** Add automated unit + integration tests to CI as test coverage grows (Vitest for worker, Playwright for web)

---

## Phase 1: Foundation

### 1.1 Database & Auth
- [x] Create Supabase tables: organizations, users, workflows, workflow_versions, workflow_executions, execution_steps, environment_variables, service_connections, audit_log
- [x] Add all columns per PRD Section 3 (including slug, source, updated_by, updated_by_email, parallel_group_id, etc.)
- [x] Set up RLS policies (organization_id scoping on all tables)
- [x] Configure Supabase Auth with Google SSO
  - [x] Create Google Cloud project for Pennie
  - [x] Enable Google OAuth consent screen + credentials
  - [x] Paste Client ID + Secret into Supabase Auth → Providers → Google
- [x] Set up table partitioning on workflow_executions and execution_steps (by month on started_at)
- [x] Create pg_cron job for log retention (14-day compaction, 90-day purge) — PRD Section 10.4
  - ⚠️ **Before enabling the 90-day purge:** set up export to Google Sheets (or similar) so warm-tier rows are archived before deletion. Purge job is deployed but should only be activated once export is wired up.

### 1.2 Cloudflare Workers — Execution Engine
- [x] Scaffold Worker project with wrangler
- [x] Implement webhook endpoint: `POST /webhooks/:workflow_id`
- [x] Implement API key authentication (X-API-Key header → source identification) — PRD Section 12.2
- [x] Implement idempotency check (KV placeholder + cached response) — PRD Section 2.9
- [x] Implement workflow definition loader (Supabase → KV cache, version-pinned) — PRD Section 2.6
- [x] Implement sequential step execution engine (walk graph, execute nodes in order)
- [x] Implement step logging (input/output to Supabase via waitUntil()) — PRD Section 2.4
- [x] Implement PII redaction mechanism (global blocklist, write-time scrub, ships disabled) — PRD Section 12.4
- [x] Implement resume execution (resume_from_execution_id, skip completed steps, parallel resume for incomplete children) — PRD Section 2.4
- [x] Implement error classification (transient/permanent/business rejection) — PRD Section 11.1
- [x] Implement per-step retry logic (configurable retries, backoff, timeout) — PRD Section 2.4
- [x] Implement per-step on_error / fallback_node — PRD Section 11.3
- [x] Implement audit log writes for all mutations — PRD Section 3.1
- [x] Set up Cloudflare Worker secrets for API keys and credentials (API_KEY_MAP)
- [x] **Test:** End-to-end webhook → authenticate → load definition → execute steps → log → respond
- [x] **Test:** Idempotency (duplicate request returns cached response, race condition returns 409)
- [x] **Test:** Resume execution (fail mid-workflow, resume, verify skipped steps and fresh execution)
- [x] **Test:** Error classification (transient retried, permanent not retried, business rejection logged)

### 1.3 Cloudflare Workers — REST API
- [x] Implement JWT auth middleware (Supabase JWT validation)
- [x] Workflow CRUD endpoints (GET/POST/PUT/DELETE /api/workflows)
- [x] Version history endpoints (list versions, get version, restore version)
- [x] Execution history endpoints (list, detail, resume, replay)
- [x] Environment variables & secrets endpoints (CRUD, Cloudflare secret sync)
- [x] **Test:** All CRUD endpoints with auth (valid JWT, invalid JWT, wrong org)

### 1.4 Circuit Breakers — Upstream Services
- [x] Implement Durable Object for circuit breaker state (closed/open/half-open) — PRD Section 2.5.2
- [x] Wire circuit breakers for Equifax, Salesforce, Eligibility Scout
- [x] Implement circuit breaker API endpoints (status, manual reset)
- [x] **Test:** Trip circuit breaker with repeated failures, verify open state rejects, half-open recovery

### 1.5 Node Types — Phase 1
- [x] Code node via Dynamic Workers (Monaco editor, sandboxed V8 isolate, controlled outbound proxy) — PRD Section 5.4
- [x] Filter node (two-output pass/exit gate, rule builder) — PRD Section 5.1
- [x] Branch node (N conditional outputs, else edge) — PRD Section 5.1
- [x] Response node (status code, headers, body template) — PRD Section 5.6
- [x] Exit node (early termination with optional response)
- [x] **Test:** Each node type in isolation with sample payloads
- [x] **Test:** Conditional edge evaluation (AND/OR groups, all operator types)

### 1.6 Frontend — Canvas Editor
- [x] Set up Next.js on Cloudflare Pages
- [x] Implement React Flow canvas with node palette sidebar
- [x] Implement node drag-and-drop, edge connections, zoom/pan/minimap
- [x] Implement node config panel (right sidebar, per-node-type forms)
- [x] Implement rule builder UI for Filter/Branch nodes (field, operator, value dropdowns)
- [x] Implement data reference autocomplete (steps.*, trigger.*, env.*)
- [x] Implement undo/redo
- [x] Implement save (creates version snapshot, invalidates KV)
- [x] Workflow validation — unconfigured attached nodes show amber ring; save blocked for live workflows; Enable from list blocked if definition has unconfigured nodes
- [x] Implement version history UI (browse, preview, restore)
- [x] Implement environment variables management UI
- [x] Implement secrets management UI (Cloudflare sync)
- [x] Add production Cloudflare Pages URL to Supabase Auth → URL Configuration → Redirect URLs
- [x] **Test:** Create workflow on canvas → save → execute via webhook → verify execution logs

### 1.7 Slack Integration
- [x] Implement Slack OAuth connection (org-level)
- [x] Implement failure alert notifications
- [x] Per-workflow channel overrides
- [x] **Test:** Trigger a failing workflow, verify Slack alert (trace_id removed from alert; direct link sufficient)

### 1.8 Pipedream Import
- [x] Implement JSON parser for Pipedream workflow export
- [x] Map Pipedream components to Bidspoke node types (code → code, filter → filter, _controlFlow → branch)
- [x] Auto-layout imported workflows on canvas
- [x] **Test:** Import each existing Pipedream workflow, verify node mapping and edge structure

### 1.9 Phase 1 Integration Testing
- [x] **Test:** Auth flow end-to-end (Google SSO → JWT → RLS scoped queries)
- [ ] **Test:** pg_cron compaction on seeded test data
- [ ] End-to-end: website form lead → webhook → validate → credit pull (mocked) → enrich → Penny-fit branch → respond (deferred to Phase 2 — requires partner nodes)
- [ ] End-to-end: resume from failed step, verify partial results preserved (deferred to Phase 2 — requires multi-step workflow)
- [ ] End-to-end: duplicate lead rejected by idempotency (deferred — requires idempotency enabled in trigger config)
- [x] End-to-end: audit log captures all mutations
- [ ] Load test: 100 concurrent webhook requests, verify no failures
- [x] Push all code to GitHub, verify CI passes
- [x] **Ship Phase 1**

---

## Phase 2: Partner Bidding

### 2.1 Partner Infrastructure
- [x] Create partner_configs table with all fields (slug, formula, dedup, circuit breaker config, response_classification, alert_config)
- [x] Create partner_daily_counts table
- [x] Implement Durable Object for daily caps (cap-{slug}-{YYYY-MM-DD}) — PRD Section 2.5.1
- [x] Implement Durable Object for partner circuit breakers — PRD Section 2.5.2
- [x] Implement partner management UI (CRUD, formula preview, enable/disable)
- [x] Implement partner management API endpoints
- [x] **Test:** Cap enforcement (hit cap → partner skipped), cap reset at midnight UTC
- [x] **Test:** Partner circuit breaker (trip → open → half-open → recovery)

### 2.2 Node Types — Phase 2
- [x] Partner Bid node (circuit breaker check → cap check → dedup → API call → classify response → return bid) — PRD Section 5.3
- [x] Parallel node (Promise.allSettled, wait_for all/first, timeout with partial/fail) — PRD Section 5.2
- [x] Bid Evaluation node (highest bid, weighted score, tiebreaker, fallback, no-winner behavior) — PRD Section 5.8
- [x] Integration node (service-aware field mapping, schema dropdowns) — PRD Section 5.5
- [x] Transform node (two-column mapping, dot-path, expressions, array access) — PRD Section 5.7
- [x] **Test:** Partner Bid node — formula-only bid (Tripoint) and API-returned bid
- [x] **Test:** Parallel node — all children succeed, one fails (others continue), timeout partial results
- [x] **Test:** Bid Evaluation — highest bid wins, tiebreaker, fallback fires when all rejected, no-winner exit
- [x] **Test:** Transform node — field rename, nested extraction, array [*] mapping, static values

### 2.3 Error Handling & Alerts
- [x] Implement three-category error classification with default rules — PRD Section 11.1
- [x] Implement per-partner signal overrides (response_classification JSONB) — PRD Section 11.2
- [x] Implement alert configuration (per-partner, per-workflow, severity filtering) — PRD Section 11.5
- [x] Implement duration alerts (configurable per-workflow threshold)
- [x] **Test:** Override a signal classification, verify changed behavior
- [x] **Test:** Alert fires on failure, suppressed when configured off

### 2.4 Test Runner
- [x] Implement test execution mode (same engine, flagged as test) — PRD Section 6.5 (TestRunPanel + isTest flag)
- [x] Implement step-by-step execution view in UI (execution overlay on canvas, ExecutionStepPanel)
- [x] Implement saved test payloads
- [x] Implement replay from start and resume from failure (Replay button in execution banner)
- [x] **Test:** Run test payload through workflow, verify step-by-step results visible in UI

### 2.5 Observability
- [x] Implement structured JSON logging (trace_id, workflow_id, step info, event types) — PRD Section 10.3
- [x] Implement observability dashboard (execution volume, duration, per-workflow breakdown, recent failures)
- [x] Implement X-Trace-Id propagation to outbound partner API calls
- [ ] **Test:** Trace a single lead end-to-end by trace_id across logs and execution_steps

### 2.6 Workflow Templates
- ~~Build outbound routing workflow template~~ — scratched, not needed
- ~~Build inbound bidding workflow template~~ — scratched, not needed

### 2.7 Phase 2 Integration Testing
- [ ] End-to-end outbound: lead → validate → credit pull → enrich → Penny-fit NO → parallel bids (Tripoint + M1) → highest bid wins → route → Salesforce → respond with offer
- [ ] End-to-end outbound: all bids rejected → fallback to Engine
- [ ] End-to-end outbound: Tripoint dedup rejects → M1 wins → route to M1
- [ ] End-to-end inbound: Engine pings → validate → decision engine → bid response
- [ ] End-to-end: partner hits daily cap mid-day → excluded from bidding
- [ ] End-to-end: partner circuit breaker trips → excluded, recovers in half-open
- [ ] End-to-end: parallel resume — 1 of 2 children fails, resume re-runs only incomplete child
- [ ] Load test: 500 concurrent leads, parallel bids to 3 partners, verify no race conditions
- [ ] Push all code to GitHub, verify CI passes
- [ ] **Ship Phase 2**

---

## Phase 3: Schema Awareness & Polish

### 3.1 Schema Sync
- [ ] Implement Salesforce schema sync (objects, fields, record types) + autocomplete
- [ ] Implement Supabase schema sync (tables, columns) + autocomplete
- [ ] Implement Snowflake schema sync (schemas, tables) + autocomplete
- [ ] **Test:** Schema sync fetches real metadata, autocomplete populates in Integration node config

### 3.2 GitHub Backup
- [ ] Implement GitHub integration (push workflow definitions on save, commit_sha on workflow_versions)
- [ ] **Test:** Save workflow → verify commit in GitHub repo with correct definition JSON

### 3.3 Dashboards & Reporting
- [ ] Implement execution history dashboard with partner performance metrics
- [ ] **Test:** Dashboard shows accurate volume, duration, partner win rates

### 3.4 Cross-Workflow Copy/Paste
- [x] Implement copy/paste of nodes and node groups across workflows
- [ ] **Test:** Copy a 3-node group from workflow A, paste into workflow B, verify independent copies

### 3.5 Long-Term Retention
- [ ] Configure Cloudflare Logpush (export to R2 or Snowflake)
- [ ] Wire cold-tier purge to only delete after Logpush archival confirmed
- [ ] **Test:** Verify archived logs are queryable in R2/Snowflake by trace_id

### 3.6 Volume Anomaly Alerts
- [ ] Implement baseline volume tracking and anomaly detection
- [ ] **Test:** Simulate traffic drop, verify alert fires

### 3.7 Phase 3 Integration Testing
- [ ] Full regression: all Phase 1 + Phase 2 tests still pass
- [ ] Schema autocomplete across all three services
- [ ] GitHub backup for every workflow save
- [ ] Push all code to GitHub, verify CI passes
- [ ] **Ship Phase 3**

---

## Test Coverage Backlog

> Tests that need to be written before going live. Grouped by priority.
> Existing coverage: 171 worker tests (Vitest) + 1 web lib test. No Playwright/E2E tests yet.

### P0 — Must have before launch

- [x] **Exit node** — unit test in `engine/nodes/__tests__/exit.test.ts` (no response config, with response config, output passthrough)
- [x] **JWT auth middleware** — unit test in `middleware/__tests__/jwt-auth.test.ts` (missing header → 401, malformed token → 401, expired token → 401, user not in DB → 401, `user_metadata.full_name` extracted, `user_metadata.name` fallback, no name → null)
- [x] **Webhook route** — integration test in `routes/__tests__/webhooks.test.ts` (missing X-API-Key → 401, invalid key → 401, invalid JSON body → 400, inactive/unknown workflow → 404, valid request → 200 with trace ID, idempotent replay → `X-Idempotent-Replay: true` header)
- [x] **PII redactor** — unit test in `engine/__tests__/pii-redactor.test.ts` (empty fields = no-op, exact key match, wildcard `*.ssn`, nested objects, arrays, non-matching keys untouched)

### P1 — High value, ship soon

- [x] **Slack alert payload** — unit test in `lib/__tests__/slack.test.ts` (blocks structure, `unfurl_links: false`, ET timezone with DST, `View execution →` link is markdown not button)
- [x] **Workflow CRUD routes** — tests in `routes/api/__tests__/workflows.test.ts` (PUT creates version snapshot + invalidates KV, PATCH toggles `is_active`, DELETE removes workflow, version restore creates new version with old definition, test runner endpoint executes engine)
- [x] **Execution routes** — tests in `routes/api/__tests__/executions.test.ts` (list scoped to org, get by ID, replay creates new execution)
- [x] **Sources routes** — tests in `routes/api/__tests__/sources.test.ts` (create generates API key, list returns org sources, delete removes key)

### P2 — Nice to have

- [ ] **Audit log** — smoke test in `lib/__tests__/audit.test.ts` (verify insert shape, no throw on Supabase error)
- [ ] **Definition loader / KV cache** — tests in `engine/__tests__/definition-loader.test.ts` (cache hit skips Supabase, cache miss fetches and stores, invalidate removes key)
- [ ] **Env var routes** — tests in `routes/api/__tests__/env.test.ts` (CRUD, secret masking on read)
- [ ] **Integrations routes** — tests in `routes/api/__tests__/integrations.test.ts` (Slack OAuth connect, list connections, delete)
- [ ] **Playwright E2E** — see plan doc for full setup steps. Auth via email+password test user (not SSO); hide test user from UI. Focus on list/CRUD pages (workflows, env vars, sources, integrations, dashboard). Skip canvas and Slack. See `/Users/danhankins-wright/.claude/plans/soft-forging-scroll.md` → "Playwright E2E Testing — Plan".

---

## Pre-Ship Checklist (run before each phase ships)

- [ ] All tests pass (unit + integration + load)
- [ ] No hardcoded secrets or credentials in codebase
- [ ] RLS policies verified (user in org A cannot see org B data)
- [ ] Webhook auth rejects invalid/missing API keys
- [ ] Error handling: no unhandled promise rejections in Worker
- [ ] Execution logs writing correctly (check Supabase)
- [ ] Slack alerts firing on failure
- [ ] Audit log capturing all mutations
- [ ] Code pushed to GitHub, CI green
- [ ] KV cache invalidation working on workflow save
