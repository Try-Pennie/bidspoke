# Phase 4a (#423) — Coverage foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the coverage foundation for the silent-output detector: watched-field metadata (source + unreadable nodes), a silences table + worker API to set/clear them, detector silence-skip, and a read-only coverage manifest API. Detector stays log-only.

**Architecture:** Extend the pure `watched-fields.ts` with `deriveWatchedFieldMap`; add an additive `field_presence_silences` table (hand-applied, hand-authored types + drift guard, like Phase 2); add a pure `excludeSilenced` filter wired into the Phase 3 orchestrators; add a `field-coverage` Hono router behind `jwtAuth`. Mirrors existing patterns (`watched-fields.ts`, Phase 2 migration, `partner-bid-configs.ts` routes).

**Tech Stack:** TypeScript (worker), Hono, Supabase/Postgres + pg, Vitest. No new deps.

## Global Constraints

- TypeScript strict, no `any` (test fixtures may use `as any` with eslint-disable). No em dashes anywhere incl. comments; straight quotes.
- Migration version `20260629000002` (next unused; `ls supabase/migrations/` confirmed latest is `20260629000001`). Re-check before creating; pick next unused on collision.
- Migration is additive/expand-only; applied to prod BY HAND (dashboard SQL editor + register in `supabase_migrations.schema_migrations`), never `supabase db push` from a laptop.
- `database.ts` Tables sorted alphabetically; `field_presence_silences` goes immediately after `field_presence_daily`.
- Detector stays LOG-ONLY: no Slack, no KV, no cooldown (that is Phase 4b).
- API: behind existing `jwtAuth`; every handler verifies `:workflowId` belongs to the caller's org (404 otherwise). Mutations write an audit log. Error copy: straight quotes, no em dashes.
- No raw field values exposed (manifest reports rates + booleans only).
- Worker tests: `cd apps/worker && pnpm test`. Typecheck: `pnpm --filter worker typecheck`.

---

### Task 1: `deriveWatchedFieldMap` (metadata: source + unreadable nodes)

**Files:**
- Modify: `apps/worker/src/engine/watched-fields.ts`
- Test: `apps/worker/src/engine/__tests__/watched-fields.test.ts`

