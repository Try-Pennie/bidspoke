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
- [ ] Create Supabase tables: organizations, users, workflows, workflow_versions, workflow_executions, execution_steps, environment_variables, service_connections, audit_log
- [ ] Add all columns per PRD Section 3 (including slug, source, updated_by, updated_by_email, parallel_group_id, etc.)
- [ ] Set up RLS policies (organization_id scoping on all tables)
- [ ] Configure Supabase Auth with Google SSO
- [ ] Set up table partitioning on workflow_executions and execution_steps (by month on started_at)
- [ ] Create pg_cron job for log retention (14-day compaction, 90-day purge) — PRD Section 10.4
  - ⚠️ **Before enabling the 90-day purge:** set up export to Google Sheets (or similar) so warm-tier rows are archived before deletion. Purge job is deployed but should only be activated once export is wired up.
- [ ] **Test:** Auth flow end-to-end (Google SSO → JWT → RLS scoped queries)
- [ ] **Test:** pg_cron compaction on seeded test data

### 1.2 Cloudflare Workers — Execution Engine
- [ ] Scaffold Worker project with wrangler
- [ ] Implement webhook endpoint: `POST /webhooks/:workflow_id`
- [ ] Implement API key authentication (X-API-Key header → source identification) — PRD Section 12.2
- [ ] Implement idempotency check (KV placeholder + cached response) — PRD Section 2.9
- [ ] Implement workflow definition loader (Supabase → KV cache, version-pinned) — PRD Section 2.6
- [ ] Implement sequential step execution engine (walk graph, execute nodes in order)
- [ ] Implement step logging (input/output to Supabase via waitUntil()) — PRD Section 2.4
- [ ] Implement PII redaction mechanism (global blocklist, write-time scrub, ships disabled) — PRD Section 12.4
- [ ] Implement resume execution (resume_from_execution_id, skip completed steps, parallel resume for incomplete children) — PRD Section 2.4
- [ ] Implement error classification (transient/permanent/business rejection) — PRD Section 11.1
- [ ] Implement per-step retry logic (configurable retries, backoff, timeout) — PRD Section 2.4
- [ ] Implement per-step on_error / fallback_node — PRD Section 11.3
- [ ] Implement audit log writes for all mutations — PRD Section 3.1
- [ ] Set up Cloudflare Worker secrets for API keys and credentials
- [ ] **Test:** End-to-end webhook → authenticate → load definition → execute steps → log → respond
- [ ] **Test:** Idempotency (duplicate request returns cached response, race condition returns 409)
- [ ] **Test:** Resume execution (fail mid-workflow, resume, verify skipped steps and fresh execution)
- [ ] **Test:** Error classification (transient retried, permanent not retried, business rejection logged)

### 1.3 Cloudflare Workers — REST API
- [ ] Implement JWT auth middleware (Supabase JWT validation)
- [ ] Workflow CRUD endpoints (GET/POST/PUT/DELETE /api/workflows)
- [ ] Version history endpoints (list versions, get version, restore version)
- [ ] Execution history endpoints (list, detail, resume, replay)
- [ ] Environment variables & secrets endpoints (CRUD, Cloudflare secret sync)
- [ ] **Test:** All CRUD endpoints with auth (valid JWT, invalid JWT, wrong org)

### 1.4 Circuit Breakers — Upstream Services
- [ ] Implement Durable Object for circuit breaker state (closed/open/half-open) — PRD Section 2.5.2
- [ ] Wire circuit breakers for Equifax, Salesforce, Eligibility Scout
- [ ] Implement circuit breaker API endpoints (status, manual reset)
- [ ] **Test:** Trip circuit breaker with repeated failures, verify open state rejects, half-open recovery

### 1.5 Node Types — Phase 1
- [ ] Code node via Dynamic Workers (Monaco editor, sandboxed V8 isolate, controlled outbound proxy) — PRD Section 5.4
- [ ] Filter node (two-output pass/exit gate, rule builder) — PRD Section 5.1
- [ ] Branch node (N conditional outputs, else edge) — PRD Section 5.1
- [ ] Response node (status code, headers, body template) — PRD Section 5.6
- [ ] Exit node (early termination with optional response)
- [ ] **Test:** Each node type in isolation with sample payloads
- [ ] **Test:** Conditional edge evaluation (AND/OR groups, all operator types)

### 1.6 Frontend — Canvas Editor
- [ ] Set up Next.js on Cloudflare Pages
- [ ] Implement React Flow canvas with node palette sidebar
- [ ] Implement node drag-and-drop, edge connections, zoom/pan/minimap
- [ ] Implement node config panel (right sidebar, per-node-type forms)
- [ ] Implement rule builder UI for Filter/Branch nodes (field, operator, value dropdowns)
- [ ] Implement data reference autocomplete (steps.*, trigger.*, env.*)
- [ ] Implement undo/redo
- [ ] Implement save (creates version snapshot, invalidates KV)
- [ ] Implement version history UI (browse, preview, restore)
- [ ] Implement environment variables management UI
- [ ] Implement secrets management UI (Cloudflare sync)
- [ ] **Test:** Create workflow on canvas → save → execute via webhook → verify execution logs

