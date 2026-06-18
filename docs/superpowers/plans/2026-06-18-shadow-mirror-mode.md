# Shadow Mirror Mode (Phase 4.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Bidspoke shadow real engine traffic (mirrored fire-and-forget from Pipedream) by running the full workflow while skipping every external side effect, so we can prove volume handling and spot-check decisions before cutover.

**Architecture:** A new `shadow_mode: 'off' | 'dry_run'` axis flows on the existing `ExecutionContext` (the object already threaded to every node executor). When `dry_run`, the first-class outbound node executors (Integration, Salesforce, Partner Bid, Achieve Offers) return a tagged stub instead of firing, and the Data Store node skips KV writes. Code nodes receive `shadow_mode` in their sandbox input so outbound scripts (e.g. Equifax) self-stub. A new `POST /shadow/:workflow_id` route returns `204` immediately and runs the workflow in the background with `shadowMode: 'dry_run'` plus `isTest: true` — reusing every existing `isTest` suppression (no sighting writes, no Slack alerts, excluded from prod dashboards) for free, so the only genuinely new behavior is outbound stubbing + the route.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono router, Vitest. No new dependencies, no DB migration.

## Global Constraints

- TypeScript everywhere, strict mode; avoid `any`. (project CLAUDE.md)
- Straight quotes only in string literals; no em dashes in copy/UI text. (project CLAUDE.md)
- Test-first (TDD): write the failing test before implementation. (global policy)
- Worker tests run with `pnpm --filter worker exec vitest run <path>`; typecheck with `pnpm typecheck`; lint with `pnpm lint`.
- Commit and push after each task (verified green). Stage only the task's files; never `git add -A`.
- `shadow_mode` has exactly two states: `'off' | 'dry_run'`. No third state. (scope §3.3)
- Shadow runs must perform **zero** external side effects: no Salesforce writes, no Equifax/partner calls, no Slack alerts, no KV writes, no lead-sighting writes. (scope §3.3)
- The shadow route is a **separate** route from any future cutover route, so the Pipedream mirror step can be removed at cutover without touching the real path. (scope §3.3)

---

## Open Decisions (resolved for Phase A; revisit later)

These are judgment calls baked into the plan — flagged so a reviewer can veto:

- **D1 — Partner Bid stub returns "skipped", not a fabricated bid.** A dry-run Partner Bid returns `{ skipped: true, skip_reason: 'shadow', bid: null }`. Consequence: downstream Bid Group / Bid Evaluation always sees no winners in shadow, so bid-routing decision parity is **not** validated in Phase A (only the pre-bid path — filters, eligibility, matrix lookups — runs for real, since those are in-memory/DB-read, not outbound). This matches the stated Phase A goal ("prove volume handling"); fabricated-bid parity is a later phase.
- **D2 — Code nodes self-stub; the engine does not auto-stub them.** The engine can't introspect a sandboxed script to know if it calls `fetch`. So the engine passes `shadow_mode` into the sandbox input, and each outbound code script (Equifax credit pull, partner submits) is responsible for `if (shadow_mode === 'dry_run') return <stub>`. Pure-transform code nodes (e.g. `prospect_body`) run unchanged. The outbound guards get added when those scripts are written during the 4.1 engine-workflow port.
- **D3 — Shadow runs reuse `is_test = true` for suppression + filtering.** No new `workflow_executions` column (that would be DDL on a hot, partitioned table — only safe in quiet windows, per project memory). Shadow runs are `is_test = true` (so all existing suppression applies and they're excluded from prod dashboards) and are distinguished from manual test runs by `source` (the shadow route stamps a dedicated source label). A dedicated column can be added later if distinct filtering becomes necessary.

---

## File Structure

- `apps/worker/src/engine/shadow.ts` — **new.** `isShadowDryRun(ctx)` predicate + the per-node stub builders. Single home for shadow stub shapes so they stay consistent and testable.
- `apps/worker/src/engine/index.ts` — **modify.** Add `shadowMode` to `ExecuteOptions`; set `ctx.shadow_mode` next to the existing `ctx.codeBundleName` assignment.
- `apps/worker/src/types.ts` — **modify.** Add `shadow_mode?: 'off' | 'dry_run'` to `ExecutionContext`.
- `apps/worker/src/engine/nodes/integration.ts` — **modify.** Dry-run guard returns the integration stub.
- `apps/worker/src/engine/nodes/salesforce.ts` — **modify.** Dry-run guard returns the salesforce stub.
- `apps/worker/src/engine/nodes/partner-bid.ts` — **modify.** Dry-run guard (after slug resolution, before any DB/circuit/cap/API work) returns the partner-bid stub; add `'shadow'` to the `SkipReason` union.
- `apps/worker/src/engine/nodes/achieve-offers.ts` — **modify.** Dry-run guard returns the achieve stub (and does not mark `_achieve_evaluation`, so the achieve-log hook writes nothing).
- `apps/worker/src/engine/nodes/data-store.ts` — **modify.** In `set`/`delete`, skip the KV op when dry-run; return the same output shape.
- `apps/worker/src/engine/nodes/code.ts` — **modify.** Add `shadow_mode` to the sandbox request `body`.
- `apps/worker/src/routes/shadow.ts` — **new.** `POST /:workflow_id` → 204 + `waitUntil(executeWorkflow(...))`.
- `apps/worker/src/index.ts` — **modify.** Mount the shadow router.
- `docs/nodes/` + `TODO.md` + `docs/engine-cutover-scope.md` — **modify.** Mark 4.3 progress; document the code-script self-stub contract.

---

### Task 1: Shadow context flag + stub builders

**Files:**
- Create: `apps/worker/src/engine/shadow.ts`
- Create: `apps/worker/src/engine/__tests__/shadow.test.ts`
- Modify: `apps/worker/src/types.ts:138` (add field to `ExecutionContext`, before the closing brace at line 139)
- Modify: `apps/worker/src/engine/index.ts:79` (add to `ExecuteOptions`) and `apps/worker/src/engine/index.ts:254` (set on ctx)

**Interfaces:**
- Produces: `isShadowDryRun(ctx: ExecutionContext): boolean`; `shadowIntegrationStub(): StepExecutionResult`; `shadowSalesforceStub(): StepExecutionResult`; `shadowPartnerBidStub(slug: string): StepExecutionResult`; `shadowAchieveStub(): StepExecutionResult`. `ExecutionContext.shadow_mode?: 'off' | 'dry_run'`. `ExecuteOptions.shadowMode?: 'off' | 'dry_run'`.
- Consumes: `ExecutionContext`, `StepExecutionResult` from `../types`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/__tests__/shadow.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { ExecutionContext } from '../../types'
import {
  isShadowDryRun,
  shadowIntegrationStub,
  shadowSalesforceStub,
  shadowPartnerBidStub,
  shadowAchieveStub,
} from '../shadow'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return {
    trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' },
    steps: {},
    env: {},
    shadow_mode,
  }
}

describe('isShadowDryRun', () => {
  it('is true only when shadow_mode is dry_run', () => {
    expect(isShadowDryRun(ctx('dry_run'))).toBe(true)
    expect(isShadowDryRun(ctx('off'))).toBe(false)
    expect(isShadowDryRun(ctx(undefined))).toBe(false)
  })
})

