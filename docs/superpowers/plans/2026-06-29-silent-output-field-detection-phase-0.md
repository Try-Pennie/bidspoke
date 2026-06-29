# Silent-Output-Field Detection — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the database column and the dark, default-off write path that stamps a per-execution field-presence boolean map onto `workflow_executions`, proving the schema and plumbing before any watched fields or detection exist.

**Architecture:** At engine finalize (block 1, the `updateExecutionRecord` projection), resolve a watched-field list against in-memory `ctx.steps` into a small booleans-only `field_presence` map and persist it to one additive nullable JSONB column. The watched-field list is an empty stub in this phase (Phase 1 fills it in), so the capture writes `{}` — enough to prove the column write and the before-redaction timing. Gated behind a default-off env flag so deploying before the migration is applied is safe.

**Tech Stack:** TypeScript (Cloudflare Worker, Hono), Supabase Postgres (daily-partitioned `workflow_executions`), Vitest.

## Global Constraints

- TypeScript everywhere, strict mode. Avoid `any`.
- Straight quotes only in string literals; no em dashes; no dashes as connectors in any copy or comment.
- No comments unless logic is non-obvious.
- Expand/contract migrations: additive, nullable, no default. Code tolerates the column's absence (the flag is off until the migration is applied by hand).
- Apply migrations by hand (`supabase db push` is forbidden from a laptop on prod); the deploy pipeline only checks they are applied.
- `field_presence` is booleans only, computed BEFORE PII redaction; no resolved value may leak into the persisted JSONB or any log line.
- Migration version: `20260627000002` (verified next-free; latest on disk is `20260627000001`). Re-run `ls supabase/migrations/` before creating the file in case another landed.
- Worker test command: `pnpm --filter worker test` (Vitest). Typecheck: `pnpm --filter worker typecheck`.
- A new SQL migration trips the pre-push test gate (no DB in worker Vitest); override with `SKIP_TEST_CHECK=1 <push>` and state why (migrations can't be unit-tested here).

---

### Task 1: Add the `field_presence` column (migration)

**Files:**
- Create: `supabase/migrations/20260627000002_workflow_executions_field_presence.sql`

**Interfaces:**
- Produces: a nullable `jsonb` column `workflow_executions.field_presence`, applied to the partitioned parent (cascades to all partitions).

- [ ] **Step 1: Confirm the version is still free**

Run: `ls supabase/migrations/ | tail -3`
Expected: no file beginning `20260627000002`. If one exists, bump to the next free `NNNNNN` and use that throughout this task.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260627000002_workflow_executions_field_presence.sql`:

```sql
-- #419 / #410: dark write-time field-presence capture.
--
-- Stores a per-execution boolean map of whether each watched output field
-- carried a value this run. Computed at engine finalize from in-memory step
-- outputs, BEFORE PII redaction; only booleans persist, so no raw value is
-- stored. One row per execution (never per step), off the high-growth
-- execution_steps table. Key present => the producing node ran this execution
-- (the ran_count denominator); value => the field was non-null (present_count).
-- Read later by the Phase 2 field_presence_daily rollup.
--
-- Expand/contract: additive, nullable, no default. Existing rows keep NULL.
-- Adding the column to the partitioned parent applies it to all existing and
-- future partitions. Safe to deploy in either order; the FIELD_PRESENCE_CAPTURE
-- flag stays off until this is applied.

ALTER TABLE public.workflow_executions
  ADD COLUMN IF NOT EXISTS field_presence jsonb;

COMMENT ON COLUMN public.workflow_executions.field_presence IS
  'Per-execution boolean map: watched field path -> carried a value (non-null). Key present means the producing node ran. Booleans only; computed before PII redaction (#419).';
```

- [ ] **Step 3: Verify it parses (dry, no DB write)**

Run: `cat supabase/migrations/20260627000002_workflow_executions_field_presence.sql`
Expected: the file content above, single `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, no `DROP`/`RENAME`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260627000002_workflow_executions_field_presence.sql
git commit -m "Add field_presence column to workflow_executions (#419)"
```

> Application to prod is a manual step done at deploy time (dashboard SQL editor + register in `supabase_migrations.schema_migrations`), NOT part of this task. See the Deployment note at the end.

---

### Task 2: Extract a shared `resolveStepField` helper in `context.ts`

This is a behavior-preserving refactor so the field-presence module and `resolveReference` agree on `steps.*` path semantics (consolidate, don't duplicate). Existing `context.test.ts` covers `steps.*` resolution and must stay green.

**Files:**
- Modify: `apps/worker/src/engine/context.ts` (the `steps.*` branch of `resolveReference`, currently lines 166-176)
- Test: `apps/worker/src/engine/__tests__/context.test.ts` (existing — no new test; it guards the refactor)

**Interfaces:**
- Produces: `export function resolveStepField(steps: Record<string, StepOutput>, segments: string[]): unknown` — `segments` are the path parts AFTER the `steps` root (`segments[0]` is the namespace); tolerates an explicit `.output` segment; returns the step output, a nested field, or `undefined`.
- Consumes: the module-local `getPath` (already defined at `context.ts:314`; hoisted, so call order is fine). `StepOutput` is already imported at `context.ts:1`.

- [ ] **Step 1: Run the existing context tests to confirm the green baseline**

Run: `pnpm --filter worker test -- context.test.ts`
Expected: PASS (this is the safety net for the refactor).

- [ ] **Step 2: Add the `resolveStepField` export**

In `apps/worker/src/engine/context.ts`, immediately above `function resolveReference(` (line 139), add:

```ts
/**
 * Resolve a `steps.*` reference against the step outputs. `segments` are the
 * path parts AFTER the `steps` root, so segments[0] is the namespace. Tolerates
 * an explicit `.output` segment after the namespace, matching the copy-path and
 * code-node conventions. Returns the step output, a nested field, or undefined
 * when the namespace or path is absent. Shared by resolveReference and the
 * field-presence capture so both agree on path semantics.
 */
export function resolveStepField(steps: Record<string, StepOutput>, segments: string[]): unknown {
  const ns = segments[0]
  if (!ns) return undefined
  const step = steps[ns]
  if (!step) return undefined
  if (segments.length === 1) return step.output
  const pathParts = segments[1] === 'output' ? segments.slice(2) : segments.slice(1)
  if (pathParts.length === 0) return step.output
  return getPath(step.output, pathParts)
}
```

- [ ] **Step 3: Route the `resolveReference` steps branch through the helper**

In `apps/worker/src/engine/context.ts`, replace the existing `steps` branch (lines 166-176):

```ts
  if (parts[0] === 'steps' && parts[1]) {
    const step = ctx.steps[parts[1]]
    if (!step) return undefined
    if (parts.length === 2) return step.output
    // Tolerate explicit `.output` — matches the copy-path format from the JSON tree
    // and the code-node-script convention. `{{steps.X.output}}` and `{{steps.X.output.Y}}`
    // resolve the same as `{{steps.X}}` and `{{steps.X.Y}}`.
    const pathParts = parts[2] === 'output' ? parts.slice(3) : parts.slice(2)
    if (pathParts.length === 0) return step.output
    return getPath(step.output, pathParts)
  }
```

with:

```ts
  if (parts[0] === 'steps' && parts[1]) {
    return resolveStepField(ctx.steps, parts.slice(1))
  }
```

- [ ] **Step 4: Run the context tests to verify behavior is preserved**

Run: `pnpm --filter worker test -- context.test.ts`
Expected: PASS (same set as Step 1 — `{{steps.X}}`, `.output` tolerance, deep paths, unknown step, coalesce all still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/context.ts
git commit -m "Extract shared resolveStepField helper in context.ts (#419)"
```

---

### Task 3: Add the `field-presence` module (`computeFieldPresence` + `deriveWatchedFields` stub)

**Files:**
- Create: `apps/worker/src/engine/field-presence.ts`
- Test: `apps/worker/src/engine/__tests__/field-presence.test.ts`

**Interfaces:**
- Consumes: `resolveStepField` (Task 2) from `./context`; `StepOutput`, `WorkflowDefinition` from `../types`.
- Produces:
  - `export function computeFieldPresence(steps: Record<string, StepOutput>, watchedFields: string[]): Record<string, boolean>`
  - `export function deriveWatchedFields(definition: WorkflowDefinition): string[]` (Phase 0 stub returning `[]`)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/__tests__/field-presence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeFieldPresence, deriveWatchedFields } from '../field-presence'
import type { StepOutput, WorkflowDefinition } from '../../types'

function step(output: unknown): StepOutput {
  return { output, status: 'completed' }
}

describe('computeFieldPresence', () => {
  it('returns {} for an empty watched list', () => {
    const steps = { foo: step({ a: 1 }) }
    expect(computeFieldPresence(steps, [])).toEqual({})
  })

  it('marks a field present when its node ran and the value is non-null', () => {
    const steps = { foo: step({ final: 42 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': true })
  })

  it('marks a field absent when its node ran but the value is null', () => {
    const steps = { foo: step({ final: null }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('marks a field absent when its node ran but the field is missing', () => {
    const steps = { foo: step({ other: 1 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('omits the key entirely when the producing node did not run', () => {
    const steps = { other: step({ x: 1 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({})
  })

  it('treats a node whose whole output is null as ran-but-empty', () => {
    const steps = { foo: step(null) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('treats 0, false, and empty string as present (carried a value)', () => {
    const steps = { foo: step({ z: 0, b: false, s: '' }) }
    expect(computeFieldPresence(steps, ['foo.z', 'foo.b', 'foo.s'])).toEqual({
      'foo.z': true,
      'foo.b': true,
      'foo.s': true,
    })
  })

  it('tolerates a leading steps. prefix and an explicit .output segment, normalizing the key', () => {
    const steps = { foo: step({ a: { b: 'deep' } }) }
    expect(computeFieldPresence(steps, ['steps.foo.output.a.b'])).toEqual({ 'foo.a.b': true })
    expect(computeFieldPresence(steps, ['steps.foo.a.b'])).toEqual({ 'foo.a.b': true })
    expect(computeFieldPresence(steps, ['foo.output.a.b'])).toEqual({ 'foo.a.b': true })
  })

  it('returns only booleans (never a resolved value)', () => {
    const steps = { foo: step({ secret: 'ssn-123' }) }
    const result = computeFieldPresence(steps, ['foo.secret'])
    expect(Object.values(result).every((v) => typeof v === 'boolean')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ssn-123')
  })
})

describe('deriveWatchedFields', () => {
  it('returns [] in Phase 0 (watched map arrives in Phase 1)', () => {
    const definition = { nodes: [], edges: [] } as unknown as WorkflowDefinition
    expect(deriveWatchedFields(definition)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter worker test -- field-presence.test.ts`
Expected: FAIL with a module-not-found / `computeFieldPresence is not a function` error (the module does not exist yet).

- [ ] **Step 3: Write the module**

Create `apps/worker/src/engine/field-presence.ts`:

```ts
import type { StepOutput, WorkflowDefinition } from '../types'
import { resolveStepField } from './context'

/**
 * Parse a watched-field path into namespace-rooted segments. Strips an optional
 * leading `steps.` and collapses an explicit `.output` wrapper after the
 * namespace, so `steps.x.output.y`, `steps.x.y`, and `x.y` all normalize to
 * ['x', 'y'].
 */
function parseWatchedField(field: string): string[] {
  let segs = field.split('.').filter(Boolean)
  if (segs[0] === 'steps') segs = segs.slice(1)
  if (segs[1] === 'output') segs = [segs[0], ...segs.slice(2)]
  return segs
}

/**
 * Per-execution field-presence map: for each watched field whose producing node
 * ran this execution, a boolean for whether the field carried a value (non-null).
 * Fields whose node did not run are OMITTED, so a present key means the node ran
 * (the ran_count denominator) and its value means the field was non-null (the
 * present_count). Booleans only — no resolved value is ever stored, so no PII can
 * leak into the persisted map.
 */
export function computeFieldPresence(
  steps: Record<string, StepOutput>,
  watchedFields: string[],
): Record<string, boolean> {
  const presence: Record<string, boolean> = {}
  for (const field of watchedFields) {
    const segments = parseWatchedField(field)
    const ns = segments[0]
    if (!ns || !(ns in steps)) continue
    const value = resolveStepField(steps, segments)
    presence[segments.join('.')] = value !== null && value !== undefined
  }
  return presence
}

/**
 * The set of field paths to watch for this workflow definition. Phase 0 stub:
 * returns []. Phase 1 (#420) derives this from structured references (templates,
 * filter/branch/edge conditions, transform mappings) plus a deep scan of
 * code-node scripts. Kept as the single seam so Phase 1 swaps the body without
 * touching the finalize write path.
 */
export function deriveWatchedFields(_definition: WorkflowDefinition): string[] {
  return []
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter worker test -- field-presence.test.ts`
Expected: PASS (all cases in Step 1).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/field-presence.ts apps/worker/src/engine/__tests__/field-presence.test.ts
git commit -m "Add field-presence module: computeFieldPresence + deriveWatchedFields stub (#419)"
```

---

### Task 4: Wire the dark capture into finalize behind the feature flag

**Files:**
- Modify: `apps/worker/src/index.ts` (the `Env` interface, ~line 59 area)
- Modify: `apps/worker/src/engine/step-logger.ts` (the `updateExecutionRecord` update type, ~lines 221-237)
- Modify: `apps/worker/src/engine/index.ts` (top-of-file imports; finalize block 1, ~lines 522-546)
- Test: `apps/worker/src/engine/__tests__/field-presence.test.ts` (extend with a flag-gating unit test)

**Interfaces:**
- Consumes: `computeFieldPresence`, `deriveWatchedFields` (Task 3); `resolveStepField` (Task 2, indirectly); the `Env` flag `FIELD_PRESENCE_CAPTURE`.
- Produces: `field_presence` written into the `updateExecutionRecord` projection when the flag is on.

- [ ] **Step 1: Write the failing flag-gating test**

Append to `apps/worker/src/engine/__tests__/field-presence.test.ts`:

```ts
import { fieldPresenceForCapture } from '../field-presence'

describe('fieldPresenceForCapture — flag gate', () => {
  const steps = { foo: { output: { final: 1 }, status: 'completed' as const } }
  const definition = { nodes: [], edges: [] } as unknown as WorkflowDefinition

  it('returns undefined when the flag is not "true"', () => {
    expect(fieldPresenceForCapture(undefined, steps, definition)).toBeUndefined()
    expect(fieldPresenceForCapture('false', steps, definition)).toBeUndefined()
    expect(fieldPresenceForCapture('1', steps, definition)).toBeUndefined()
  })

  it('returns the (empty in Phase 0) presence map when the flag is "true"', () => {
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({})
  })
})
```

> Rationale: the flag-gate + stub-derive composition is the one piece of engine glue worth a unit test. Pulling it into a tiny pure helper (`fieldPresenceForCapture`) keeps the finalize block a one-liner and makes the gate testable without standing up a full `runWorkflow`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter worker test -- field-presence.test.ts`
Expected: FAIL with `fieldPresenceForCapture is not a function`.

- [ ] **Step 3: Add the `fieldPresenceForCapture` helper to the module**

In `apps/worker/src/engine/field-presence.ts`, append:

```ts
/**
 * Finalize-time glue: when FIELD_PRESENCE_CAPTURE is enabled, derive the watched
 * map for this definition and compute presence from the in-memory step outputs.
 * Returns undefined when the flag is off so callers can omit the column entirely.
 * Dark/log-only in Phase 0 (watched map is empty, so this yields {}).
 */
export function fieldPresenceForCapture(
  flag: string | undefined,
  steps: Record<string, StepOutput>,
  definition: WorkflowDefinition,
): Record<string, boolean> | undefined {
  if (flag !== 'true') return undefined
  return computeFieldPresence(steps, deriveWatchedFields(definition))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter worker test -- field-presence.test.ts`
Expected: PASS (all `computeFieldPresence`, `deriveWatchedFields`, and `fieldPresenceForCapture` cases).

- [ ] **Step 5: Add the `Env` flag**

In `apps/worker/src/index.ts`, after the `PII_REDACTION_FIELDS` field (line 59), add:

```ts

  // Field-presence capture (#419/#410). 'true' enables the dark write of the
  // per-execution watched-field presence map; off or unset disables it.
  // Default off so deploying before the migration is applied is safe.
  FIELD_PRESENCE_CAPTURE?: string
```

- [ ] **Step 6: Extend the `updateExecutionRecord` update type**

In `apps/worker/src/engine/step-logger.ts`, inside the `update` object type of `updateExecutionRecord` (after the `sighting_finalize?: unknown` field, line 236), add:

```ts
    // #419: per-execution field-presence booleans (which watched fields carried
    // a value this run). Dark capture behind FIELD_PRESENCE_CAPTURE.
    field_presence?: Record<string, boolean>
```

- [ ] **Step 7: Import the helper in the engine**

In `apps/worker/src/engine/index.ts`, add to the imports near the top (next to the `./step-logger` import at line 23):

```ts
import { fieldPresenceForCapture } from './field-presence'
```

- [ ] **Step 8: Compute and persist in finalize block 1**

In `apps/worker/src/engine/index.ts`, immediately before the `await updateExecutionRecord(supabase, executionId, startedAt, {` call (line 528), add:

```ts
        // Phase 0 (#419): dark field-presence capture. Behind a default-off
        // flag, log-only. The watched map is an empty stub until Phase 1 (#420),
        // so this writes {} — enough to prove the column + write path. Computed
        // from in-memory ctx.steps (raw, before PII redaction in flushStepLogs);
        // only booleans persist, so no value leaves the worker.
        const fieldPresence = fieldPresenceForCapture(env.FIELD_PRESENCE_CAPTURE, ctx.steps, definition)
        if (fieldPresence) {
          console.log('[field-presence] captured', {
            workflowId,
            executionId,
            watched: Object.keys(fieldPresence).length,
            present: Object.values(fieldPresence).filter(Boolean).length,
          })
        }
```

Then, inside the `updateExecutionRecord({ ... })` object, after the `...(sightingFinalize ? { sighting_finalize: sightingFinalize } : {}),` line (545), add:

```ts
          ...(fieldPresence ? { field_presence: fieldPresence } : {}),
```

- [ ] **Step 9: Typecheck and run the full worker test suite**

Run: `pnpm --filter worker typecheck && pnpm --filter worker test`
Expected: typecheck clean; all tests PASS (existing suite + new field-presence tests). The `console.log` payload contains only ids and counts — no field values.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/index.ts apps/worker/src/engine/step-logger.ts apps/worker/src/engine/index.ts apps/worker/src/engine/field-presence.ts apps/worker/src/engine/__tests__/field-presence.test.ts
git commit -m "Wire dark field-presence capture into finalize behind flag (#419)"
```

---

## Deployment note (manual, after merge)

1. Apply the migration to prod by hand (NOT `supabase db push`): run the `ALTER TABLE` in the Supabase dashboard SQL editor, then register it in `supabase_migrations.schema_migrations` (version `20260627000002`, name `workflow_executions_field_presence`).
2. Re-run the deploy's failed Verify step: `gh run rerun <id> --failed`. Confirm the Deploy Worker job actually ran (path-gated on `apps/worker/**`; an overall "success" can hide a skipped deploy).
3. Leave `FIELD_PRESENCE_CAPTURE` UNSET in prod for now. Phase 0 ships dark and disabled; the flag is flipped to `true` only when we deliberately start the dark capture (after Phase 1 gives it a non-empty watched map, or sooner to smoke-test the `{}` write).
4. The pre-push gate will flag the new SQL migration as untested — override with `SKIP_TEST_CHECK=1 <push command>` (worker Vitest has no database; the `ALTER` can't be unit-tested).

## Self-Review

- **Spec coverage:** Phase 0 row of the spec's phase table → Tasks 1-4. Additive nullable column (Task 1), build in finalize block 1 from `ctx.steps` + watched map (Task 4), persist via `updateExecutionRecord` (Task 4), booleans-only before PII redaction (Task 3 semantics + Task 4 placement + tests), write for test runs too (no `isTest` gate added — Task 4 leaves the existing block unconditional), default-off flag + log-only (Task 4), stub watched map (Task 3). Consolidation of path resolution (spec "shared core") → Task 2.
- **Placeholder scan:** none — every code step shows full code; types (`StepOutput`, `WorkflowDefinition`) are real and verified; commands have expected output.
- **Type consistency:** `resolveStepField(steps, segments)` defined in Task 2 is consumed in Task 3; `computeFieldPresence`/`deriveWatchedFields`/`fieldPresenceForCapture` signatures are identical across the module (Task 3/4) and the finalize call site (Task 4); `field_presence?: Record<string, boolean>` matches between the module return type, the step-logger update type, and the capture helper.
