# Plan: Scoping Bidspoke against Michael conversation (2026-04-16)

## Context

Dan had a long call with Michael walking through the "engine bidding" flow (inbound pings from engine, we return a bid) and the longer-term bidding roadmap. The call covered a mix of near-term wiring (shadow-mode cutover of the engine flow, formal auth, constants UI) and bigger architectural shifts (bid matrix as a first-class store, person/opportunity data model, win-aware dedup). The user wants a read on **what's already covered by existing Bidspoke work, what's genuinely new, and what is different or antithetical to what has been built** before any code changes happen.

This file is a gap + divergence analysis, not an implementation plan. Pick workstreams from here and ask for individual implementation plans as they get prioritized.

---

## 1. Already covered — no work needed

- **"Wait N seconds, take highest bid of whoever responded"** — Parallel node already supports `wait_for: 'all'` + `timeout_ms` + `on_timeout: 'partial'`, returning partial results and continuing. Ref: `apps/worker/src/engine/nodes/parallel.ts` lines 29-93. The "5s for M1, 15s for engine" pattern is a config value, not a new feature.
- **Highest-bid winner + fallback + no-winner exit** — Bid Evaluation node covers all three. Ref: `apps/worker/src/engine/nodes/bid-evaluation.ts`, strategies at lines 122-206.
- **Fixed-offset bids (Tripoint)** — expressible as `bid_formula = debt_amount - 100` in `partner_configs`. Confirmed at `supabase/migrations/20260402000002_core_tables.sql:217`.
- **Per-partner circuit breakers, daily caps, dedup hook, response classification** — Phase 2.1/2.2 shipped.
- **Bidspoke-side branded URLs for partners** — `*.trypennie.dev` custom endpoints are live. Ref: `apps/worker/src/routes/custom-endpoint.ts`, table `webhook_endpoints`. Ready to wire engine at e.g. `engine.trypennie.dev/bidding` without new infra.
- **Execution tracing / trace_id / Slack alerts** — Phase 2.5 shipped.

## 2. Partially covered — needs extension

- **Per-partner dedup (check before bidding)** — Partner Bid node calls an external `dedup_endpoint` today (`apps/worker/src/engine/nodes/partner-bid.ts:144-150`). Michael wants dedup to key off Bidspoke-owned person/opportunity data instead of hitting Salesforce or a partner endpoint. See §5 "Divergences" — this is the same feature, but the data source is different.
- **Env vars / Constants UI** — `apps/web/src/app/(app)/env/page.tsx` handles flat `key → string` global and workflow-scoped vars. Michael wants a richer "constants" surface for Ops (offer copy, redirect URLs, state allowlists, UUID→slug map, and the bid matrix itself) that's less engineer-coded than the workflow graph. Env page is the right *direction* but not rich enough. New per-kind tables + pages in §3.2a.
- **Pipedream importer exists** but no "engine bidding" workflow has been imported. Ref: `apps/web/src/lib/pipedream-import.ts`. Engine flow lift-and-shift is a manual step, not blocked by tooling.

## 3. New workstreams — not yet built

### 3.1 Engine Bidding workflow — lift and shift (P0, gate for everything else)
Import the Pipedream "engine bidding" workflow into Bidspoke. Dan shared the full Pipedream JSON — import via `apps/web/src/lib/pipedream-import.ts` to seed, then reshape.

**Actual node sequence** (from the JSON):
1. `constants` → loads offer copy, redirect URLs, state allowlist, subAccountUuid→name map. Replace with the Constants page (§3.2a) + lookups from Partner Bid Config (§3.2).
2. `parsed_name` → name parsing. Code node.
3. `validate_request` → basic payload validation. Code or Filter node.
4. `validate_bidding_and_state` → checks `subAccountUuid → name` → is_active in data store → state allowlist → valid name. Three early-exit rejections. Maps to: partner slug resolution (from payload `subAccountUuid`) → `partner_bid_configs.is_active` check → state filter from Constants → name filter.
5. `prospect_body` → build Salesforce prospect payload. Transform node.
6. `create_prospect` → POST to Salesforce. Integration node (existing SF connection).
7. `equifax_credit_report` → POST to Equifax. **Needs new Equifax integration (§3.1a).**
8. `generate_trades_body` → parse credit report, extract vantage score + trades. Code node. Also handles "no credit match" early-exit path.
9. `prospect_trades` → current SF call that parses trades + runs bid matrix lookup. **Replaced by Bid Lookup node (§3.2) + a SF call for trades persistence only.**
10. `return_response` → build engine's response JSON (bid + offer + redirect URL). Response node with templated body.
11. `patch_prospect` / `slack_alert` / `trace_id` / `custom_request` / `special_char_qa` / `filter` → side-effect and logging steps. Translate 1:1.

**Partner routing mechanism (confirmed from JSON):** Request body carries `subAccountUuid`. The `constants.subAccountIdsMap` resolves UUID → human name ("SoFi", "NerdWallet", etc.) with "Default" fallback. Bidspoke replicates this: payload field → map in Constants page → partner slug → Partner Bid Config lookup. Unknown UUID falls back to Default config.

