# Phase 4a (#423) — Coverage foundation

> First of two plans for Phase 4 of the silent-output-field detection milestone
> (#410). 4a builds the "know what we cover" pieces: watched-field metadata,
> silence-with-reason storage + skip, and a read-only coverage manifest API. 4b
> (separate plan) turns the log-only detector into a real Slack alerter (send +
> per-field cooldown + org-scoping) and is sequenced near the dark-week flip.
> Decisions made with Dan 2026-06-29: two-plan split; manifest = read-only worker
> API; silences set via worker API.

## Goal

Give ops a way to see exactly what the detector watches per workflow (with each
field's source and current health), to see and set silences (fields legitimately
allowed to be empty, with a required reason), and make the detector skip silenced
fields. This is the foundation the Phase 4b alerts and the eventual go-live build
on. Everything here is additive; the detector stays log-only.

## Components

### 1. Watched-field metadata (`apps/worker/src/engine/watched-fields.ts`)

Phase 1 returns only `string[]`. Add the richer derivation the manifest needs:

```
type WatchedFieldSource = 'structured' | 'code'
interface WatchedField { path: string; source: WatchedFieldSource }
interface WatchedFieldMap { fields: WatchedField[]; unreadableNodes: string[] }
deriveWatchedFieldMap(definition: WorkflowDefinition): WatchedFieldMap
```

- `collectStructuredRefs` contributes `source: 'structured'`; `collectCodeRefs`
  contributes `source: 'code'` and, when it bails open (dynamic access), records
  the code node's `namespace` in `unreadableNodes`.
- Dedup by `path`; if a path is reached both structurally and via code, keep one
  entry (source `'structured'` wins, since a structured reference is the
  higher-confidence signal).
- `deriveWatchedFields(definition): string[]` becomes
  `deriveWatchedFieldMap(definition).fields.map((f) => f.path)` (sorted, deduped),
  so the Phase 0 finalize capture seam is byte-for-byte unchanged.

To record `unreadableNodes`, the code path needs each code node's namespace.
`deriveWatchedFieldMap` iterates `definition.nodes`, and for each code node runs
`collectCodeRefs(script, set)`; when it returns `false` (bailed), push
`node.namespace` to `unreadableNodes`. (The existing `deriveWatchedFields` loop
already visits each node's script; this just records the bail.)

Pure, fully unit-tested.

### 2. Silences table (`supabase/migrations/20260629000002_field_presence_silences.sql`)

```
field_presence_silences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL,
  field_path   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  UNIQUE (workflow_id, field_path)
)
```
- Index on `workflow_id` (the detector + manifest both query by workflow).
- RLS enabled, org-scoped via the `workflows` join (mirrors `field_presence_daily_org`).
- Applied to prod by hand (dashboard SQL editor + register in
  `supabase_migrations.schema_migrations`); hand-authored `database.ts` types +
  a drift guard (same pattern as Phase 2). Additive/expand-only.

### 3. Detector silence-skip (`apps/worker/src/lib/field-presence-anomaly.ts`)

The Tier-1 and Tier-2 orchestrators load the silences for the active workflows
(one `field_presence_silences` read, keyed `${workflow_id} ${field_path}`) and
drop any hit whose `(workflow_id, field_path)` is silenced before logging. Still
log-only. A pure helper `excludeSilenced(hits, silenced)` keeps the filter
unit-testable; the read stays in the orchestrator.

### 4. Coverage API (`apps/worker/src/routes/api/field-coverage.ts`)

A Hono sub-router mounted at `/api/field-coverage` in `routes/api/index.ts`,
behind the existing `jwtAuth` (org scoping comes from the authed user's org; every
handler verifies the `:workflowId` belongs to the caller's org before reading or
writing, returning 404 otherwise).

- `GET /api/field-coverage/:workflowId` → the manifest:
  - `fields`: `[{ path, source, health }]` where `health` per field =
    `{ latest_day, ran, present, rate, drought, dead }` computed by reading the
    recent `field_presence_daily` window and reusing `findDroughts`/`findDayOneDead`
    (drought/dead booleans) plus the latest day's raw counts. A field with no
    rollup rows yet → `health: null` (not captured / flag off).
  - `unreadable_nodes`: from `deriveWatchedFieldMap`.
  - `silences`: `[{ field_path, reason, created_at }]` from the table.
  - The watched map is derived from the workflow's current definition (load via
    the existing definition loader / KV cache).
- `POST /api/field-coverage/:workflowId/silence` `{ field, reason }` → upsert into
  `field_presence_silences` (reason required, 400 if missing); `created_by` = the
  authed user's email. Writes an audit log entry (mirror other mutating routes).
- `DELETE /api/field-coverage/:workflowId/silence` `{ field }` → delete the
  silence; audit log.

## Decisions (recorded)

1. **Two-plan split.** 4a = foundation (this doc); 4b = Slack send + per-field KV
   cooldown + org-scoping, sequenced near the dark-week flip where go-live risk
   concentrates.
2. **Manifest = read-only worker API**, not a dashboard or Slack digest in v1.
   Cheapest, queryable on demand, no recurring Slack noise. A thin frontend page
   can render it later.
3. **Silences set via worker API**, not hand-DB-edits and not a canvas UI in v1.
   Clean programmatic path the frontend can wire to later.
4. **Structured source wins on dedup** (higher-confidence than a code-scan match).
5. **No flip-live in 4a** (or 4b's build) — flipping `FIELD_PRESENCE_CAPTURE` is
   the ops gate after a full-traffic dark week.

## Testing

- `deriveWatchedFieldMap`: structured-only, code-only, both-sources-dedup
  (structured wins), unreadable-node recorded on a dynamic-access code node;
  `deriveWatchedFields` still returns the same sorted path list as before.
- `excludeSilenced`: drops silenced pairs, keeps others, key collision safety.
- Silences migration: drift guard (types match DDL columns), like Phase 2.
- Coverage API: GET returns manifest shape, scoped to org (wrong-org workflow →
  404); POST requires reason (400 without), upserts; DELETE removes. Mirror the
  route-test harness (`partner-bid-configs.test.ts`), including the `user_allowlist`
  maybeSingle mock that `jwtAuth` now requires.
- The orchestrators' silence read is thin and not unit-tested (mirrors the Phase 3
  orchestrator decision); the logic is in `excludeSilenced`.

## Non-negotiables

- Additive/expand-only migration; applied by hand; never `db push` from a laptop.
- Detector stays log-only; no Slack/cooldown here (that's 4b).
- API copy (errors) uses straight quotes, no em dashes (pre-push copy guards).
- No raw field values exposed — the manifest reports presence rates and booleans,
  not resolved values (the booleans-only invariant holds; `field_presence_daily`
  already stores only counts).