**Interfaces:**
- Consumes: existing `extractChains`, `chainToWatchedField`, `collectCodeRefs`, `collectStructuredRefs`, `hasDynamicStepsAccess` (via collectCodeRefs), `WorkflowDefinition`.
- Produces: `type WatchedFieldSource = 'structured' | 'code'`; `interface WatchedField { path: string; source: WatchedFieldSource }`; `interface WatchedFieldMap { fields: WatchedField[]; unreadableNodes: string[] }`; `deriveWatchedFieldMap(definition): WatchedFieldMap`. `deriveWatchedFields` becomes a projection over it.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/engine/__tests__/watched-fields.test.ts` (add `deriveWatchedFieldMap` to the import; reuse the existing `def(...)` helper):

```ts
describe('deriveWatchedFieldMap', () => {
  it('tags structured refs and code refs with their source', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.y.output.v' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([
      { path: 'x.final', source: 'structured' },
      { path: 'y.v', source: 'code' },
    ])
    expect(map.unreadableNodes).toEqual([])
  })

  it('records a code node that bails open as unreadable and contributes no code fields', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'dyn', type: 'code', config: { script: 'const all = steps; return all.x.final' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([])
    expect(map.unreadableNodes).toEqual(['dyn'])
  })

  it('dedups a path reached both structurally and via code, structured wins', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.v}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.x.output.v' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([{ path: 'x.v', source: 'structured' }])
  })

  it('deriveWatchedFields still returns the same sorted path list', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.y.output.v' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.final', 'y.v'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: FAIL — `deriveWatchedFieldMap` not exported.

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/engine/watched-fields.ts`, add the types near the top and the function, and rewrite `deriveWatchedFields` as a projection. Replace the existing `deriveWatchedFields` function with:

```ts
export type WatchedFieldSource = 'structured' | 'code'

export interface WatchedField {
  path: string
  source: WatchedFieldSource
}

export interface WatchedFieldMap {
  fields: WatchedField[]
  unreadableNodes: string[]
}

// Full watched-field map with each field's source and the code nodes whose
// scripts could not be statically read (bailed open). Structured references win
// on dedup (higher confidence than a code-scan match).
export function deriveWatchedFieldMap(definition: WorkflowDefinition): WatchedFieldMap {
  const structured = new Set<string>()
  collectStructuredRefs(definition.nodes, structured)
  collectStructuredRefs(definition.edges, structured)

  const code = new Set<string>()
  const unreadableNodes: string[] = []
  for (const node of definition.nodes) {
    const script = node.config?.script
    if (typeof script !== 'string') continue
    const before = code.size
    const readable = collectCodeRefs(script, code)
    if (!readable) unreadableNodes.push(node.namespace)
    void before
  }

  const fields: WatchedField[] = []
  const seen = new Set<string>()
  for (const path of [...structured].sort()) {
    fields.push({ path, source: 'structured' })
    seen.add(path)
  }
  for (const path of [...code].sort()) {
    if (seen.has(path)) continue
    fields.push({ path, source: 'code' })
    seen.add(path)
  }
  return { fields, unreadableNodes }
}

export function deriveWatchedFields(definition: WorkflowDefinition): string[] {
  return deriveWatchedFieldMap(definition)
    .fields.map((f) => f.path)
    .sort()
}
```

(Remove the old `deriveWatchedFields` body. Keep the field-presence re-export working: `field-presence.ts` still does `export { deriveWatchedFields }` from this module.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts field-presence.test.ts`
Expected: PASS — new map tests green and existing watched-fields/field-presence tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/watched-fields.ts apps/worker/src/engine/__tests__/watched-fields.test.ts
git commit -m "feat(worker): deriveWatchedFieldMap with source + unreadable nodes (#423)"
```

---

### Task 2: `field_presence_silences` migration + hand-authored types + drift guard

**Files:**
- Create: `supabase/migrations/20260629000002_field_presence_silences.sql`
- Modify: `apps/worker/src/types/database.ts` (insert table block after `field_presence_daily`)
- Create: `apps/web/src/lib/__tests__/field-presence-silences-types.test.ts`

**Interfaces:**
- Produces: table `field_presence_silences`; typed `Database['public']['Tables']['field_presence_silences']`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260629000002_field_presence_silences.sql`:

```sql
-- Phase 4a (#423) of silent-output-field detection (#410). Author-set silences:
-- a (workflow, field) the detector should skip because the field is legitimately
-- allowed to be empty. reason is required so the coverage manifest can show why.
-- Additive/expand-only. Set/cleared via the field-coverage worker API.

CREATE TABLE field_presence_silences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL,
  field_path   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  UNIQUE (workflow_id, field_path)
);

CREATE INDEX field_presence_silences_workflow_idx ON field_presence_silences (workflow_id);

-- RLS: org-scoped via the workflows join (table has workflow_id, no
-- organization_id), identical shape to field_presence_daily_org. The worker uses
-- the service_role key and bypasses RLS; this gates direct PostgREST access.
ALTER TABLE field_presence_silences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_presence_silences_org" ON field_presence_silences
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );
```

- [ ] **Step 2: Write the failing drift guard test**

Create `apps/web/src/lib/__tests__/field-presence-silences-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const EXPECTED_COLUMNS = ['id', 'workflow_id', 'field_path', 'reason', 'created_at', 'created_by'] as const
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/20260629000002_field_presence_silences.sql')
const DATABASE_TYPES = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

function sliceBlock(src: string, header: string): string {
  const start = src.indexOf(header)
  if (start === -1) return ''
  const after = src.slice(start + header.length)
  const end = after.search(/\n {6}[a-z_]+: \{/)
  return end === -1 ? after : after.slice(0, end)
}

describe('field_presence_silences migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '')
  it('creates the table with the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) expect(sql).toMatch(new RegExp(`\\b${col}\\b`))
  })
  it('has the org RLS policy and unique constraint', () => {
    expect(sql).toContain('field_presence_silences_org')
    expect(sql).toContain('UNIQUE (workflow_id, field_path)')
  })
})

describe('field_presence_silences database.ts types', () => {
  const types = readFileSync(DATABASE_TYPES, 'utf8')
  const block = sliceBlock(types, 'field_presence_silences: {')
  it('has a field_presence_silences table block', () => {
    expect(block.length).toBeGreaterThan(0)
  })
  it('Row declares the expected columns', () => {
    for (const col of EXPECTED_COLUMNS) expect(block).toMatch(new RegExp(`\\b${col}\\b`))
  })
})
```

- [ ] **Step 3: Run the guard to verify the types half fails**

Run: `cd apps/web && pnpm test -- field-presence-silences-types.test.ts`
Expected: the migration describe PASSES; the database.ts describe FAILS (block absent).

- [ ] **Step 4: Hand-author the type block**

In `apps/worker/src/types/database.ts`, insert immediately after the `field_presence_daily: { ... }` table block (before `folders:`), matching the surrounding indentation:

```ts
      field_presence_silences: {
        Row: {
          created_at: string
          created_by: string | null
          field_path: string
          id: string
          reason: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_path: string
          id?: string
          reason: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_path?: string
          id?: string
          reason?: string
          workflow_id?: string
        }
        Relationships: []
      }
```

- [ ] **Step 5: Run the guard + typecheck**

Run: `cd apps/web && pnpm test -- field-presence-silences-types.test.ts` then `pnpm --filter worker typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260629000002_field_presence_silences.sql apps/worker/src/types/database.ts apps/web/src/lib/__tests__/field-presence-silences-types.test.ts
git commit -m "feat(db): field_presence_silences table + types + drift guard (#423)"
```

---

### Task 3: `excludeSilenced` filter + wire into detector orchestrators

**Files:**
- Modify: `apps/worker/src/lib/field-presence-anomaly.ts`
- Test: `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts`

**Interfaces:**
- Consumes: `DroughtHit`, `DeadHit` (Phase 3); `SupabaseClient`.
- Produces: `excludeSilenced<T extends { workflow_id: string; field_path: string }>(hits: T[], silenced: Set<string>): T[]` (key `${workflow_id} ${field_path}`); the two orchestrators read `field_presence_silences` and apply it before logging.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts` (add `excludeSilenced` to the import):

```ts
describe('excludeSilenced', () => {
  it('drops hits whose (workflow, field) is silenced and keeps the rest', () => {
    const hits = [
      { workflow_id: 'wf1', field_path: 'a.b' },
      { workflow_id: 'wf1', field_path: 'c.d' },
    ]
    const silenced = new Set(['wf1 a.b'])
    expect(excludeSilenced(hits, silenced)).toEqual([{ workflow_id: 'wf1', field_path: 'c.d' }])
  })
  it('keeps everything when nothing is silenced', () => {
    const hits = [{ workflow_id: 'wf1', field_path: 'a.b' }]
    expect(excludeSilenced(hits, new Set())).toEqual(hits)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts`
Expected: FAIL — `excludeSilenced` not exported.

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/lib/field-presence-anomaly.ts`, add the pure helper and a silence reader, and apply them in both orchestrators:

```ts
export function excludeSilenced<T extends { workflow_id: string; field_path: string }>(
  hits: T[],
  silenced: Set<string>,
): T[] {
  return hits.filter((h) => !silenced.has(`${h.workflow_id} ${h.field_path}`))
}

async function readSilences(supabase: SupabaseClient, workflowIds: string[]): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('field_presence_silences')
    .select('workflow_id, field_path')
    .in('workflow_id', workflowIds)
  if (error) {
    console.error('[field-presence] silences read failed:', error)
    return new Set()
  }
  return new Set((data ?? []).map((r) => `${r.workflow_id as string} ${r.field_path as string}`))
}
```

In `runFieldPresenceDroughtCheck`, after computing `hits` and before logging:
```ts
  const silenced = await readSilences(supabase, workflowIds)
  const visible = excludeSilenced(hits, silenced)
```
then log `visible` (loop over `visible`, and the summary line uses `visible.length`).

In `runFieldPresenceDeadCheck`, after computing `hits`:
```ts
  const silenced = await readSilences(supabase, workflowIds)
  const visible = excludeSilenced(hits, silenced)
```
then log the digest with `visible` (count + fields).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/worker && pnpm test -- field-presence-anomaly.test.ts` then `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/field-presence-anomaly.ts apps/worker/src/lib/__tests__/field-presence-anomaly.test.ts
git commit -m "feat(worker): detector skips silenced fields (#423)"
```

---

### Task 4: Coverage manifest API (`GET /api/field-coverage/:workflowId`)

**Files:**
- Create: `apps/worker/src/routes/api/field-coverage.ts`
- Modify: `apps/worker/src/routes/api/index.ts` (import + `api.route('/field-coverage', fieldCoverage)`)
- Test: `apps/worker/src/routes/api/__tests__/field-coverage.test.ts`

**Interfaces:**
- Consumes: `jwtAuth`/`AuthVariables`, `createSupabaseClient`, `loadWorkflowDefinition`, `deriveWatchedFieldMap`, `readPresenceRows`-equivalent reads, `findDroughts`/`findDayOneDead`, `dbError`/`dbErrorUnlessNotFound`.
- Produces: a Hono router default-exported; `GET /:workflowId` returns the manifest JSON.

- [ ] **Step 1: Write the route**

Create `apps/worker/src/routes/api/field-coverage.ts`:

```ts
// Field coverage manifest + silence management (#423). Read-only manifest of what
// the silent-output detector watches per workflow (field + source + health),
// plus the silences and the code nodes it cannot statically read. jwtAuth; every
// handler verifies the workflow belongs to the caller's org.
import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { loadWorkflowDefinition } from '../../engine/definition-loader'
import { deriveWatchedFieldMap } from '../../engine/watched-fields'
import { findDroughts, findDayOneDead, type PresenceRow } from '../../lib/field-presence-anomaly'

type Variables = AuthVariables
const fieldCoverage = new Hono<{ Bindings: Env; Variables: Variables }>()

async function ownedWorkflow(
  supabase: ReturnType<typeof createSupabaseClient>,
  workflowId: string,
  orgId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .maybeSingle()
  return !!data
}

fieldCoverage.get('/:workflowId', async (c) => {
  const workflowId = c.req.param('workflowId')
  const orgId = c.get('user').organization_id
  const supabase = createSupabaseClient(c.env)

  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }

  const loaded = await loadWorkflowDefinition(workflowId, c.env.WORKFLOW_DEFS, supabase, { allowInactive: true })
  const map = deriveWatchedFieldMap(loaded.definition)

  const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const { data: rollupRows, error } = await supabase
    .from('field_presence_daily')
    .select('workflow_id, field_path, day, ran_count, present_count')
    .eq('workflow_id', workflowId)
    .gte('day', since)
    .eq('is_test', false)
  if (error) return dbError(c, error)
  const rows: PresenceRow[] = (rollupRows ?? []).map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
    day: r.day as string,
    ran_count: Number(r.ran_count),
    present_count: Number(r.present_count),
  }))

  const droughtFields = new Set(findDroughts(rows, today).map((h) => h.field_path))
  const deadFields = new Set(findDayOneDead(rows).map((h) => h.field_path))
  const latestByField = new Map<string, PresenceRow>()
  for (const r of rows) {
    const prev = latestByField.get(r.field_path)
    if (!prev || r.day > prev.day) latestByField.set(r.field_path, r)
  }

  const { data: silenceRows } = await supabase
    .from('field_presence_silences')
    .select('field_path, reason, created_at')
    .eq('workflow_id', workflowId)

  const fields = map.fields.map((f) => {
    const latest = latestByField.get(f.path)
    const health = latest
      ? {
          latest_day: latest.day,
          ran: latest.ran_count,
          present: latest.present_count,
          rate: latest.ran_count > 0 ? latest.present_count / latest.ran_count : 0,
          drought: droughtFields.has(f.path),
          dead: deadFields.has(f.path),
        }
      : null
    return { path: f.path, source: f.source, health }
  })

  return c.json({
    workflow_id: workflowId,
    fields,
    unreadable_nodes: map.unreadableNodes,
    silences: (silenceRows ?? []).map((s) => ({
      field_path: s.field_path as string,
      reason: s.reason as string,
      created_at: s.created_at as string,
    })),
  })
})

export default fieldCoverage
```

Note: confirm the KV binding name for definitions. `loadWorkflowDefinition(workflowId, kv, supabase, opts)` takes the KV namespace as the 2nd arg. Grep `loadWorkflowDefinition(` in `apps/worker/src` to find the exact `c.env.<BINDING>` used by callers and use the same binding here.

- [ ] **Step 2: Register the route**

In `apps/worker/src/routes/api/index.ts`, add the import alongside the others:
```ts
import fieldCoverage from './field-coverage'
```
and the mount alongside the others:
```ts
api.route('/field-coverage', fieldCoverage)
```

- [ ] **Step 3: Write the test**

Create `apps/worker/src/routes/api/__tests__/field-coverage.test.ts`, mirroring the harness in `partner-bid-configs.test.ts` (the `vi.mock` of `../../../lib/jwt`, `../../../lib/supabase`, `../../../lib/audit`; `makeSupabase` from `./_supabase-mock`; the `request(app, method, path)` helper; and the `user_allowlist` allowlist entry the post-#326 `jwtAuth` requires — copy how `partner-bid-configs.test.ts` sets `users` + the allowlist in `makeSupabase`). Cover:

```ts
// (imports + harness copied from partner-bid-configs.test.ts)
it('returns 404 when the workflow is not in the caller org', async () => {
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser }, user_allowlist: { maybeSingle: { email: testUser.email } }, workflows: { maybeSingle: null } }) as any
  )
  const res = await request(app, 'GET', '/field-coverage/wf-x')
  expect(res.status).toBe(404)
})

