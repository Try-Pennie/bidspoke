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
- [x] **Test:** pg_cron compaction on seeded test data
- [ ] End-to-end: website form lead → webhook → validate → credit pull (mocked) → enrich → Penny-fit branch → respond (deferred to Phase 2 — requires partner nodes)
- [x] End-to-end: resume from failed step, verify partial results preserved
- [x] End-to-end: duplicate lead rejected by idempotency (header-based: x-idempotent-replay: true on second request after 5s)
- [x] End-to-end: audit log captures all mutations
- [x] Load test: 100 concurrent webhook requests, verify no failures
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
- [x] **Test:** Trace a single lead end-to-end by trace_id across logs and execution_steps

### 2.6 Workflow Templates
- ~~Build outbound routing workflow template~~ — scratched, not needed
- ~~Build inbound bidding workflow template~~ — scratched, not needed

### 2.7 Phase 2 Integration Testing
- [x] End-to-end outbound: lead → validate → credit pull → enrich → Penny-fit NO → parallel bids (Tripoint + M1) → highest bid wins → route → Salesforce → respond with offer
- [x] End-to-end outbound: all bids rejected → fallback to Engine
- [x] End-to-end outbound: Tripoint dedup rejects → M1 wins → route to M1
- [x] End-to-end inbound: Engine pings → validate → decision engine → bid response
- [x] End-to-end: partner hits daily cap mid-day → excluded from bidding
- [x] End-to-end: partner circuit breaker trips → excluded, recovers in half-open
- [x] End-to-end: parallel resume — 1 of 2 children fails, resume re-runs only incomplete child
- [x] Load test: 500 concurrent leads, parallel bids to 3 partners, verify no race conditions
- [x] Push all code to GitHub, verify CI passes
- [x] **Ship Phase 2**

---

## Phase 3: Schema Awareness & Polish

### 3.1 Schema Sync
- [x] Implement Salesforce schema sync (objects, fields, record types) + autocomplete
- [x] Implement Supabase schema sync (tables, columns) + autocomplete
- [x] Implement Snowflake schema sync (schemas, tables) + autocomplete
- [x] **Test:** Schema sync fetches real metadata, autocomplete populates in Integration node config

### 3.2 GitHub Backup
- [x] Implement GitHub integration (push workflow definitions on save, commit_sha on workflow_versions)
- [x] **Test:** Save workflow → verify commit in GitHub repo with correct definition JSON

### 3.3 Dashboards & Reporting
- [x] Implement execution history dashboard with partner performance metrics
- [x] **Test:** Dashboard shows accurate volume, duration, partner win rates

### 3.4 Cross-Workflow Copy/Paste
- [x] Implement copy/paste of nodes and node groups across workflows
- [x] **Test:** Copy a 3-node group from workflow A, paste into workflow B, verify independent copies

### 3.5 Long-Term Retention
- [x] Configure Cloudflare Logpush (export to R2 or Snowflake)
- [x] Wire cold-tier purge to only delete after Logpush archival confirmed
- [x] **Test:** Verify archived logs are queryable in R2/Snowflake by trace_id

### 3.6 Volume Anomaly Alerts
- [x] Implement baseline volume tracking and anomaly detection
- [x] **Test:** Simulate traffic drop, verify alert fires

### 3.8 Custom Endpoints
- [x] Implement `webhook_endpoints` table (subdomain + path → workflow_id + source_name)
- [x] Worker subdomain middleware — intercepts `*.trypennie.dev` before normal routing, KV-cached (60s)
- [x] Enforce API key auth on custom endpoints (same contract as generic webhooks)
- [x] CRUD API at `/api/endpoints` with KV cache invalidation on update/delete
- [x] Frontend: Endpoints page (slide-open form, toggle active, copy URL, optimistic delete)
- [x] Trigger panel: shows custom endpoints mapped to workflow alongside generic URL
- [x] CF infrastructure: wildcard DNS `* CNAME → bidspoke-worker.workers.dev`, Worker route `*.trypennie.dev/*`, bypass route `bidspoke.trypennie.dev/*` (no worker) to protect Pages

### 3.7 Phase 3 Integration Testing
- [x] Full regression: all Phase 1 + Phase 2 tests still pass
- [x] Schema autocomplete across all three services
- [x] GitHub backup for every workflow save
- [x] Push all code to GitHub, verify CI passes
- [x] **Ship Phase 3**

---