describe('shadow stubs', () => {
  it('integration stub is a tagged 200 with empty body/headers', () => {
    expect(shadowIntegrationStub().output).toEqual({ status: 200, body: { _shadow: true }, headers: {} })
  })
  it('salesforce stub is a tagged 200', () => {
    expect(shadowSalesforceStub().output).toEqual({ status: 200, body: { _shadow: true } })
  })
  it('partner bid stub is a tagged skip carrying the slug', () => {
    expect(shadowPartnerBidStub('tripoint').output).toEqual({
      partner: 'tripoint',
      bid: null,
      accepted: false,
      skipped: true,
      skip_reason: 'shadow',
      _shadow: true,
    })
  })
  it('achieve stub is a tagged non-accept with no evaluation marker', () => {
    const out = shadowAchieveStub().output as Record<string, unknown>
    expect(out._shadow).toBe(true)
    expect(out.accepted).toBe(false)
    expect(out._achieve_evaluation).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/__tests__/shadow.test.ts`
Expected: FAIL — `Cannot find module '../shadow'`.

- [ ] **Step 3: Create the implementation**

Create `apps/worker/src/engine/shadow.ts`:

```typescript
import type { ExecutionContext, StepExecutionResult } from '../types'

/** True when the current run is a dry-run shadow: run the workflow logic but
 *  skip every external side effect. See docs/engine-cutover-scope.md §3.3. */
export function isShadowDryRun(ctx: ExecutionContext): boolean {
  return ctx.shadow_mode === 'dry_run'
}

// Stub outputs mirror each outbound node's success shape, tagged `_shadow` so a
// stubbed step is distinguishable from a real one in logs and spot-checks.

export function shadowIntegrationStub(): StepExecutionResult {
  return { output: { status: 200, body: { _shadow: true }, headers: {} } }
}

export function shadowSalesforceStub(): StepExecutionResult {
  return { output: { status: 200, body: { _shadow: true } } }
}

export function shadowPartnerBidStub(slug: string): StepExecutionResult {
  return {
    output: {
      partner: slug,
      bid: null,
      accepted: false,
      skipped: true,
      skip_reason: 'shadow',
      _shadow: true,
    },
  }
}

export function shadowAchieveStub(): StepExecutionResult {
  return {
    output: { accepted: false, status: 200, reason: 'shadow', request: {}, offers: [], _shadow: true },
  }
}
```

In `apps/worker/src/types.ts`, add to `ExecutionContext` immediately before its closing `}` (currently line 139), after the `pendingBidWrites?` field:

```typescript
  /**
   * Shadow execution mode. 'dry_run' runs the workflow logic but every outbound
   * node returns a stub instead of firing (no Salesforce/Equifax/partner/HTTP/KV
   * side effects). Unset / 'off' = normal execution. See engine/shadow.ts and
   * docs/engine-cutover-scope.md §3.3.
   */
  shadow_mode?: 'off' | 'dry_run'
```

In `apps/worker/src/engine/index.ts`, add to `ExecuteOptions` after the `codeBundleName?` field (line 84):

```typescript
  /** When 'dry_run', outbound node executors return stubs instead of firing —
   *  the shadow-mirror volume test. See engine/shadow.ts. */
  shadowMode?: 'off' | 'dry_run'
```

And set it on the context right after the existing `codeBundleName` assignment (line 254):

```typescript
  if (options.codeBundleName) ctx.codeBundleName = options.codeBundleName
  if (options.shadowMode) ctx.shadow_mode = options.shadowMode
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/__tests__/shadow.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: Done, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/engine/shadow.ts apps/worker/src/engine/__tests__/shadow.test.ts apps/worker/src/types.ts apps/worker/src/engine/index.ts
git commit -m "Add shadow_mode flag and stub builders for dry-run shadow execution"
```

---

### Task 2: Integration node dry-run stub

**Files:**
- Modify: `apps/worker/src/engine/nodes/integration.ts:87` (guard right after config read, before the fetch)
- Test: `apps/worker/src/engine/nodes/__tests__/integration-shadow.test.ts`

**Interfaces:**
- Consumes: `isShadowDryRun`, `shadowIntegrationStub` from `../../shadow`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/integration-shadow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeIntegrationNode } from '../integration'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'webhook', namespace: 'call_x', config: { url: 'https://example.com/hook', method: 'POST' } } as unknown as NodeDefinition

describe('executeIntegrationNode — shadow dry_run', () => {
  it('returns a stub and never calls fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executeIntegrationNode(node, ctx('dry_run'), {} as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toEqual({ status: 200, body: { _shadow: true }, headers: {} })
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/integration-shadow.test.ts`
Expected: FAIL — fetch is called (or throws) because no guard exists yet.

- [ ] **Step 3: Add the guard**

In `apps/worker/src/engine/nodes/integration.ts`, add the import at the top with the other imports:

```typescript
import { isShadowDryRun, shadowIntegrationStub } from '../shadow'
```

Then inside `executeIntegrationNode`, immediately after the `config.url` validation (the `if (!config.url) { throw ... }` block ending at line 91), add:

```typescript
  // Shadow dry-run: don't make the outbound call.
  if (isShadowDryRun(ctx)) return shadowIntegrationStub()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/integration-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/integration.ts apps/worker/src/engine/nodes/__tests__/integration-shadow.test.ts
git commit -m "Stub Integration node outbound call in shadow dry-run"
```

---

### Task 3: Salesforce node dry-run stub

**Files:**
- Modify: `apps/worker/src/engine/nodes/salesforce.ts:91` (guard right after config read, before the token fetch at line 110)
- Test: `apps/worker/src/engine/nodes/__tests__/salesforce-shadow.test.ts`

**Interfaces:**
- Consumes: `isShadowDryRun`, `shadowSalesforceStub` from `../../shadow`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/salesforce-shadow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'salesforce', namespace: 'sf_create', config: { operation: 'create', object: 'Lead', body: {} } } as unknown as NodeDefinition

describe('executeSalesforceNode — shadow dry_run', () => {
  it('returns a stub and never calls fetch (so no token request, no write)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Env intentionally lacks SALESFORCE_* — the dry-run guard returns before the
    // env check, proving it short-circuits the entire outbound path.
    const res = await executeSalesforceNode(node, ctx('dry_run'), {} as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toEqual({ status: 200, body: { _shadow: true } })
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/salesforce-shadow.test.ts`
Expected: FAIL — throws "Salesforce node requires SALESFORCE_INSTANCE_URL..." because no guard yet.

- [ ] **Step 3: Add the guard**

In `apps/worker/src/engine/nodes/salesforce.ts`, add the import at the top:

```typescript
import { isShadowDryRun, shadowSalesforceStub } from '../shadow'
```

Then inside `executeSalesforceNode`, as the first statement after `const config = node.config as unknown as SalesforceConfig` (line 91), add:

```typescript
  // Shadow dry-run: don't touch Salesforce (no token fetch, no write).
  if (isShadowDryRun(ctx)) return shadowSalesforceStub()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/salesforce-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/salesforce.ts apps/worker/src/engine/nodes/__tests__/salesforce-shadow.test.ts
git commit -m "Stub Salesforce node in shadow dry-run"
```

---

### Task 4: Partner Bid node dry-run stub

**Files:**
- Modify: `apps/worker/src/engine/nodes/partner-bid.ts` — add `'shadow'` to the `SkipReason` union (find its `type SkipReason = ...` declaration) and add the dry-run guard immediately after the partner slug is resolved from `node.config`, before any Supabase config load, circuit-breaker, cap, dedup, or `resolveBid` call.
- Test: `apps/worker/src/engine/nodes/__tests__/partner-bid-shadow.test.ts`

**Interfaces:**
- Consumes: `isShadowDryRun`, `shadowPartnerBidStub` from `../../shadow`.
- Produces: `SkipReason` union extended with `'shadow'`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/partner-bid-shadow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executePartnerBidNode } from '../partner-bid'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

// Supabase mock that throws if touched — proves the dry-run guard returns before any DB read.
const supabaseThatThrows = { from: () => { throw new Error('DB must not be touched in shadow') } }

const node = { id: 'n1', type: 'partner_bid', namespace: 'bid_tripoint', config: { partner_slug: 'tripoint' } } as unknown as NodeDefinition

describe('executePartnerBidNode — shadow dry_run', () => {
  it('returns a skip stub carrying the slug, with no DB or network access', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executePartnerBidNode(node, ctx('dry_run'), {} as never, supabaseThatThrows as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ partner: 'tripoint', skipped: true, skip_reason: 'shadow', bid: null, _shadow: true })
    vi.unstubAllGlobals()
  })
})
```

> Note: confirm the config field name for the slug in `partner-bid.ts` (it may be `partner_slug` or `slug`). Match the test's `config` and the guard's slug source to whatever the executor already reads.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/partner-bid-shadow.test.ts`
Expected: FAIL — throws "DB must not be touched..." because the executor loads partner config before any guard.

- [ ] **Step 3: Add the guard + extend SkipReason**

In `apps/worker/src/engine/nodes/partner-bid.ts`:

1. Add the import at the top:

```typescript
import { isShadowDryRun, shadowPartnerBidStub } from '../shadow'
```

2. Find the `SkipReason` union declaration and add `'shadow'`, e.g.:

```typescript
export type SkipReason =
  | 'partner_inactive'
  | 'circuit_open'
  | 'cap_exceeded'
  | 'duplicate'
  | 'bid_below_min'
  | 'rejected'
  | 'shadow'
```

3. Inside `executePartnerBidNode`, immediately after the line that resolves the partner slug from `node.config` (reuse that existing variable — call it `slug` here) and before the Supabase config load / circuit / cap / dedup / `resolveBid`, add:

```typescript
  // Shadow dry-run: no partner submission, no dedup call, no bid-attempt write.
  if (isShadowDryRun(ctx)) return shadowPartnerBidStub(slug)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/partner-bid-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing partner-bid suite to confirm no regression**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/partner-bid.test.ts`
Expected: PASS (all existing tests).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/engine/nodes/partner-bid.ts apps/worker/src/engine/nodes/__tests__/partner-bid-shadow.test.ts
git commit -m "Stub Partner Bid node in shadow dry-run (skip, no DB/network)"
```

---

### Task 5: Achieve Offers node dry-run stub

**Files:**
- Modify: `apps/worker/src/engine/nodes/achieve-offers.ts:94` (guard at the top of `executeAchieveOffersNode`)
- Test: `apps/worker/src/engine/nodes/__tests__/achieve-offers-shadow.test.ts`

**Interfaces:**
- Consumes: `isShadowDryRun`, `shadowAchieveStub` from `../../shadow`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/achieve-offers-shadow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeAchieveOffersNode } from '../achieve-offers'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'achieve_offers', namespace: 'achieve', config: { products: ['fdr'] } } as unknown as NodeDefinition

describe('executeAchieveOffersNode — shadow dry_run', () => {
  it('returns a stub with no _achieve_evaluation marker and no fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executeAchieveOffersNode(node, ctx('dry_run'))
    expect(fetchMock).not.toHaveBeenCalled()
    const out = res.output as Record<string, unknown>
    expect(out._shadow).toBe(true)
    expect(out._achieve_evaluation).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/achieve-offers-shadow.test.ts`
Expected: FAIL (fetch called or output carries the evaluation marker).

- [ ] **Step 3: Add the guard**

In `apps/worker/src/engine/nodes/achieve-offers.ts`, add the import:

```typescript
import { isShadowDryRun, shadowAchieveStub } from '../shadow'
```

As the first statement inside `executeAchieveOffersNode`, add:

```typescript
  // Shadow dry-run: don't hit the Achieve API; return a stub that the achieve-log
  // hook ignores (no _achieve_evaluation marker → no DB write).
  if (isShadowDryRun(ctx)) return shadowAchieveStub()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/achieve-offers-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/achieve-offers.ts apps/worker/src/engine/nodes/__tests__/achieve-offers-shadow.test.ts
git commit -m "Stub Achieve Offers node in shadow dry-run"
```

---

### Task 6: Data Store node — skip KV writes in dry-run

**Files:**
- Modify: `apps/worker/src/engine/nodes/data-store.ts` (`set` case line 53, `delete` case line 92)
- Test: `apps/worker/src/engine/nodes/__tests__/data-store-shadow.test.ts`

**Interfaces:**
- Consumes: `isShadowDryRun` from `../../shadow`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/data-store-shadow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeDataStoreNode } from '../data-store'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

function envWithKv(put: ReturnType<typeof vi.fn>, del: ReturnType<typeof vi.fn>) {
  return { SUBMISSIONS: { put, get: vi.fn().mockResolvedValue(null), delete: del } } as never
}

describe('executeDataStoreNode — shadow dry_run', () => {
  it('does not write KV on set, but returns the set output shape', async () => {
    const put = vi.fn(); const del = vi.fn()
    const node = { type: 'data_store', namespace: 'ds', config: { operation: 'set', key: 'k', value: { a: 1 }, ttl_seconds: 120 } } as unknown as NodeDefinition
    const res = await executeDataStoreNode(node, ctx('dry_run'), envWithKv(put, del))
    expect(put).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ store: 'submissions', operation: 'set', key: 'k' })
  })

  it('does not delete KV on delete', async () => {
    const put = vi.fn(); const del = vi.fn()
    const node = { type: 'data_store', namespace: 'ds', config: { operation: 'delete', key: 'k' } } as unknown as NodeDefinition
    const res = await executeDataStoreNode(node, ctx('dry_run'), envWithKv(put, del))
    expect(del).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ store: 'submissions', operation: 'delete', key: 'k' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/data-store-shadow.test.ts`
Expected: FAIL — `put`/`delete` are called.

- [ ] **Step 3: Guard the writes**

In `apps/worker/src/engine/nodes/data-store.ts`, add the import:

```typescript
import { isShadowDryRun } from '../shadow'
```

In the `set` case, replace the `await kv.put(...)` line (line 59) with:

```typescript
      if (!isShadowDryRun(ctx)) {
        await kv.put(key, JSON.stringify(value), putOpts)
      }
```

In the `delete` case, replace the `await kv.delete(key)` line (line 93) with:

```typescript
      if (!isShadowDryRun(ctx)) {
        await kv.delete(key)
      }
```

(The `get` case is a read — left untouched; reads are not side effects.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/data-store-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/data-store.ts apps/worker/src/engine/nodes/__tests__/data-store-shadow.test.ts
git commit -m "Skip Data Store KV writes in shadow dry-run"
```

---

### Task 7: Pass shadow_mode into the Code node sandbox

**Files:**
- Modify: `apps/worker/src/engine/nodes/code.ts:129-138` (the sandbox request `body`)
- Test: `apps/worker/src/engine/nodes/__tests__/code-shadow.test.ts`

**Interfaces:**
- Produces: the sandbox request body now carries `shadow_mode: 'off' | 'dry_run'`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/nodes/__tests__/code-shadow.test.ts`. This asserts the dispatched sandbox body includes `shadow_mode`. Mock `dispatchWithFallback` via the module it lives in (confirm the import path/name from `code.ts`; it is imported near the top of `code.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest'

const dispatchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ __bsv: 1, output: { ok: true } }) })
vi.mock('../code-dispatch', () => ({ dispatchWithFallback: dispatchMock }))

import { executeCodeNode } from '../code'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: { a: 1 }, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { type: 'code', namespace: 'c1', config: { script: 'export default () => ({ ok: true })' } } as unknown as NodeDefinition

describe('executeCodeNode — shadow_mode in sandbox body', () => {
  it('includes shadow_mode in the dispatched body', async () => {
    dispatchMock.mockClear()
    await executeCodeNode(node, ctx('dry_run'), {} as never)
    const body = JSON.parse(dispatchMock.mock.calls[0][3] as string)
    expect(body.shadow_mode).toBe('dry_run')
  })

  it('defaults shadow_mode to off when unset', async () => {
    dispatchMock.mockClear()
    await executeCodeNode(node, ctx(undefined), {} as never)
    const body = JSON.parse(dispatchMock.mock.calls[0][3] as string)
    expect(body.shadow_mode).toBe('off')
  })
})
```

> Note: `dispatchWithFallback` is imported in `code.ts` — confirm its module path (the mock target `'../code-dispatch'` above must match that import) and that the `body` argument is the 4th positional arg (index 3) of `dispatchWithFallback(env, workflowId, namespace, body, codeBundleName, signal)`. Adjust the mock path / arg index to match the real signature.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/code-shadow.test.ts`
Expected: FAIL — `body.shadow_mode` is `undefined`.

- [ ] **Step 3: Add the field to the body**

In `apps/worker/src/engine/nodes/code.ts`, in the `JSON.stringify({ ... })` body (lines 129-138), add the `shadow_mode` field:

```typescript
  const body = JSON.stringify({
    payload: ctx.trigger.payload,
    steps: stepsToSend,
    env: mergedEnv,
    execution: ctx.execution ?? { trace_id: ctx.trigger.trace_id },
    props: resolvedProps,
    // Outbound code scripts (e.g. Equifax credit pull) must check this and
    // return a stub when 'dry_run' — the engine can't introspect the sandbox.
    // See docs/engine-cutover-scope.md §3.3.
    shadow_mode: ctx.shadow_mode ?? 'off',
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/engine/nodes/__tests__/code-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/code.ts apps/worker/src/engine/nodes/__tests__/code-shadow.test.ts
git commit -m "Expose shadow_mode to Code node sandbox scripts"
```

---

### Task 8: Shadow route — 204 + background execution

**Files:**
- Create: `apps/worker/src/routes/shadow.ts`
- Modify: `apps/worker/src/index.ts:137` (mount the router next to `app.route('/webhooks', webhooks)`)
- Test: `apps/worker/src/routes/__tests__/shadow.test.ts`

**Interfaces:**
- Consumes: `apiKeyAuth`, `Variables` from `../middleware/api-key-auth`; `executeWorkflow` from `../engine/index`; `createSupabaseClient` from `../lib/supabase`.
- Produces: `POST /shadow/:workflow_id` returning `204`.

**Source label for shadow runs (D3):** the route stamps `source = '${source}__shadow'` so shadow runs are filterable apart from real test runs while still `is_test = true`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/routes/__tests__/shadow.test.ts`. Mock the engine so the test asserts the route contract (204 + correct `executeWorkflow` options) without running the engine:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeMock = vi.fn().mockResolvedValue({ executionId: 'e1', response: {}, status: 200, traceId: 't1' })
vi.mock('../../engine/index', () => ({
  executeWorkflow: executeMock,
  SourceNotAuthorizedError: class extends Error {},
  SourceAuthUnavailableError: class extends Error {},
}))
vi.mock('../../lib/supabase', () => ({ createSupabaseClient: () => ({}) }))
vi.mock('../../middleware/api-key-auth', () => ({
  apiKeyAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => { c.set('source', 'engine'); await next() },
}))

import shadow from '../shadow'
import { Hono } from 'hono'

function app() {
  const a = new Hono()
  a.route('/shadow', shadow)
  return a
}

describe('POST /shadow/:workflow_id', () => {
  beforeEach(() => executeMock.mockClear())

  it('returns 204 and runs the workflow as a dry-run shadow test', async () => {
    const res = await app().request('/shadow/wf-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ lead: 1 }),
    }, { waitUntil: (p: Promise<unknown>) => p, passThroughOnException: () => {} })

    expect(res.status).toBe(204)
    expect(executeMock).toHaveBeenCalledTimes(1)
    const opts = executeMock.mock.calls[0][0]
    expect(opts).toMatchObject({
      workflowId: 'wf-1',
      payload: { lead: 1 },
      source: 'engine__shadow',
      isTest: true,
      shadowMode: 'dry_run',
      enforceSourceAssignment: false,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/routes/__tests__/shadow.test.ts`
Expected: FAIL — `Cannot find module '../shadow'`.

- [ ] **Step 3: Create the route**

Create `apps/worker/src/routes/shadow.ts`:

```typescript
import { Hono } from 'hono'
import type { Env } from '../index'
import { apiKeyAuth, type Variables } from '../middleware/api-key-auth'
import { executeWorkflow } from '../engine/index'
import { createSupabaseClient } from '../lib/supabase'

// Shadow mirror endpoint (Phase 4.3). Pipedream fires a fire-and-forget copy of
// each real engine request here. We acknowledge with 204 immediately so the
// mirror step never blocks Pipedream, then run the workflow in the background as
// a dry-run shadow: all logic runs, every outbound call is stubbed. Marked
// is_test so it reuses the existing suppression (no sightings, no Slack alerts)
// and stays out of prod dashboards. Separate route from the eventual cutover
// endpoint so removing the mirror at cutover touches nothing real.
// See docs/engine-cutover-scope.md §3.3.
const shadow = new Hono<{ Bindings: Env; Variables: Variables }>()

shadow.post('/:workflow_id', apiKeyAuth, async (c) => {
  const workflowId = c.req.param('workflow_id') as string
  const source = c.get('source') as string

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    payload = {}
  }

  const supabase = createSupabaseClient(c.env)

  c.executionCtx.waitUntil(
    executeWorkflow(
      {
        workflowId,
        payload,
        source: `${source}__shadow`,
        isTest: true,
        shadowMode: 'dry_run',
        enforceSourceAssignment: false,
      },
      c.env,
      supabase,
      c.executionCtx
    ).catch((err) => console.error('[shadow] execution failed:', err))
  )

  return c.body(null, 204)
})

export default shadow
```

In `apps/worker/src/index.ts`, add the import near the other route imports and mount it right next to the webhooks route (line 137):

```typescript
import shadow from './routes/shadow'
// ...
app.route('/webhooks', webhooks)
app.route('/shadow', shadow)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/routes/__tests__/shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: Done, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/shadow.ts apps/worker/src/routes/__tests__/shadow.test.ts apps/worker/src/index.ts
git commit -m "Add POST /shadow/:workflow_id dry-run mirror endpoint"
```

---

### Task 9: Full-suite regression, docs, and TODO update

**Files:**
- Modify: `TODO.md` (mark 4.3 in progress / note what shipped)
- Modify: `docs/engine-cutover-scope.md` (note the implemented design: is_test reuse, `__shadow` source suffix, code-script self-stub contract)
- Create: `docs/nodes/shadow-mode.md` (short operator/author doc: what dry-run does, which nodes stub, the code-script `shadow_mode` contract for outbound scripts)

- [ ] **Step 1: Run the full worker suite**

Run: `pnpm --filter worker exec vitest run`
Expected: PASS (all prior tests + the new shadow tests). Investigate any failure before proceeding.

- [ ] **Step 2: Typecheck + lint the whole repo**

Run: `pnpm typecheck && pnpm lint`
Expected: Done, no errors.

- [ ] **Step 3: Write the author/operator doc**

Create `docs/nodes/shadow-mode.md`:

```markdown
# Shadow mirror mode (dry run)

Shadow mode lets Bidspoke process real engine traffic without doing anything for
real — a dress rehearsal to prove volume handling before cutover.

## How it runs

Pipedream (still the live system) fires a fire-and-forget copy of each request at
`POST https://<worker-host>/shadow/<workflow_id>` with the same `X-API-Key`.
Bidspoke returns `204` immediately and runs the workflow in the background with
`shadow_mode: 'dry_run'`. The run is marked `is_test = true`, so it does not emit
Slack alerts, does not write lead sightings, and is excluded from prod dashboards.
Shadow runs carry a `__shadow` suffix on their source so they are filterable.

## What dry run skips

These node types return a tagged `_shadow` stub instead of making their call:
Integration (HTTP), Salesforce, Partner Bid (returns a `shadow` skip), Achieve
Offers. Data Store skips KV writes (`set`/`delete`); reads still run. Filters,
Branches, Transforms, matrix lookups and the rest run for real — that is the
point: the decision logic executes, the side effects do not.

## Code nodes: author responsibility

The engine cannot see inside a Code node's sandbox, so an outbound Code script
must stub itself. Every code script receives a `shadow_mode` value (`'off'` or
`'dry_run'`). Any script that makes an outbound call (e.g. the Equifax credit
pull, a partner submission) must short-circuit:

    if (shadow_mode === 'dry_run') {
      return { /* a realistic stubbed success shape for this step */ }
    }

Pure-transform code nodes need no change.
```

- [ ] **Step 4: Update TODO.md and the scope doc**

In `TODO.md`, under Phase 4 critical path, update the 4.3 line to reflect that the dry-run shadow endpoint + `shadow_mode` flag shipped, and that the remaining piece is the Pipedream-side mirror step + turning it on. In `docs/engine-cutover-scope.md` §3.3, add a short "Implemented as" note: is_test reuse for suppression, `__shadow` source suffix instead of a new column, and the code-script self-stub contract (D2).

- [ ] **Step 5: Commit**

```bash
git add TODO.md docs/engine-cutover-scope.md docs/nodes/shadow-mode.md
git commit -m "Document shadow mirror mode and update Phase 4.3 status"
```

- [ ] **Step 6: Push everything**

```bash
git push
```

---

## Self-Review

**Spec coverage (scope §3.3):**
- "Bidspoke-side flag, two states off/dry_run" → Task 1 (`ExecutionContext.shadow_mode`, `ExecuteOptions.shadowMode`). ✓
- "Mirror on Pipedream side, fire-and-forget, Bidspoke returns 204 after queueing via waitUntil" → Task 8 (route returns 204, runs via `waitUntil`). The Pipedream-side mirror step itself is built in Pipedream, not this repo — noted in Task 9. ✓
- "Runs the workflow — loads definition, parses payload, evaluates filters, matrix lookups, simulates bid decisions" → unchanged engine path; only outbound executors guarded. ✓
- "Skips all external side effects: no Salesforce writes, no Equifax calls, no partner submissions, no Slack alerts" → Salesforce (Task 3), Equifax via code self-stub (Task 7 + D2), partner submissions (Task 4), Slack alerts (free via `isTest: true`, Task 8). ✓
- "Stub output is logged for spot-check" → stubs flow through normal step logging (execution_steps), tagged `_shadow`. ✓
- "Every node type that performs an outbound call checks `ctx.shadow_mode === 'dry_run'`" → Integration, Partner Bid, Salesforce, Achieve, Data Store (Tasks 2-6); Code via passed flag (Task 7). ✓
- "Separate route from the cutover endpoint" → Task 8 dedicated `/shadow` route. ✓
- "Flag stays, reusable for every future partner migration" → `shadow_mode` is a general context field, not scaffolding. ✓

**Gaps / deliberately out of scope:** the Pipedream mirror step (built in Pipedream, not this repo); the cutover route and `shadow_mode: 'off'` real path (that is the cutover task 4.0, not 4.3); token auth (4.4) — not required, shadow runs on X-API-Key per scope line 186.

**Placeholder scan:** none — every step has concrete code or an exact command. Two "confirm the exact name" notes (partner-bid slug field in Task 4; `dispatchWithFallback` mock path/arg index in Task 7) are verification instructions against named real symbols, not missing content.

**Type consistency:** `shadow_mode` (snake_case) on `ExecutionContext`; `shadowMode` (camelCase) on `ExecuteOptions` — matches the codebase convention (context fields snake_case, options camelCase, mapped at index.ts:254). Stub builders return `StepExecutionResult` consumed by `executeNode`'s return type. `SkipReason` extended with `'shadow'` (Task 4) is the only type widened, used only by `shadowPartnerBidStub`.
```