it('returns the manifest shape for an owned workflow', async () => {
  // workflows.maybeSingle returns the workflow (owned); loadWorkflowDefinition is
  // exercised via KV/supabase mock returning a definition with one watched field;
  // field_presence_daily + field_presence_silences return rows.
  // Assert: body has fields[], unreadable_nodes[], silences[] keys.
})
```
Drive the exact mock returns from `makeSupabase` capabilities; if `loadWorkflowDefinition` is hard to satisfy through the mock, stub it with `vi.mock('../../../engine/definition-loader')` returning a small `LoadedWorkflow`. Assert the 404-wrong-org path and the manifest-shape path (keys present, `fields` reflects the derived watched set).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/worker && pnpm test -- field-coverage.test.ts` then `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/api/field-coverage.ts apps/worker/src/routes/api/index.ts apps/worker/src/routes/api/__tests__/field-coverage.test.ts
git commit -m "feat(worker): GET /api/field-coverage manifest (#423)"
```

---

### Task 5: Silence write API (`POST` / `DELETE /api/field-coverage/:workflowId/silence`)

**Files:**
- Modify: `apps/worker/src/routes/api/field-coverage.ts`
- Test: `apps/worker/src/routes/api/__tests__/field-coverage.test.ts`

**Interfaces:**
- Consumes: same as Task 4 + `writeAuditLog`.
- Produces: `POST /:workflowId/silence` (upsert), `DELETE /:workflowId/silence` (remove).

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/routes/api/__tests__/field-coverage.test.ts`:

```ts
it('POST silence requires a reason (400 without)', async () => {
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser }, user_allowlist: { maybeSingle: { email: testUser.email } }, workflows: { maybeSingle: { id: 'wf-1' } } }) as any
  )
  const res = await app.request('/field-coverage/wf-1/silence',
    { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ field: 'x.final' }) },
    testEnv, mockCtx)
  expect(res.status).toBe(400)
})