### 1.7 Slack Integration
- [ ] Implement Slack OAuth connection (org-level)
- [ ] Implement failure alert notifications
- [ ] Per-workflow channel overrides
- [ ] **Test:** Trigger a failing workflow, verify Slack alert with trace_id

### 1.8 Pipedream Import
- [ ] Implement JSON parser for Pipedream workflow export
- [ ] Map Pipedream components to Bidspoke node types (code → code, filter → filter, _controlFlow → branch)
- [ ] Auto-layout imported workflows on canvas
- [ ] **Test:** Import each existing Pipedream workflow, verify node mapping and edge structure

### 1.9 Phase 1 Integration Testing
- [ ] End-to-end: website form lead → webhook → validate → credit pull (mocked) → enrich → Penny-fit branch → respond
- [ ] End-to-end: resume from failed step, verify partial results preserved
- [ ] End-to-end: duplicate lead rejected by idempotency
- [ ] End-to-end: audit log captures all mutations
- [ ] Load test: 100 concurrent webhook requests, verify no failures
- [ ] Push all code to GitHub, verify CI passes
- [ ] **Ship Phase 1**

---

## Phase 2: Partner Bidding

### 2.1 Partner Infrastructure
- [ ] Create partner_configs table with all fields (slug, formula, dedup, circuit breaker config, response_classification, alert_config)
- [ ] Create partner_daily_counts table
- [ ] Implement Durable Object for daily caps (cap-{slug}-{YYYY-MM-DD}) — PRD Section 2.5.1
- [ ] Implement Durable Object for partner circuit breakers — PRD Section 2.5.2
- [ ] Implement partner management UI (CRUD, formula preview, enable/disable)
- [ ] Implement partner management API endpoints
- [ ] **Test:** Cap enforcement (hit cap → partner skipped), cap reset at midnight UTC
- [ ] **Test:** Partner circuit breaker (trip → open → half-open → recovery)

### 2.2 Node Types — Phase 2
- [ ] Partner Bid node (circuit breaker check → cap check → dedup → API call → classify response → return bid) — PRD Section 5.3
- [ ] Parallel node (Promise.allSettled, wait_for all/first, timeout with partial/fail) — PRD Section 5.2
- [ ] Bid Evaluation node (highest bid, weighted score, tiebreaker, fallback, no-winner behavior) — PRD Section 5.8
- [ ] Integration node (service-aware field mapping, schema dropdowns) — PRD Section 5.5
- [ ] Transform node (two-column mapping, dot-path, expressions, array access) — PRD Section 5.7
- [ ] **Test:** Partner Bid node — formula-only bid (Tripoint) and API-returned bid
- [ ] **Test:** Parallel node — all children succeed, one fails (others continue), timeout partial results
- [ ] **Test:** Bid Evaluation — highest bid wins, tiebreaker, fallback fires when all rejected, no-winner exit
- [ ] **Test:** Transform node — field rename, nested extraction, array [*] mapping, static values

### 2.3 Error Handling & Alerts
- [ ] Implement three-category error classification with default rules — PRD Section 11.1
- [ ] Implement per-partner signal overrides (response_classification JSONB) — PRD Section 11.2
- [ ] Implement alert configuration (per-partner, per-workflow, severity filtering) — PRD Section 11.5
- [ ] Implement duration alerts (configurable per-workflow threshold)
- [ ] **Test:** Override a signal classification, verify changed behavior
- [ ] **Test:** Alert fires on failure, suppressed when configured off

### 2.4 Test Runner
- [ ] Implement test execution mode (same engine, flagged as test) — PRD Section 6.5
- [ ] Implement step-by-step execution view in UI
- [ ] Implement saved test payloads
- [ ] Implement replay from start and resume from failure
- [ ] **Test:** Run test payload through workflow, verify step-by-step results visible in UI

### 2.5 Observability
- [ ] Implement structured JSON logging (trace_id, workflow_id, step info, event types) — PRD Section 10.3
- [ ] Implement observability dashboard (execution volume, duration, partner performance, circuit breaker status)
- [ ] Implement X-Trace-Id propagation to outbound partner API calls
- [ ] **Test:** Trace a single lead end-to-end by trace_id across logs and execution_steps

### 2.6 Workflow Templates
- [ ] Build outbound routing workflow template (validate → credit → enrich → Penny fit → parallel bids → pick winner → route → Salesforce → respond)
- [ ] Build inbound bidding workflow template (validate → parse → Salesforce dedup → decision engine → bid math → respond)
- [ ] **Test:** Each template end-to-end with realistic payloads

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
- [ ] Implement copy/paste of nodes and node groups across workflows
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