**Response shape contract (engine consumes this — must match):**
- Success body: `{ lead_id, offer_title, offer_details, redirect_url, bid_amount, ... }` (exact shape from `return_response` code; copy it byte-for-byte)
- Rejection: `{ lead_id, status: "rejected", reason: "<reason>" }` where reason is one of `"bidding not active"`, `"ineligible state"`, `"invalid name"`, `"missing_credit_check"`, `"unqualified_lead"`
- Error: `{ lead_id, status: "error", reason: "internal server error" }` with 500 status

Parity-level migration. New features (win-aware dedup, internal person table) layer on after cutover.

**Tripoint result code range:** Approved codes are **1000-1001 and 1013-1017 only** — this matches the live classifier `tripointResult` in `apps/worker/src/engine/bid-resolver.ts` (1002-1005 and 1020 are Duplicate; everything else, including the fraud-flagged 2018-2019, is a rejection). NOTE: an earlier transcription of the Bruno call 2026-04-21 recorded "1013-2017" — that was wrong; 1013-1017 is correct. The live classifier is the source of truth; don't "fix" it toward the old range.

**Tripoint lead ID write-back (required, confirmed Bruno call 2026-04-21):** When Tripoint returns a successful response, they include a `leadId` field. This must be written back to the Salesforce prospect as `Tripoint_Lead_ID__c` so Denise can pull it for the click-through submission flow. Required in both the engine bidding workflow and the main flow. Wire as a Salesforce PATCH step immediately after a successful Tripoint bid.

### 3.1a Equifax integration (P0, in critical path)
Engine's flow calls Equifax directly (not through Salesforce). Bidspoke has no Equifax integration today. Stand it up as part of engine cutover:
- New service connection for Equifax (credentials in Cloudflare Worker secrets).
- New Integration preset for the credit report endpoint (or raw Integration node call initially).
- Schema sync optional — Equifax response shape is well-known and stable; hand-mapped fields are fine for v1.

Scope it tightly: only the one endpoint engine's flow uses (credit report pull). Broader Equifax functionality (bureau changes, soft vs hard inquiry, etc.) comes later as needed.

### 3.1b Tripoint outbound token management — Durable Object (P0, in critical path)
Bruno already built a Cloudflare Durable Object that manages Tripoint's API auth token for the Pipedream proxy. When we build the Tripoint Integration node in Bidspoke, we need to replicate this pattern — **not** fetch a new token per request.

**Why it's needed:** Tripoint's auth flow requires fetching a token before each lead submission. If concurrent requests each fetch their own token, the previous token is invalidated mid-flight and requests fail with 401. Bruno ran into this and solved it with a shared, serialized token in a Durable Object.

**Implementation:** Add a `TriPointTokenObject` Durable Object that:
- Holds the current Tripoint access token + expiry
- On `getToken()`: returns the cached token if valid, otherwise fetches a new one from Tripoint's auth endpoint and caches it
- Serializes concurrent requests — if a fetch is already in progress, subsequent calls await the same fetch rather than issuing a second one
- Wire into the Tripoint Integration node config: before any Tripoint API call, the node fetches the token from the DO and injects it as the Authorization header

This is separate from §3.4 (token auth for engine-to-Bidspoke auth) — that is inbound auth. This is outbound auth to Tripoint's API.

### 3.1c Tripoint submission workflow — 3rd workflow (P0, pre-main-flow migration)
There are three Pipedream workflows to migrate, not two. The engine-cutover-scope.md previously covered only engine bidding. The third workflow — **Tripoint submission** — must be in Bidspoke before the main flow can migrate.

**What it does:** Takes an existing Tripoint lead ID (returned from the main flow bid) and submits the full lead to Tripoint. Triggered by Denise's frontend when the user clicks through.