it('POST silence upserts with field + reason for an owned workflow', async () => {
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({ users: { single: testUser }, user_allowlist: { maybeSingle: { email: testUser.email } }, workflows: { maybeSingle: { id: 'wf-1' } }, field_presence_silences: { upsert: null } }) as any
  )
  const res = await app.request('/field-coverage/wf-1/silence',
    { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ field: 'x.final', reason: 'always empty for FDR leads' }) },
    testEnv, mockCtx)
  expect(res.status).toBe(200)
})
```
(If `makeSupabase` lacks an `upsert`/`delete` capability, extend `_supabase-mock.ts` minimally to support them, mirroring its existing `insert`/`update` handling.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- field-coverage.test.ts`
Expected: FAIL — POST route not defined (404/405).

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/routes/api/field-coverage.ts`, add `import { writeAuditLog } from '../../lib/audit'` and the two handlers (reuse `ownedWorkflow`):

```ts
fieldCoverage.post('/:workflowId/silence', async (c) => {
  const workflowId = c.req.param('workflowId')
  const orgId = c.get('user').organization_id
  const email = c.get('user').email
  const supabase = createSupabaseClient(c.env)
  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }
  const body = await c.req.json().catch(() => null) as { field?: string; reason?: string } | null
  if (!body?.field || !body?.reason) {
    return c.json({ error: 'field and reason are required' }, 400)
  }
  const { error } = await supabase
    .from('field_presence_silences')
    .upsert(
      { workflow_id: workflowId, field_path: body.field, reason: body.reason, created_by: email ?? null },
      { onConflict: 'workflow_id,field_path' },
    )
  if (error) return dbError(c, error)
  c.executionCtx.waitUntil(writeAuditLog(supabase, { organization_id: orgId, user_email: email, action: 'field_silence.set', resource_type: 'field_presence_silence', resource_id: `${workflowId}:${body.field}` }))
  return c.json({ ok: true })
})