## Phase 4: Engine Bidding Cutover

> Scoped 2026-04-16 after a call with Michael. Updated 2026-04-21 after Bruno call — added 3.1b (Tripoint token DO), 3.1c (Tripoint submission workflow), 3.1d (M1 ping-only), result code correction, Tripoint lead ID write-back, and 3.8 (under 20K remarketing). Full plan lives in [docs/engine-cutover-scope.md](./docs/engine-cutover-scope.md). Reference artifacts (Pipedream JSON, SF Apex) in [docs/reference/](./docs/reference/). Target cutover: 1-2 weeks from scope date.

### Critical path to cutover (all must land before engine is rerouted) — ✅ COMPLETE (cutover done 2026-06-18)

- [ ] **4.3 Shadow mirror mode — Phase A (dry_run)** — Pipedream-side mirror step fires fire-and-forget to a Bidspoke shadow endpoint; Bidspoke returns 204 and runs workflow with `shadow_mode: 'dry_run'` (skips all outbound calls). Goal: prove volume handling this week. See scope §3.3. **Bidspoke side shipped 2026-06-18** (branch `feature/shadow-mode`): `shadow_mode` flag on `ExecutionContext` + `POST /shadow/:workflow_id` (204 + `waitUntil`, `isTest: true` + `__shadow` source); dry-run stubs in Integration/Salesforce/Partner Bid/Achieve Offers nodes + Data Store KV-write skip; Code nodes receive `shadow_mode` in the sandbox so outbound scripts self-stub. Doc: [docs/shadow-mode.md](./docs/shadow-mode.md). **NOTE 2026-06-18:** engine cutover (4.0) is already complete, so the original "prove volume before cutover" purpose is moot. The `shadow_mode` machinery is retained as a reusable dry-run capability for future partner migrations (its stated durable goal). PR #229 to be merged/closed on that basis — Dan to decide.
- [x] **4.1 Engine bidding workflow — lift and shift** — **DONE per Dan 2026-06-18.** Ported node-by-node; engine bidding logic lives in `apps/worker/src/engine/bid-resolver.ts` (Tripoint result classifier, `resolveBid`) and the live Engine Bidding Workflow. Original scope: port the Pipedream JSON by hand per §3.1; response-shape contract matches Pipedream byte-for-byte.
  - Tripoint approved result codes are **1000-1001 and 1013-1017 only** (matches the live classifier `tripointResult` in `apps/worker/src/engine/bid-resolver.ts`; 1002-1005 and 1020 are Duplicate, everything else is a rejection). NOTE: earlier "1013-2017" was a transcription error — 1013-1017 is correct.
  - After a successful Tripoint bid, write `leadId` back to Salesforce prospect as `Tripoint_Lead_ID__c`.
- [x] **4.1a Equifax integration** — **DONE per Dan 2026-06-18.** Worker secrets (EQUIFAX_USERNAME, EQUIFAX_PASSWORD) + equifax_credit_report as a Code node with rewritten script. See scope §3.1a. (Lender-grouping refactor remains a Phase 5 Spark-port concern — see sub-item below.)
  - [x] Code node early-exit sentinel support ($.respond() / $.flow.exit() translated patterns)
  - [x] execution.trace_id passed to code node workers
  - [x] Pipedream importer improvements: steps.$return_value.X → steps.X.output.Y, Salesforce/Equifax/dataStore translations, bare axios import removal
  - [ ] Keep lender classification as constants/config, not hardcoded literals. Spark port (Phase 5) replaces individual-lender targeting with two FCRA-permissible groups (excluded lenders + credit unions); we want the same Code node to swap groupings via constants edit, not script rewrite. Confirmed in 2026-05-01 team call.