**Flow:**
1. Receive `leadId` (Tripoint's ID from the main flow response)
2. Submit lead to Tripoint via the proxy DO (§3.1b handles token)
3. Check response status code: **200 or 208 = success**, anything else = failure
4. On success: patch the Salesforce submission record with the result
5. On failure: flag the submission and Slack alert

**Response contract back to frontend:** Returns the raw Tripoint submit response. Frontend doesn't use the body — it only cares whether the call succeeded. Salesforce update happens server-side.

**Note from Bruno:** "all he needs to do is when we return from the main flow, there's going to be the tripoint lead ID. He needs to save that one. And then he needs to hit the tripoint submission with that as a lead ID."

### 3.1d M1 bidding architecture — ping-only, conversion is out-of-band (P0 for M1 launch)
M1's bidding flow is fundamentally different from Tripoint's, and must be implemented differently in the Partner Bid node.

**M1 flow:**
1. **PING only in the main bidding workflow** — POST to M1's ping endpoint, receive `{ bid_amount, click_through_url }` back
2. If M1 wins: return `click_through_url` to the frontend. The user clicking that URL is the "conversion."
3. **No accept/post step in the main flow.** The post on conversion is handled by a separate endpoint Brian built, triggered when Denise's frontend sends the user to the click URL.
4. **60-second delay on M1 conversion endpoint** — Brian's conversion API has a 60-second intentional delay before forwarding the request. This is a product requirement from M1, not a bug. Do not remove it.

**Implication for Partner Bid node config:** M1 needs a `bid_mode: 'ping_only'` (or similar) flag so the node knows to return the click URL as part of its output without attempting a second confirmation call. The Bid Evaluation node then uses `bid_amount` for comparison but passes `click_through_url` through to the Response node for the final payload.

**Enabling M1:** Bruno confirmed it's currently hard-coded off (returns 0 bid, always loses). To enable: remove the early-return override and pull from the Partner Bid Config. Coordinate with Brian on M1's current API response shape before flipping on.

### 3.2a Constants page (P0 — required for engine parity)
Pipedream's `constants` step returns a large config object that the whole workflow depends on. Dan wants this as a dedicated Ops page with richer editors, not flat env vars.

**Contents to migrate** (from the JSON):
- Offer copy: `offerName`, `mainOfferTitle`, `mainOfferDetails` (HTML), `sofiSellOffOfferTitle`, `sofiSellOffOfferDetails` (HTML), and probably dynamic-offer templates.
- Redirect URLs: `pennieClickUrl`, `pennieAlternateClickUrl`, `pennieExpLandingPage`, `tripointClickUrl` (the sell-off destination).
- State allowlist: `states` array.
- Partner map: `subAccountIdsMap` (UUID → slug) and `subAccountIds` (allowlist).

**Page shape:** one Ops page per kind (not a flat table), each with its purpose-built editor. Each save invalidates worker cache. Same live-edit-with-undo pattern as Partner Bid Config.

**Storage — per-kind tables** (one migration + one API route + one UI page per kind, favoring DB-level validation and type-matched editors over a generic JSONB bag):
- `offer_copy(id, org_id, key, title, details_html, updated_by, updated_at)` — rows for `main`, `sofi_sell_off`, and any dynamic-offer templates. HTML editor with preview.
- `redirect_urls(id, org_id, key, url, updated_by, updated_at)` — rows for `pennie_click`, `pennie_alternate_click`, `pennie_exp_landing`, `tripoint_click`. URL-validated input.
- `state_allowlists(id, org_id, key, states TEXT[], updated_by, updated_at)` — named allowlists (default `bidding_states`); chip-style multi-select editor.
- `partner_uuid_map(id, org_id, sub_account_uuid, partner_slug, is_active, updated_by, updated_at)` — UUID → slug lookup with a UNIQUE constraint on `(org_id, sub_account_uuid)`. Row-per-mapping editor.

Resolution in the engine workflow: partner routing reads `partner_uuid_map`, state check reads `state_allowlists[key='bidding_states']`, response body templates pull from `offer_copy` + `redirect_urls`. Each read is worker-cached with invalidate-on-save.

**Fallback path for tight timeline:** if the per-kind pages can't all ship in the 1-2 week window, ship the data model + a basic key-value admin UI first (one row edit at a time) and layer the purpose-built editors on after. Do not fall back to env vars — that loses the schema validation that motivated this choice.

### 3.2 Partner Bid Config as a first-class entity (P0 for engine parity)
Dan shared the Salesforce Apex (`BidMatrixController`) and screenshots. Real shape is richer than the transcript suggested: each partner has a bundled configuration with a main matrix, a sell-off matrix, activation flags, and a fixed set of sell-off filter thresholds. Bidspoke replicates this as **one `partner_bid_configs` entity per partner**, with a global Default config that covers "everyone else."

**Existing partners to migrate** (confirmed with Dan): SoFi, NerdWallet, EPCVIP, Dot818, Brainsome, TLG, AmOne, AmOneDirect, plus a Default row (`is_default = true`) for unspecified sub-accounts.

**Schema:**
- `partner_bid_configs(id, org_id, slug, name, is_default, is_active, landing_page_mode, test_offer_language, vantage_score_active, sell_off_filters JSONB, updated_by, updated_at)` — one row per partner plus exactly one Default row per org. `is_default BOOLEAN NOT NULL DEFAULT false` with a unique partial index `CREATE UNIQUE INDEX ON partner_bid_configs(org_id) WHERE is_default` so only one row per org can carry the flag. Resolution logic: look up by slug first; fall back to `is_default = true` if the slug didn't match. `landing_page_mode: 'default' | 'alt' | 'exp'` replaces the mutex boolean pair in Apex. `sell_off_filters` holds the 5 typed thresholds (see below).
- `bid_matrix_rows(id, config_id, is_sell_off, row_low, row_high, range_low, range_high, bid_amount, updated_at)` — mirrors `BidRangeRow__c`. `is_sell_off` distinguishes the main matrix rows from the sell-off pricing rows. Both matrices live in the same table, keyed by `(config_id, is_sell_off)`.
- `bid_config_history(config_id, changed_at, changed_by, diff JSONB)` — powers the easy-undo requirement.

**Sell-off filters** are NOT arbitrary rules — Apex pins them to 5 specific conditions, each with a value + active flag. Model them as a typed JSONB:
```json
{
  "engine_debt":        { "active": true,  "max_value": 19000 },
  "collections_percent":{ "active": true,  "min_value": 99 },
  "state_list":         { "active": true,  "states": ["DE","HI","ID","IA","ME","MT","ND","RI","VT","WA","WY"] },
  "loan_amount":        { "active": true,  "max_value": 1000 },
  "vantage_score":      { "active": false, "max_value": null }
}
```
If ANY active filter matches, the lead routes to the sell-off matrix (cheaper pricing) instead of the main matrix.

The engine debt threshold was 20,000 until 2026-09-22, when Brian had `ProspectTradeParserRest` lowered to 19,000 so leads from 19,000 up are worked as MQLs instead of sold off (#1479). Sell off is therefore any one of four conditions and not a debt band: engine debt below 19,000, eligible collections above 99 percent of Pennie debt, a state in the list, or a loan request below 1,000 (the vantage filter is inactive). Leads above 19,000 still sell off through the other three, which is why the Tripoint profile's Engine tiers keep an upper tier. The floor Tripoint receives in practice is the bid matrix's, not the formula's: sell off rows below 15,000 carry a zero bid, so nothing under 15,000 reaches Tripoint from Engine.

**Zero cells are literal $0 bids, not skip signals** — per Dan. The Bid Lookup node returns 0 as a valid bid; downstream logic decides whether to submit a $0 bid or route to sell-off based on the `sell_off_filters`.

**UI:** dedicated Ops page under a new "Bid Configs" section. One page per partner. Layout mirrors the SF UI Jeff already knows — main matrix on top, sell-off filters in the middle, sell-off matrix on bottom, config flags at the top. **Live edits with easy undo** (one-click revert on last N changes, same pattern as the existing 5s toast undos). Michael flagged fat-finger risk as the key concern, so surface the last-changed-cell prominently.

**Node:** a new "Bid Lookup" node. Config: pick a partner bid config + map trigger-payload fields to `row` and `range` dimensions (typically `debt_amount` → row, `vantage_score` → range). Execution flow:
1. Evaluate `sell_off_filters` against trigger payload. If any active filter matches, use `is_sell_off = true` rows.
2. Look up the cell where `row_low <= debt_amount <= row_high AND range_low <= vantage_score <= range_high`. Row bounds are inclusive on both ends (matches SF convention: 0-14999, 15000-19999).
3. **No matching cell → throw an error and fail the step.** Matrix gaps are treated as config errors, not soft-null behavior — fires the usual failure alert so Ops sees unconfigured ranges immediately. Downstream nodes can catch and route via the existing `on_error` node config if a workflow wants to handle it gracefully.
4. Output: `{ bid_amount, matrix_used: 'main'|'sell_off', landing_page_mode, test_offer_language }`. Partner Bid node consumes via `bid_formula: 'steps.bid_lookup.bid_amount'`. Response node reads `landing_page_mode` / `test_offer_language` to build engine's response payload.

**API:** Reese's ML work (§3.7) patches cells programmatically. Endpoint `PATCH /api/partner-bid-configs/:slug/rows` accepting `{ is_sell_off, row_low, row_high, range_low, range_high, bid_amount }`. Writes to `audit_log` + `bid_config_history`.

**Dimensionality stays flexible for future.** Even though the current SF model is locked at `row=debt × range=vantage`, Dan confirmed the Bidspoke schema should support arbitrary dimensions later. Implementation: the `row_low/row_high/range_low/range_high` columns cover today's case cleanly; a future migration can add a generic `dimensions JSONB` column if we need 3+ dimensions. Don't over-engineer now.

### 3.3 Shadow mirror mode (P0, durable feature)
Bidspoke-side flag with two states: `shadow_mode: 'off' | 'dry_run'`. No third state needed — Bidspoke and Pipedream never run with real side effects at the same time (see cutover below).

**Important constraint:** engine should not know Bidspoke exists until we cut over. Engine keeps pinging Pipedream as it does today. The mirror happens **on the Pipedream side** — a new Pipedream step that fires a fire-and-forget HTTP request to a Bidspoke shadow endpoint with the same payload. Bidspoke returns `204 No Content` immediately (after queueing the execution via `waitUntil`) so Pipedream's mirror step doesn't hang. One-way mirror; engine's contract stays unchanged.

**Phase A — Volume test (`shadow_mode: 'dry_run'`):**
Pipedream mirrors each real request to Bidspoke. Bidspoke runs its workflow — loads definition, parses payload, evaluates filters, does matrix lookups, simulates bid decisions — but **skips all external side effects**: no Salesforce writes, no Equifax calls, no partner submissions, no Slack alerts. Purpose: prove Bidspoke handles production volume and produces the same bid decisions Pipedream does.

Implementation: every node type that performs an outbound call (Integration node, Partner Bid node, Code node with fetch) checks `ctx.shadow_mode === 'dry_run'` and returns a stubbed success output instead of firing. Stub output is logged so manual spot-check of Bidspoke's decisions vs Pipedream's live outputs (same trace payload, compare logs) is straightforward.

**Cutover (`shadow_mode: 'off'`):**
Dan flips both in the same step: engine rerouted to `engine.trypennie.dev/bidding` (Bidspoke), Pipedream turned off (or its workflow disabled). Only one system running for real at any point — no duplicate prospects, no double Equifax pulls, no partners seeing the same lead twice. Pipedream stays as durable rollback: if Bidspoke misbehaves post-cutover, flip engine's routing back to Pipedream and re-enable the Pipedream workflow.

The shadow endpoint used during Phase A is a separate route from the cutover endpoint — makes it trivial to remove the Pipedream mirror step at cutover without affecting the real route. The `shadow_mode` flag stays (not scaffolding): reusable for every future partner migration.

**Implemented as (2026-06-18, branch `feature/shadow-mode`):** `shadow_mode: 'off' | 'dry_run'` on `ExecutionContext` (mapped from `ExecuteOptions.shadowMode`). The `/shadow/:workflow_id` route returns 204 and runs the workflow via `waitUntil` with `isTest: true` (so all existing test-run suppression applies: no sightings, no Slack alerts, excluded from prod dashboards) plus a `__shadow` source suffix for filtering, rather than a new `workflow_executions` column (which would be risky DDL on a hot partitioned table). Outbound first-class nodes (Integration, Salesforce, Partner Bid, Achieve Offers) check `isShadowDryRun(ctx)` and return a tagged stub; Data Store skips KV writes. The engine cannot introspect a Code node's sandbox, so it passes `shadow_mode` into the sandbox body, meaning each outbound Code script to self-stub. **Correction 2026-10-05 (#1780):** none ever did, because the bundled script never receives `shadow_mode`, so a Code node made its real calls (the Equifax pull among them) on a shadow run. A shadow run of a workflow carrying a Code node is now refused before anything runs, until #1708 part B sandboxes it. See [shadow-mode.md](./shadow-mode.md).

### 3.4 Token-based auth for bidding endpoints (P0, hard blocker for cutover)
Engine uses a two-step flow: hit `/token` to mint a token, send the token on `/bidding`. M1 already enforces this. Dan confirmed cutover does not happen until token auth is in place — no shipping on X-API-Key as an interim. Scope:
- New `issued_tokens` table: `(token, source, issued_at, expires_at, last_used_at)`.
- New `POST /token` route that validates static credentials (per-source API key) and mints + returns a short-lived bearer token scoped to that source.
- New middleware mode on custom endpoints: `auth_mode: 'api_key' | 'token'` on the `webhook_endpoints` row. Existing X-API-Key stays as the default for workflows that choose it (per Dan's "coexist, per-workflow choice" decision). Engine's branded endpoint gets `auth_mode: 'token'` from day one.
- Token validation middleware: lookup by token, check `expires_at`, update `last_used_at`, reject 401 on miss/expired.

This is additive to the existing X-API-Key path — no deprecation needed. Phase A shadow mirror can run on X-API-Key (Pipedream is the caller, not engine) since engine never hits Bidspoke during shadow.

### 3.5a Win tracking via scheduled Salesforce pull (P1)
Dan confirmed: "win" means the lead monetized downstream (not just that the partner accepted the bid), and the signal comes from Salesforce — we check the prospect's status there. Implementation:
- A scheduled Bidspoke workflow runs **hourly**, pulls recent prospect stage changes from Salesforce via the existing Salesforce Integration, and updates matching `opportunities` rows (§3.5) with `bid_accepted` (fires at bid time) and `monetized` (set when the pull finds a matching stage change).
- **Manual "Run now" trigger** on the dashboard so Ops can force a pull when they know a stage change just happened. Same handler, invoked via button click → POST to the scheduled workflow's trigger URL.
- Hourly is well within SF API limits (Pennie's Enterprise org has 100K+ daily API calls; 24 hourly pulls is trivial).
- Both fields persist separately — dedup logic (§3.5) can use either depending on the workflow's preference. Reese's ML work uses both to distinguish short-term bid acceptance from long-term value.

### 3.5 Person + Lead Sightings + Opportunity data model (P1, **after** engine cutover)
Dan confirmed this ships **after** the initial cutover, not before. Cutover proceeds at parity with today's SF-side dedup; then this layer replaces it and fixes the revenue leak from unwon-lead rejection.

Bidspoke becomes system of record for bid outcomes. Three-table shape per Dan's choice:
- `persons(id, ssn_encrypted, ssn_hash, created_at, ...)` — one row per unique SSN.
- `lead_sightings(id, person_id, workflow_id, execution_id, sub_account, seen_at, outcome)` — **every time we see an SSN**, including leads we skipped due to sell-off filters or never bid on. Powers Michael's "this lead cycled 6 times across 2 sub-accounts" metric.
- `opportunities(id, person_id, workflow_id, execution_id, sub_account, bid_amount, bid_accepted, monetized, created_at)` — **only when a real bid was sent** to a partner. Fewer rows, clearer per-bid semantics.

**SSN storage — two-column pattern** (handles Dan's "match to match, but also show the actual value" requirement):
- `ssn_encrypted`: AES-GCM ciphertext of the SSN, encrypted in the Worker using a Cloudflare Worker secret key (same pattern as `SECRET_ENCRYPTION_KEY` in CLAUDE.md). Used when the UI or an API caller needs to reveal the SSN — decrypt on read.
- `ssn_hash`: deterministic SHA-256 of `SSN || pepper` where pepper is a second Worker secret. This is the indexed, unique column. All matching ("have we seen this SSN before?") runs as `WHERE ssn_hash = digest($input, pepper)` — fast, no decryption needed. Because the pepper is secret, an attacker who dumps the DB cannot brute-force SSNs even though hashes are deterministic.
- Both secrets must be set before the first row is written; rotation story: keep old key available for decrypt, re-encrypt rows with new key on read. Similar caveats to env-var encryption.

**Unlocks:**
- **Win-aware dedup:** reject a repeat lead only if we *won* a previous bid within the window, not just because we *saw* them. Today's SF 60-day dedup rejects unwon leads too — direct revenue leak.
- **Repeat-lead reporting** (§3.6): "this SSN cycled 6 times across 2 sub-accounts."
- Foundation for Reese's outcome-driven bid optimization.

Partner Bid gets a new `dedup_mode: 'internal_opportunity'` that queries the opportunities table instead of hitting an external endpoint. Existing external-HTTP dedup mode stays for partners that need it.

### 3.6 Repeat-lead visibility in dashboard (P2, depends on 3.5)
New dashboard view: per-person timeline, per-SSN churn counts, cross-sub-account overlap. Blocked on §3.5.

### 3.7 Dynamic bid optimization hooks (P3, design-accommodation only)
Reese's longer-term work reads outcomes and adjusts bid matrix cells. No implementation now — just make sure §3.2's matrix API supports programmatic patches with audit trail so this slots in without a rebuild.

### 3.8 Under 20K remarketing workflow — fan-out bidding (P1, post-cutover)
New workflow, not previously in scope. Surfaced in Bruno call 2026-04-21.

**Trigger:** User returns to the "get offers" landing page (under 20K debt flow) — either a remark or a second-look after not clicking through initially.

**Fan-out strategy (confirmed by Dan and Jeff on the call):**
1. Hit M1, Tripoint, and engine **simultaneously** in a Parallel node
2. Wait up to **10 seconds** for M1 or Tripoint to respond
3. If either M1 or Tripoint responds within 10 seconds: route to the higher of the two bids. Engine is ignored even if it eventually responds.
4. If neither M1 nor Tripoint responds within 10 seconds: route to engine (engine can take up to 20 seconds; acceptable as last resort)
5. If all three fail: no offer, exit

**Why deprioritize engine:** Engine's second-look process (Salesforce lookup, external scoring) can take up to 20 seconds. M1 and Tripoint respond in under 5 seconds typically. Sequential wait would compound latency; parallel with early-exit avoids it.

**Implementation notes:**
- Use Parallel node with `wait_for: 'first_success'` or `on_timeout: 'partial'` + `timeout_ms: 10000`
- Bid Evaluation node needs to know which results came from M1/Tripoint vs engine to implement the "prefer M1/Tripoint even if engine responded first" rule. Add a `source` field to each parallel child's output.
- M1 in this flow is still ping-only (§3.1d) — if M1 wins, return the click URL.
- This workflow is distinct from the engine bidding workflow (§3.1) — it handles inbound from Denise's landing page, not from engine's ping.

## 4. Dependencies and suggested order

```
Critical path to engine cutover (target: 1-2 weeks — realistic risk called out below):

  3.3 shadow Phase A (dry_run) ──→ volume test live (goal: this week)
                                          │
  3.1  engine workflow lift-and-shift ────┤
       + result codes 1013-1017 only      │
       + Tripoint lead ID → SF write      │
  3.1a Equifax integration (new) ─────────┤
  3.1b Tripoint token DO (new) ───────────┤
  3.2  Partner Bid Config + Lookup node ──┤─→ parity validated via
  3.2a Constants (per-kind tables + UI) ──┤   manual spot-check
  3.4  Token auth (hard blocker) ─────────┤   (Pipedream logs vs. Bidspoke
                                          │    dry-run outputs, same payload)
                                          │
                                          └─→ engine cutover on token auth

Pre-main-flow migration (before main flow can move):
  3.1c Tripoint submission workflow (3rd workflow)
  3.1d M1 ping-only architecture + 60s conversion delay

Follow-on (after cutover, in priority order):

  3.5 person + lead_sightings
      + opportunities ─────────┬─→ win-aware dedup on Partner Bid
                               │     │
                               │     ├─→ 3.6 repeat-lead reporting
                               │     └─→ 3.7 dynamic bid updates (Reese)
                               │
  3.3 Phase B (full parity) ───┘ (only if end-to-end parity test is needed)

  3.8 Under 20K remarketing workflow (M1 + Tripoint + engine fan-out, 10s timeout)
```

**Critical path honest assessment:** The 1-2 week target is tight with four new workstreams (§3.1a Equifax, §3.2 bid config, §3.2a Constants, §3.4 token auth) plus the engine workflow port in §3.1. Realistic de-scoping levers:

1. **Ship minimal Constants UI for §3.2a** — build the 4 tables + a generic single-row admin page first; layer the purpose-built editors (HTML preview, chip inputs) on after cutover. Data model is the hard part; editor polish is not blocking.
2. **Phase A first, cutover when pieces land** — ship shadow Phase A this week (only depends on the mirror route + dry_run flag) to prove volume-handling. Cutover when §3.1, §3.1a, §3.2, §3.4 are actually done, rather than forcing the timeline.
3. **Token auth scope trim** — ship the minimum viable token flow (`POST /token`, bearer validation, no refresh/rotation tooling) for cutover. Rotation UI and admin tooling come later.

Dan's target remains 1-2 weeks; flag all three levers early if the timeline slips. **No shipping on X-API-Key for cutover** — token auth is a hard gate, not a stretch goal.

## 4a. Notes on existing patterns to reuse

- **Partner Bid node's dedup branching** (`apps/worker/src/engine/nodes/partner-bid.ts:144-150`) is the pattern to extend for §3.5's internal-opportunity dedup mode. Keep the existing `dedup_endpoint` HTTP mode for partners that use it.
- **Environment Variables page** (`apps/web/src/app/(app)/env/page.tsx`) is the UI pattern template for the new Partner Bid Config page — same scaffolding, richer per-row editing.
- **Existing partner_configs table** already handles circuit breakers, daily caps, API endpoints, bid formulas. Partner Bid Config (§3.2) is a *sibling* table focused on matrix-based pricing — don't conflate them. A partner can have both: `partner_configs` for connectivity + circuit behavior, `partner_bid_configs` for pricing.
- **Custom endpoints middleware** (`apps/worker/src/routes/custom-endpoint.ts`) gets an `auth_mode` branch for §3.4 token auth. Existing X-API-Key path stays untouched.
- **Circuit breaker Durable Object** — already wired for partners. Partner Bid node already checks it before calling. No changes needed for §3.2.

## 5. Divergences and antithetical patterns to resolve

Not deal-breakers — but worth flagging so we don't build the wrong thing.

- **Dedup architecture shift.** Partner Bid's `dedup_endpoint` is currently an HTTP call to an *external* service per bid. Michael's model treats dedup as an *internal* query against our own opportunity history, win-gated. These aren't the same feature wearing different paint — the call semantics differ (HTTP round trip vs DB query), and who owns "winner" state differs. Cleanest resolution: keep `dedup_endpoint` as one mode, add `dedup_mode: 'internal_opportunity'` that reads from §3.5's tables. Don't rip out the HTTP mode — M1-style partners may still need it.

- **Bid source architecture.** `partner_configs.bid_formula` is *one expression* evaluated against the trigger payload. A bid matrix is *a lookup* keyed on fields derived from credit data. Trying to collapse both into a single `bid_formula` string will get ugly. Keep them as separate layers: matrix lookup runs first (produces `bid_ceiling` or similar into context), then Partner Bid can still formula-adjust if needed.

- **Scope expansion from "workflow engine" to "identity + opportunity store."** Bidspoke was framed as a workflow orchestrator. Adding persons + opportunities + win tracking moves it toward a CRM-lite. Not antithetical, but it changes what "RLS scoping" means (cross-org identity is sensitive), changes retention policy (we're now a system of record for bidding outcomes, not just a log tail), and changes the pg_cron purge story in TODO §1.1. Worth an explicit decision before §3.5 lands: is Bidspoke the source of truth for bid outcomes, or a reporting cache over Salesforce?

- **Ops UI vs canvas.** Michael's direction is "top-level constants and bid matrix live in a UI *outside* the workflow graph, so Jeff can edit without touching nodes." The existing Env Vars page is the closest analog. This isn't antithetical but it's a shift from "everything's a node" toward "some config is a first-class table." Worth aligning on before §3.2's UI work.

## 6. Critical files referenced

- `apps/worker/src/engine/nodes/parallel.ts` (lines 29-93) — confirms wait-timeout-partial semantics exist
- `apps/worker/src/engine/nodes/partner-bid.ts` (lines 144-178) — dedup + bid-source branching to extend
- `apps/worker/src/engine/nodes/bid-evaluation.ts` (lines 122-206) — winner + fallback logic
- `apps/worker/src/routes/custom-endpoint.ts` — reuse for `engine.trypennie.dev/...`
- `apps/worker/src/middleware/api-key-auth.ts` — add token-mode branch here in §3.4
- `apps/web/src/app/(app)/env/page.tsx` — pattern to clone for bid matrix and constants UIs
- `apps/web/src/lib/pipedream-import.ts` — use to seed §3.1
- `supabase/migrations/20260402000002_core_tables.sql` (lines 208-235) — partner_configs schema; new migrations will sit alongside

## 7. Answered questions and follow-ups

**Answered by Dan 2026-04-16:**

1. **Bidspoke is system of record for bid outcomes.** Commits §3.5 to full scope: persons + opportunities tables are authoritative, not a cache. Retention policy in TODO §1.1 needs revisiting — can't purge bid outcome rows on the same 90-day schedule as execution logs. Reese's dashboards will query these directly.
5. **Token auth and API key auth coexist, chosen per workflow.** §3.4 middleware will branch on `webhook_endpoints.auth_mode`. No deprecation path needed.

2. **Shadow mode is a Bidspoke-side `shadow_mode` workflow flag** that suppresses the response but runs everything else. Pipedream stays as durable fallback post-cutover — we flip engine's routing, not Bidspoke's code, if we need to revert.
3. **Bid matrix uses flexible dimensions** — JSONB dimension map driven by a per-matrix `dimension_schema`, not a locked 2D shape.
4. **SSN uses two-column storage**: AES-GCM encrypted column for reveal + peppered SHA-256 hash column for matching. Same encryption pattern already in use for env-var secrets.

**Additional answers 2026-04-16:**

- **Shadow mode has two states, not three.** `shadow_mode: 'off' | 'dry_run'`. Phase A (dry-run) + cutover (off) is the full shape. No Phase B dual-run is needed because Dan will turn Pipedream off at the same moment he flips engine to Bidspoke — only one system with real side effects at any point.
- **Bid matrix edits are live, with easy undo surfaced in the UI** (same toast-undo pattern used elsewhere). No draft/publish step.
- **Opportunities retention: keep 2+ years active, archive older to R2/Snowflake via existing Logpush pipeline.**
- **Token auth lands before engine cutover.** Moved to P0 and added to the critical path in §4.

**Additional answers 2026-04-16 after reviewing SF Apex + screenshots:**

- **Bid matrix is really a bundled Partner Bid Config** (main matrix + sell-off matrix + flags + sell-off filters). One per partner; Default covers "everyone else." Fixed partner list to migrate: SoFi, NerdWallet, EPCVIP, Dot818, Brainsome, TLG, AmOne, AmOneDirect, Default.
- **Sell-off conditions are 5 typed filters**, not arbitrary rules — simplifies implementation.
- **Zero cells are literal $0 bids.** Bid Lookup returns 0 as valid; sell-off routing is decided by the sell-off filters, not by 0-cell detection.
- **All four matrix flags are Bidspoke's concern** (Activate Bid Matrix, Alt Landing Page, Exp Landing Page, Test Offer Language) — they currently drive Apex behavior that we'll replicate, and landing_page_mode feeds the bidding response. Alt/Exp are mutex — collapse into a single `landing_page_mode` enum.
- **Win definition: lead monetized downstream** (not just bid accepted). Win data flows back via scheduled Salesforce pull — see new §3.5a. Track both `bid_accepted` (immediate) and `monetized` (later) as separate fields.

**Additional answers 2026-04-16:**
- **§3.5 ships after cutover**, not before. Keeps initial ship tight. Win-aware dedup is a follow-on revenue-leak fix.
- **Missing-cell in Bid Lookup = throw + fail the step.** Matrix gaps treated as config errors; workflows can catch via existing `on_error` if graceful handling is needed.
- **Two tables: `lead_sightings` (every SSN arrival) + `opportunities` (only real bids).** Clearest semantics.
- **Target cutover: 1-2 weeks.** Token auth is a **hard blocker** — no shipping on X-API-Key as an interim. §3.4 is on the critical path.
- **Partner routing confirmed from Pipedream JSON:** payload field `subAccountUuid` → `partner_uuid_map` (§3.2a) → slug → Partner Bid Config. Unknown UUID → row marked `is_default = true`.
- **Response shape contract confirmed from Pipedream JSON.** Must match byte-for-byte on field names + reasons for early-exit rejections.
- **Equifax needs a new integration** (§3.1a) — added to critical path.
- **Constants use per-kind tables** (not a generic `app_constants` JSONB) — `offer_copy`, `redirect_urls`, `state_allowlists`, `partner_uuid_map`. Better Ops UX and DB-level validation. Fallback is a minimal single-row admin UI, not env vars.
- **Default Partner Bid Config uses `is_default BOOLEAN`** with a unique partial index — one default row per org. Resolution: match slug first, fall back to `is_default = true`.
- **Shadow Phase A mirror happens on Pipedream's side** (fire-and-forget HTTP step to Bidspoke). Engine does not know Bidspoke exists until cutover. Bidspoke returns `204 No Content` to keep Pipedream's mirror step fast.
- **Partner list is final**: SoFi, NerdWallet, EPCVIP, Dot818, Brainsome, TLG, AmOne, AmOneDirect, and a Default row. No further confirmation needed before migration.
- **SF pull cadence is hourly, with a manual "Run now" button** on the dashboard for Ops. SF API limits are not a constraint (Enterprise org has headroom).
- **Phase B duplicate-prospect strategy is N/A** — Dan will flip engine's routing and disable the Pipedream workflow in the same step at cutover, so both systems never run for real in parallel. Pipedream stays warm purely as a rollback target, not as a second live system.

**Additional answers from Bruno call 2026-04-21:**
- **Tripoint result codes are 1000-1001 and 1013-1017.** Anything outside (including the fraud-flagged 2018-2019) is a rejection. The earlier "1013-2017" here was a transcription error — 1013-1017 matches the live classifier. (§3.1 updated.)
- **Tripoint lead ID must be written to Salesforce prospect** (`Tripoint_Lead_ID__c`) after every successful bid so Denise can close the loop on click-through. Required in engine bidding and main flow. (§3.1 updated.)
- **Tripoint outbound auth requires a shared token Durable Object** (§3.1b). Bruno already built this for the Pipedream proxy; Bidspoke needs the same pattern. Per-request token fetching causes 401 races under concurrent load.
- **Three workflows to migrate, not two.** Engine bidding, main flow, and Tripoint submission (§3.1c). The submission workflow is triggered by Denise when a user clicks through.
- **M1 is ping-only in the bidding flow** (§3.1d). No accept/post happens in the main workflow. Post on conversion is a separate endpoint Brian built with a required 60-second delay. M1 currently hard-coded off; enabling requires removing Bruno's early-return override and confirming M1's current API response shape with Brian.
- **Under 20K remarketing workflow** (§3.8) is a new workflow needed for the remark/second-look flow. Fan-out M1 + Tripoint + engine simultaneously, 10-second window for M1/Tripoint, fall back to engine if neither responds.
- **Pipedream has been hanging randomly without errors** — Bruno can't reproduce or trace it. Accelerates urgency to cut over; not blocking but confirms migration is right call.
- **Bruno confirmed 2-week migration window** and is aligned on keeping Pipedream warm as rollback target.

## 8. Verification

This plan is a scoping doc — no code changes. Verification = alignment:
- Share with Michael before next working session; walk through §3.1–§3.4 critical path and §3.5 follow-on.
- Request individual implementation plans per workstream, starting with §3.3 Phase A (fastest to ship, unlocks volume test this week).