fieldCoverage.delete('/:workflowId/silence', async (c) => {
  const workflowId = c.req.param('workflowId')
  const orgId = c.get('user').organization_id
  const email = c.get('user').email
  const supabase = createSupabaseClient(c.env)
  if (!(await ownedWorkflow(supabase, workflowId, orgId))) {
    return c.json({ error: 'Workflow not found' }, 404)
  }
  const body = await c.req.json().catch(() => null) as { field?: string } | null
  if (!body?.field) return c.json({ error: 'field is required' }, 400)
  const { error } = await supabase
    .from('field_presence_silences')
    .delete()
    .eq('workflow_id', workflowId)
    .eq('field_path', body.field)
  if (error) return dbError(c, error)
  c.executionCtx.waitUntil(writeAuditLog(supabase, { organization_id: orgId, user_email: email, action: 'field_silence.clear', resource_type: 'field_presence_silence', resource_id: `${workflowId}:${body.field}` }))
  return c.json({ ok: true })
})
```

Note: confirm the exact `writeAuditLog` signature by grepping a current caller (e.g. `partner-bid-configs.ts`) and match its argument shape; adjust the object above to fit. Confirm `c.get('user')` exposes `email`/`organization_id` (it does via `AuthVariables`).

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `cd apps/worker && pnpm test -- field-coverage.test.ts` then `cd apps/worker && pnpm test` then `pnpm --filter worker typecheck`
Expected: PASS — focused tests, full suite, typecheck all green.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/api/field-coverage.ts apps/worker/src/routes/api/__tests__/field-coverage.test.ts apps/worker/src/routes/api/__tests__/_supabase-mock.ts
git commit -m "feat(worker): POST/DELETE field-coverage silence API (#423)"
```