- [x] **4.1b Tripoint token Durable Object** — **DONE per Dan 2026-06-18.** (Was deferred to main-flow migration; engine flow calls Brian's existing proxy via TRIPOINT_PROXY_SECRET.) See scope §3.1b.
- [x] **4.2 Partner Bid Config as first-class entity** — `partner_bid_configs` + `bid_matrix_rows` + `bid_config_history` tables shipped 2026-04-29 (Slice 2 of the BidGroup work). `is_default BOOLEAN` with unique partial index. Salesforce stays canonical for editing in v1: hourly cron pulls `BidRangeRow__c` into `bid_matrix_rows`; partner settings page renders a read-only `<BidMatrixViewer>` with "Synced from Salesforce" badge + last-synced + Sync now button. Schema is editable-ready — flip `sync_source` from 'salesforce' to 'manual' and build an editor when the team is ready. Resolver type lives on `partner_configs.bid_resolver_type` ('formula' | 'matrix' | 'api'); no separate Bid Lookup node. See scope §3.2.
- [x] **4.2 follow-up: per-partner matrix migration** — **NOT NEEDED (scratched per Dan 2026-06-18).** Original scope: for each partner using a matrix today, switch resolver to Matrix in partner settings, add a matrix (defaults pre-fill `sf_object='BidRangeRow__c'` and `Is{Slug}__c` flag), click Sync now, save. Partners: SoFi, NerdWallet, EPCVIP, Dot818, Brainsome, TLG, AmOne, AmOneDirect, Default. Suggest starting with SoFi as the validation case.
- [x] **4.2a Constants node** — workflow-level constants stored in node config (key-value editor), partner data (UUID map + sell-off copy) from DB (KV-cached). `partner_uuid_map` table + sell-off columns on `partner_configs`. Constants executor merges both sources. Importer auto-detects `constants` namespace. Partner form updated with sell-off fields + UUID list.
- [x] **Partner type toggle** — `partner_type: 'source' | 'buyer'` field on `partner_configs`. Form shows Source/Buyer segmented toggle; buyer-only sections (API, Bidding, Circuit breaker, Response classification, Alert config) hidden for source partners.
- [x] **4.4 Token-based auth** — **NOT NEEDED (scratched per Dan 2026-06-18).** No longer a cutover blocker. Original scope: `issued_tokens` table, `POST /token` route, `auth_mode: 'api_key' | 'token'` on `webhook_endpoints` (§3.4).
- [x] **4.0 Cutover** — **DONE per Dan 2026-06-18.** Engine routing flipped to Bidspoke and Pipedream disabled. Pipedream workflow stays warm as rollback target. **The engine bidding flow now runs on Bidspoke in production.**

### Pre-main-flow migration (must land before main flow migrates off Pipedream)

- [x] **4.1c Tripoint submission workflow** — **DONE per Dan 2026-06-18.** Triggered by Denise's frontend with a Tripoint lead ID; submits to Tripoint via proxy, checks 200/208 success codes, patches Salesforce. See scope §3.1c.
- [x] **4.1d M1 ping-only integration** — **DONE per Dan 2026-06-18.** M1 bidding is ping-only in the main flow (returns bid + click URL); conversion POST is a separate out-of-band endpoint Brian built with a required 60-second delay. Partner Bid node `bid_mode: 'ping_only'` support shipped. See scope §3.1d.

### Follow-on (after cutover)

- [x] **4.9 Partner outbound field mapping** — shipped 2026-04-29 (Slice 3 of the BidGroup work). `outbound_field_mapping` JSONB column on `partner_configs`; two-column `<OutboundMappingEditor>` in partner settings; `applyOutboundMapping()` in `bid-resolver.ts::callBidApi` runs between body construction and fetch. Dedup payload and formula inputs see the original payload (operators reason in payload-native field names; mapping only affects the wire format). Inbound mapping deferred.
- [x] **BidGroup node** — shipped 2026-04-29 (Slices 4a + 4b). Three modes (`cascade`, `highest_bid`, `tiered`) all return `{ winner, all_bids, mode, reason, _route }` with two outgoing edges (winner / no_winner). Tiered mode supports per-tier `advance_condition` rule-builder gates; tiers can be cascade or highest-bid internally. First-class engine executor (one canvas node, fan-out handled internally; synthesizes `step_type='partner_bid'` rows linked to the parent `bid_group` row via `parallel_group_id`). Group-level fallback partner. `no_winner_behavior: 'fail' | 'exit'`.
- [ ] **4.5a Win tracking via scheduled Salesforce pull** — hourly scheduled workflow + manual "Run now" button. Updates `opportunities.bid_accepted` and `opportunities.monetized`. See scope §3.5a.
- [ ] **4.5 Person + Lead Sightings + Opportunity data model** — `persons` (two-column SSN: encrypted + peppered hash), `lead_sightings` (every SSN arrival), `opportunities` (only real bids). Ships after cutover. Retention policy needs revisiting — can't purge bid-outcome rows on the 90-day schedule. See scope §3.5. **Status 2026-06-18 (code-verified):** persons/lead_sightings/lead_sighting_bids tables, engine integration, nightly Snowflake export, and persons backfill are all DONE; only the `opportunities` table + win-tracking remains (tied to 4.5a).
  - [x] Snowflake schema designed (locked 2026-04-30): two tables (`lead_sightings`, `lead_sighting_bids`) + `lead_sightings_v` outcome view. PII split: encrypted persons in Supabase, raw formatted SSN goes to Snowflake. Daily push 09:00 UTC. Saved to `~/Downloads/lead_sightings_snowflake_schema.txt`.
  - [x] Supabase migration `20260430000001_lead_sightings.sql` shipped 2026-04-30 — `persons` (encrypted PII + peppered SSN hash), `lead_sightings` (partitioned monthly on execution_started_at_utc), `lead_sighting_bids` (partitioned monthly on attempted_at_utc). RLS via workflow_id → workflows.organization_id. Initial 6 monthly partitions seeded.
  - [x] Engine integration shipped 2026-04-30 — `persons-crypto.ts` (AES-GCM via SECRET_ENCRYPTION_KEY + peppered SHA-256 via SSN_HASH_PEPPER), `lead-sightings.ts` (insertSighting, finalizeSighting, recordBidAttempt, upsertPerson, deriveRejectReason, extractSightingFields, extractBidGroupSummary, extractEnrichment). All three touch points wired via waitUntil: trigger boundary insert (in_flight), per-attempt bid log in partner-bid.ts, finalize hook in engine/index.ts (terminal node + bid summary + enrichment + reject_reason + winner mark). Test runs skip the writes. Field paths verified against live Engine Bidding Workflow's prospect_body code node. `reject_reason` is engine-derived, not author-set.
  - [x] Nightly Snowflake export job — **DONE** (`apps/worker/src/lib/sightings-export.ts`, `runSightingsExport` on the 09:00 UTC cron at `index.ts:153`; exports `lead_sightings` + `lead_sighting_bids` then purges exported rows).
  - [x] One-time backfill of `persons` from existing Salesforce prospects — **DONE** (Worker route `POST /api/admin/backfill-sightings` in `routes/api/admin.ts`, backfills `lead_sightings` + `lead_sighting_bids` + `persons`).
  - [ ] `opportunities` table + win-tracking (depends on 4.5a) — **still open** (no `opportunities` table in migrations as of 2026-06-18).
- [ ] **4.6 Repeat-lead visibility in dashboard** — per-person timeline, per-SSN churn, cross-sub-account overlap. Depends on 4.5.
- [ ] **4.7 Dynamic bid optimization hooks** — Reese's ML patches matrix cells via `PATCH /api/partner-bid-configs/:slug/rows`. Design-accommodation only; no UI work now. **Status 2026-06-18 (code-verified):** NOT built — `partner-bid-configs.ts` has GET/POST/PUT/DELETE/sync/history routes but no `PATCH /:id/rows` endpoint.
- [x] **4.8 Under 20K remarketing workflow** — **DONE per Dan 2026-06-18.** fan-out M1 + Tripoint + engine simultaneously; 10-second window for M1/Tripoint; if either responds, route to higher bid and skip engine; fall back to engine (up to 20s) only if neither M1 nor Tripoint respond. Needed for remark/second-look flow on the get-offers landing page. See scope §3.8.
- [x] **4.10 Bid matrix change alerts** — shipped 2026-05-07. Hourly SF→`bid_matrix_rows` sync now snapshots existing rows, computes per-row diffs (added/edited/removed by SF source_id), writes the rich diff to `bid_config_history` (instead of just counts), and posts an aggregated Slack alert per organization when any config changed. `sendMatrixChangeAlert` lives in `apps/worker/src/lib/slack.ts`; diff logic + cron notifier in `apps/worker/src/lib/bid-matrix-sync.ts`. Manual "Sync now" from the API still writes history but skips Slack (intentional — those syncs usually follow a deliberate edit). Motivated by 2026-05-07 Pipedream incident: someone edited the SF matrix mid-day, left credit-score gaps/overlaps, three hours of bidding broke before anyone noticed.
- [x] **4.12 Real-time volume cliff alert** — shipped 2026-05-08. Daily volume-anomaly check (TODO 3.6) is structurally blind to intraday cliffs; new `apps/worker/src/lib/volume-cliff.ts` runs every minute, compares last-5-min count to the median of per-minute counts in the prior 55 min, fires Slack alert when last-5-min < 25% of expected and baseline ≥10/min. 30-min KV cooldown per workflow prevents repeat alerts during sustained outages. Reuses existing `volume_alerts_enabled` toggle on Slack connection. Motivated by 2026-05-07 engine-bidding cliff at 21:38 UTC — would now fire ~21:43 UTC instead of 09:00 UTC the next day.
- [x] **4.11 "Why didn't this lead get a bid?" view** — shipped 2026-05-07. Partner Bid output now carries `resolver_type` + `matrix` (config_id, matched_row_id, last_synced_at, is_sell_off, reason). Execution detail page renders a "Bid attempts" section above the per-step list for every `bid_group` step: partner slug, mode (Matrix/Formula/API), result badge (Won/Bid/No bid/Skipped/Rejected), bid amount, and a human-readable "why" derived from `skip_reason` and `matrix.reason` (e.g. "No matrix row matched the lead", "Missing payload field: credit_score", "Daily cap (250)", "Circuit breaker open"). Winner row highlighted; no-winner cases get a red header with the BidGroup `reason`.

---

## Phase 5: Engine free-leads pipeline (scoped 2026-05-01)

> New upstream relationship with Engine. Pennie gets ~500K/mo leads who didn't click the second-look offer wall, or saw secured/100%+ APR offers. Equifax logic ports to Engine's Spark platform; Bidspoke handles inbound + outreach. Geoff/Bruno own the Spark side; Bidspoke scope below. Branding is **not Penny** — leans Reserve My Loan / Advised by Reserve / Wallet Owl, TBD.
>
> All items pending Spark documentation arrival and 2026-05-01 3pm Engine call follow-ups.

- [ ] **5.1 Inbound webhook from Engine/Spark** — receives leads after Spark runs Equifax logic. Likely a custom endpoint on `*.trypennie.dev` with token auth (4.4). Payload shape pending Spark docs.
- [ ] **5.2 Equifax side-by-side tester workflow** — accepts a live lead, fan-outs to Bidspoke Equifax Code node + Engine's Spark Equifax run, diffs outputs, logs to Snowflake. Lets us validate that grouping refactor doesn't drift from current behavior before cutting Spark over. Geoff floated this as a confidence check.
- [ ] **5.3 SMS outreach workflow** — Telnyx integration (we already have an account; brand registration pending). Sends opener referencing the offer the lead saw, hands off to booking flow. A2P 10DLC trust score is the rate-limiter — slow ramp on a new domain.
- [ ] **5.4 Booking handoff** — embed the Penny booking module on the throwaway-brand site. Lead enters Penny's normal post-application flow from there.
- [ ] **5.5 Source segmentation** — filter incoming Engine leads by upstream source to exclude performance-marketer traffic (low intent / TCPA risk). Lender-direct leads first.

---

## Platform / Ops

- [ ] **Achieve (FDR) offer-collection node** (2026-06-10, Geoff) — hit Achieve Partners API targeting just FDR from Main Flow, collect offers without feeding them into routing, log lead-in/offers-out for volume analysis + later trades-data join. **Shipped:** `achieve_evaluations` table (migration `20260610000001`, monthly partitions, applied; also restores monthly partition rollover for `lead_sightings`/`lead_sighting_bids`, whose seeded partitions ended 2026-09-30 with no cron extending them — inserts would have started failing 2026-10-01); engine hook (`engine/achieve-log.ts`, writes any step output marked `_achieve_evaluation: true` via waitUntil); **first-class `achieve_offers` node** (Dan: not a code node) — executor `engine/nodes/achieve-offers.ts` (single output, pass-through, never fails the flow, internal 12s fetch abort), palette entry "Achieve Offers", config panel (products multi-select default FDR, wait_for_offers, utm_source, unsecured-debt template override), network timeout floor, docs page `docs/nodes/achieve-offers.md` + catalog/llms.txt entries. Full guide incl. field mapping, placement recommendation (tail convergence branch_end `79d7745b`, post-response = zero latency), analysis queries: [docs/achieve-fdr-node.md](./docs/achieve-fdr-node.md). **Remaining:** add env vars (ACHIEVE_USERNAME/PASSWORD/API_URL), drop node on canvas + Save, sandbox validation, then flip API URL to prod. Nightly Snowflake export with trades joined SHIPPED 2026-06-11 (issue #28: `lib/achieve-export.ts` on the 09:00 UTC cron, backfills `achieve_evaluations.trades` from the execution`s `trades_request` step at export time, MERGEs VARIANTs to a self-created Snowflake table, purges 24h after export). **Open with Geoff/Achieve:** trusted_form_cert (doc says required, we have no TrustedForm certs), consents text, whether over-20k exit path gets a second node.

  **Restart 2026-08-17.** Testing was paused 2026-07-15 by setting `ACHIEVE_MIN_VANTAGE_SCORE` to 1000000000, which skips every lead; the node, prod URL and credentials were never touched. Achieve then confirmed credentials good, banking (Cross River) approved, and asked for `utm_source` to change from `pennie` to `pennie_apl` (Nicole Wickswat, 2026-08-17). `ACHIEVE_UTM_SOURCE=pennie_apl` is set. **Pre-send screening now shipped** against Achieve's own recommended criteria (Evan Raciti, 2026-07-15), as a hard gate per Dan: `engine/nodes/achieve-screen.ts` plus `engine/nodes/achieve-credit-report.ts`, all thresholds env vars that are inert when unset, one rejection reason per criterion. Nine of Achieve's criteria are buildable; citizenship is not collected anywhere and their DTI rule describes their own prequalification stage. Four criteria (delinquencies, bankruptcy age, inquiries, monthly obligations) come from the Equifax report we already pull and previously discarded everything but the score from. Full env var table and the measured volume cost: [docs/nodes/achieve-offers.md](./docs/nodes/achieve-offers.md). **Still needed to go live:** Geoff's score floor, then clear `ACHIEVE_MIN_VANTAGE_SCORE`. **Open question for Nicole:** whether "Current delinquencies: 0" means currently past due (`ACHIEVE_DELINQUENCY_MODE=current`, the default, ~47% of leads) or any bad mark ever (`ever`, ~26%), and whether their "$10k to $50k" reads the requested loan amount or the unsecured debt total.
- [x] **Estimated cost per execution** (2026-04-23) — `workflow_executions.cost_usd` + `cpu_ms` columns; engine writes step-based slice (partner API calls + code-node WFP + Supabase per-run) at finalize; `apps/worker-tail` tail consumer adds the main-Worker CF request + CPU slice using true `cpuTime` from `TraceItem`; `Est. cost` column on dashboard by-workflow table. Rates live in `apps/worker/src/engine/cost-rates.ts`. Partner per-call rates empty until contracts are confirmed.
- [ ] **Unified log sink (CF Queue or logging Durable Object)** — today every engine step writes to Supabase via `waitUntil()`, which gets logging off the request critical path but has three weaknesses: (1) no retry/buffering when Supabase is down — failed writes are silently lost; (2) no batching, so each step is an individual insert and `execution_steps` write volume scales linearly with step count (already feeling this in disk growth — see memory `project_supabase_disk_growth_2026_05_18`); (3) Snowflake export, Slack alerts, and Supabase each re-walk the same data instead of subscribing to one stream. A Queue or DO sink that the engine fires-and-forgets into, with a separate consumer draining to Supabase + Snowflake + alert fan-out, fixes all three. Trade-off: new moving part + ~10-100ms consumer lag (fine for logs, not for real-time alerting). Defer until `execution_steps` write volume becomes the bottleneck — `waitUntil` is doing its job at current scale.
- [ ] **Latency Gate node — bid→confirmation redirect-fail control** (2026-05-22) — first-class `latency_gate` node so networks that charge on match (ping→bid→waiting period→Bid Win Confirmation→our response) can be gated: `mark` stamps the bid time in `SUBMISSIONS` KV; `check` measures latency on the confirmation and routes `within` / `exceeded` against a per-partner threshold (`partner_configs.confirmation_window_ms`, node `threshold_ms` override). Over threshold (or a missing mark) routes `exceeded` = reject due to latency. Built for Lead Economy but general to any match-charging partner. Code shipped + tested (`apps/worker/src/engine/nodes/latency-gate.ts`, canvas + partner-settings wiring); redirect-fail itself (accepted lead, no page-load confirmation) stays SF-tracked and separate. **Remaining before live:** (1) apply migration `20260522000001_partner_confirmation_window.sql` (`supabase db push`); (2) build the Lead Economy ping/bid + confirmation workflows on the canvas (mark on bid, check on confirmation → SF write + Response); (3) blockers owned by BC/partner — the correlation ID echoed on both the bid and the confirmation, and the SF field names for the report.
- [x] **Stop writing the `persons` table (it was dead weight)** (2026-06-01, shipped 2026-08-14, #765). `persons` was **write-only with no reader**: the only `.from('persons')` sat inside its own writer, nothing in the engine, API or dashboard read it back, and it was **NOT in the Snowflake data path** (the export reads `lead_sightings`, whose raw `ssn` is written directly by `insertSighting`, independently of the persons write). It reached **3,694,280 rows / 4,184 MB** by 2026-08-13, the largest table in a 27 GB database, and every trigger paid an AES-GCM encrypt per PII field for a row nobody would read. **Done:** the `upsertPerson` call is gone from the trigger boundary (`engine/index.ts`) and the admin backfill (`routes/api/admin.ts`), the writer itself is deleted from `engine/lead-sightings.ts`, and `lead_sightings.person_id` is now always null (an already supported nullable state). Repeat lead grouping runs on the raw `ssn` already in Snowflake. Guarded by `engine/__tests__/persons-write-removed.test.ts`, which drives the real writer against a recording Supabase double and fails if any access to `persons` reappears. Deleting the writer also resolves **#90**: it base64'd its ciphertext into BYTEA without a `\x` prefix, so `decryptPii` could not round trip a stored row, and with no writer no new rows can be in that format. `persons` the table and `persons-crypto.ts` are left dormant so reveal PII in UI stays cheap to re-enable. **Disk reclaimed 2026-08-14** with Dan's sign-off: `TRUNCATE public.persons` (3,713,961 rows to 0, 4,216 MB to 40 kB) and `DROP TABLE public.lead_sightings_2026_06` (2,044 MB, zero live rows). Database went 26.14 GB to 20.03 GB, a 6.11 GB reclaim matching the two objects exactly. Checked first that NO foreign key references `persons`, which mattered because 107,106 `lead_sightings` rows still carried a non-null `person_id`: with an FK present a plain TRUNCATE would have errored and CASCADE would have taken `lead_sightings` with it. Roughly 180 MB more sits in other drained past partitions and was deliberately left, because `POST /api/admin/backfill-sightings` stamps rows with the original execution's timestamp, so dropping a past month's partition permanently removes the ability to re-run a backfill for that month (the same call #464 has to make). Note: `persons` cannot be time partitioned for clean partition drop because its dedup unique key `(organization_id, ssn_hash)` spans all time.

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

- [x] **Audit log** — smoke test in `lib/__tests__/audit.test.ts` (verify insert shape, no throw on Supabase error)
- [x] **Definition loader / KV cache** — tests in `engine/__tests__/definition-loader.test.ts` (cache hit skips Supabase, cache miss fetches and stores, invalidate removes key)
- [x] **Env var routes** — tests in `routes/api/__tests__/env.test.ts` (CRUD, secret masking on read)
- [x] **Integrations routes** — tests in `routes/api/__tests__/integrations.test.ts` (Slack OAuth connect, list connections, delete)
- [x] **Playwright E2E** — setup complete. Auth via e2e-test@trypennie.com (hidden from access UI). Tests: auth redirects, dashboard, workflows CRUD, env vars CRUD, sources CRUD, integrations. Run with `pnpm run test:e2e` (requires `pnpm dev:web` + `pnpm dev:worker`, or set `BASE_URL` to prod URL).
  - **In CI (#673):** only `a11y.spec.ts` runs automatically, on every PR and push to main (the `Accessibility (axe)` job), against a dev server on the runner. The rest of the suite is still run by hand, so it can still drift. Note `next start` cannot serve this app (16 pages are `runtime = 'edge'`); scanning the next-on-pages artifact, which is what prod actually runs, is the open follow-up (dev CSS is not prod CSS, so a prod-only contrast regression can slip past today).

---

## Pre-Ship Checklist (run before each phase ships)

- [x] All tests pass (unit + integration + load)
- [x] No hardcoded secrets or credentials in codebase
- [x] RLS policies verified (user in org A cannot see org B data)
- [x] Webhook auth rejects invalid/missing API keys
- [x] Error handling: no unhandled promise rejections in Worker
- [x] Execution logs writing correctly (check Supabase)
- [x] Slack alerts firing on failure
- [x] Audit log capturing all mutations
- [x] Code pushed to GitHub, CI green
- [x] KV cache invalidation working on workflow save