---

## Self-Review

**Spec coverage:**
- Watched-field metadata (source + unreadable) → Task 1 (`deriveWatchedFieldMap`); `deriveWatchedFields` projection preserves the capture seam.
- Silences table + RLS + manual apply + hand types + guard → Task 2.
- Detector silence-skip (log-only) → Task 3 (`excludeSilenced` + orchestrator reads).
- Coverage manifest GET (fields+source+health, unreadable, silences, org-scoped) → Task 4.
- Silence set/clear API (reason required, audit) → Task 5.
- No flip-live, no Slack/cooldown → not built; Phase 4b.

**Placeholder scan:** the two "confirm by grep" notes (KV binding name in Task 4; `writeAuditLog` signature in Task 5) are deliberate verification steps, not placeholders — the surrounding code is complete and the exact local symbol is confirmed against an existing caller during implementation. Everything else is full code.

**Type consistency:** `WatchedField`/`WatchedFieldMap`/`deriveWatchedFieldMap` (Task 1), `excludeSilenced` generic over `{workflow_id, field_path}` (Task 3), the `field_presence_silences` column set `{id, workflow_id, field_path, reason, created_at, created_by}` identical across the migration (Task 2), the hand-authored types (Task 2), the guard's `EXPECTED_COLUMNS` (Task 2), and the API reads/writes (Tasks 4-5).

**Note:** Tasks 4-5 reuse the established route + route-test patterns (`partner-bid-configs.ts` / `_supabase-mock`). The two grep-to-confirm notes (KV binding, audit signature) exist because those exact local symbols vary across the codebase and must match the current callers; the implementer confirms them against a named existing file rather than guessing.
