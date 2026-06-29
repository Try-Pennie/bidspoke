# Phase 1 (#420) — Watched-field map derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 0 `deriveWatchedFields` stub with a real in-engine derivation that returns every `steps.X.Y.Z` output field any node reads, from both structured config references and code-script scans.

**Architecture:** A new focused module `watched-fields.ts` owns derivation: a chain regex pulls `steps.X.Y.Z` references out of (a) the whole definition tree minus code `script` fields (structured: templates, conditions, transforms, formulas, variables) and (b) each code node's script via a bail-open scan. One normalizer drops the `output`/`$return_value` wrapper, truncates at brackets, and dedups. The Phase 0 finalize seam (`fieldPresenceForCapture`) is unchanged except that its `deriveWatchedFields` now does real work.

**Tech Stack:** TypeScript (strict), Cloudflare Worker engine, Vitest (`vitest run`). No new dependencies.

## Global Constraints

- TypeScript strict; avoid `any`. Straight quotes only; no em dashes; no comments unless logic is non-obvious.
- Worker engine ratchet: `src/engine/**` has `no-unsafe-*` as ERROR. Keep new code fully typed.
- Booleans only ever persist; no resolved value leaves the worker (Phase 0 already enforces; this plan only changes which paths are resolved, never persists values).
- Watch `steps.*` only. Skip `trigger.*`, `env.*`, `execution.*`.
- Ships dark behind `FIELD_PRESENCE_CAPTURE` (off). No DB/schema change in this phase.
- Run worker tests with: `pnpm --filter worker test` (or `cd apps/worker && pnpm test`). Never broad `eslint --fix` on the worker (strips needed assertions).
- Under-derivation (missing a real reference) is the dangerous direction; over-capture is acceptable (the Phase 3 stability gate absorbs it).

---

### Task 1: Extract `hasDynamicStepsAccess` guard from `extractReferencedSteps`

Pull the four dynamic-access bail regexes out of `extractReferencedSteps` into a named, exported helper so the new code-script field extractor reuses the identical bail-open logic. Behavior-preserving for the #190 step-scoping path.

**Files:**
- Modify: `apps/worker/src/engine/nodes/code.ts:61-73`
- Test: `apps/worker/src/engine/nodes/__tests__/code.test.ts`

**Interfaces:**
- Produces: `export function hasDynamicStepsAccess(script: string): boolean` — true when the script uses `steps[...]` bracket access, whole-object aliasing, `Object.keys/entries/values/assign(steps)`, or `for (... in/of steps)`.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/engine/nodes/__tests__/code.test.ts` (import `hasDynamicStepsAccess` alongside existing imports from `../code`):

```ts
describe('hasDynamicStepsAccess', () => {
  it('is false for plain dot references', () => {
    expect(hasDynamicStepsAccess('const x = steps.foo.output.a')).toBe(false)
  })
  it('is true for bracket access', () => {
    expect(hasDynamicStepsAccess('steps["foo"]')).toBe(true)
  })
  it('is true for whole-object aliasing', () => {
    expect(hasDynamicStepsAccess('const all = steps')).toBe(true)
  })
  it('is true for Object.keys(steps)', () => {
    expect(hasDynamicStepsAccess('Object.keys(steps)')).toBe(true)
  })
  it('is true for for-in over steps', () => {
    expect(hasDynamicStepsAccess('for (const k in steps) {}')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- code.test.ts`
Expected: FAIL — `hasDynamicStepsAccess is not exported` / not a function.

- [ ] **Step 3: Refactor `extractReferencedSteps` to use the helper**

In `apps/worker/src/engine/nodes/code.ts`, add the exported helper above `extractReferencedSteps` and replace the four inline guards with a call:

```ts
/**
 * True when a script accesses `steps` in a way that defeats static analysis:
 * bracket access, whole-object aliasing, Object.* iteration, or for-in/of.
 * Shared by extractReferencedSteps (step-scoping, #190) and the watched-field
 * code scanner (#420), so both bail open on exactly the same patterns.
 */
export function hasDynamicStepsAccess(script: string): boolean {
  if (/\bsteps\s*\[/.test(script)) return true
  if (/\b(?:const|let|var)\s+\w+\s*=\s*steps\b(?!\.)/.test(script)) return true
  if (/\bObject\s*\.\s*(?:keys|entries|values|assign)\s*\(\s*steps\b/.test(script)) return true
  if (/\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+(?:in|of)\s+steps\b/.test(script)) return true
  return false
}
```

Then change `extractReferencedSteps` so its first lines become:

```ts
function extractReferencedSteps(script: string): Set<string> | null {
  if (hasDynamicStepsAccess(script)) return null
  const refs = new Set<string>()
  const re = /\bsteps\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) {
    refs.add(m[1])
  }
  return refs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- code.test.ts`
Expected: PASS — new `hasDynamicStepsAccess` tests pass and all pre-existing `extractReferencedSteps` / code-node tests still pass (regression confirmed by the unchanged existing suite).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/nodes/code.ts apps/worker/src/engine/nodes/__tests__/code.test.ts
git commit -m "refactor(worker): extract shared hasDynamicStepsAccess guard (#420)"
```

---

### Task 2: Chain regex + structured extractor + normalizer in `watched-fields.ts`

Create the new module with the reference-chain regex, the structured config-tree extractor, and the segment normalizer. No engine wiring yet.

**Files:**
- Create: `apps/worker/src/engine/watched-fields.ts`
- Test: `apps/worker/src/engine/__tests__/watched-fields.test.ts`

**Interfaces:**
- Produces:
  - `export function extractChains(text: string): string[]` — every `steps...` chain substring found in `text` (raw, e.g. `steps.x?.$return_value?.final`).
  - `export function normalizeRefSegments(segments: string[]): string[]` — segments AFTER `steps` (e.g. `['x','output','y']`) → canonical `['x','y']` (wrapper dropped). Caller has already split.
  - `export function chainToWatchedField(chain: string): string` — one raw chain → canonical dotted field (`steps.x.$return_value.final` → `x.final`).
  - `export function collectStructuredRefs(value: unknown, into: Set<string>): void` — recursively walk any value; for every string, add each chain's canonical field to `into`. Skips object keys named `script`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/engine/__tests__/watched-fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  extractChains,
  normalizeRefSegments,
  chainToWatchedField,
  collectStructuredRefs,
} from '../watched-fields'

describe('extractChains', () => {
  it('finds a chain inside a template', () => {
    expect(extractChains('{{steps.x.output.final}}')).toEqual(['steps.x.output.final'])
  })
  it('finds both operands of a coalesce', () => {
    expect(extractChains('steps.a.output.v ?? steps.b.output.v')).toEqual([
      'steps.a.output.v',
      'steps.b.output.v',
    ])
  })
  it('finds the chain in an arithmetic expression and stops at the operator', () => {
    expect(extractChains('steps.x.output.amount * 0.65')).toEqual(['steps.x.output.amount'])
  })
  it('stops a chain at a bracket', () => {
    expect(extractChains('steps.x.output.list[0].field')).toEqual(['steps.x.output.list'])
  })
  it('handles optional chaining and $return_value', () => {
    expect(extractChains('steps.pennie_or_eligibility?.$return_value?.final')).toEqual([
      'steps.pennie_or_eligibility?.$return_value?.final',
    ])
  })
  it('does not match steps inside a larger identifier', () => {
    expect(extractChains('mysteps.x.y')).toEqual([])
  })
  it('matches a namespace-only reference', () => {
    expect(extractChains('{{steps.constants.$return_value}}')).toEqual([
      'steps.constants.$return_value',
    ])
  })
})

describe('normalizeRefSegments', () => {
  it('drops a leading output wrapper', () => {
    expect(normalizeRefSegments(['x', 'output', 'y'])).toEqual(['x', 'y'])
  })
  it('drops a leading $return_value wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value', 'y'])).toEqual(['x', 'y'])
  })
  it('leaves a plain path untouched', () => {
    expect(normalizeRefSegments(['x', 'y'])).toEqual(['x', 'y'])
  })
  it('keeps a namespace-only path', () => {
    expect(normalizeRefSegments(['x'])).toEqual(['x'])
  })
  it('keeps a namespace whose only segment is the wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value'])).toEqual(['x'])
  })
})

describe('chainToWatchedField', () => {
  it('normalizes the Scout chain', () => {
    expect(chainToWatchedField('steps.pennie_or_eligibility?.$return_value?.final')).toBe(
      'pennie_or_eligibility.final',
    )
  })
})

describe('collectStructuredRefs', () => {
  it('collects from nested objects and arrays', () => {
    const set = new Set<string>()
    collectStructuredRefs(
      { body: { a: '{{steps.x.output.final}}' }, list: ['steps.y.output.v'] },
      set,
    )
    expect([...set].sort()).toEqual(['x.final', 'y.v'])
  })
  it('skips a script-keyed string', () => {
    const set = new Set<string>()
    collectStructuredRefs({ script: 'steps.x.output.final', source: 'steps.y.output.v' }, set)
    expect([...set].sort()).toEqual(['y.v'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: FAIL — module not found / functions not exported.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/engine/watched-fields.ts`:

```ts
// Watched-field derivation (#420). Pulls every `steps.X.Y.Z` output field any
// node reads out of a workflow definition, so the field-presence capture can
// record whether each read field carried a value per execution. Under-derivation
// is the dangerous direction (a missed reference is silently unwatched), so the
// extractor leans toward capturing; over-capture is absorbed by the detector's
// stability gate downstream.

// A `steps...` reference chain: `steps` (not part of a larger identifier) then
// one or more `.ident` / `?.ident` segments. Whitespace around separators is
// tolerated to match the existing code scanner. A bracket ends the chain, so
// `steps.x.list[0]` yields `steps.x.list`.
const CHAIN_RE =
  /(?<![\w$])steps(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*(?:(?:\s*\?\.\s*|\s*\.\s*)[A-Za-z_$][\w$]*)*/g

export function extractChains(text: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  CHAIN_RE.lastIndex = 0
  while ((m = CHAIN_RE.exec(text)) !== null) {
    out.push(m[0])
  }
  return out
}

// Segments AFTER the `steps` root. Drops a leading output wrapper segment
// (`output` or the Pipedream-legacy `$return_value`) so `x.output.y`,
// `x.$return_value.y`, and `x.y` all normalize to `x.y`.
export function normalizeRefSegments(segments: string[]): string[] {
  if (segments[1] === 'output' || segments[1] === '$return_value') {
    return [segments[0], ...segments.slice(2)]
  }
  return segments
}

export function chainToWatchedField(chain: string): string {
  const parts = chain.replace(/\s+/g, '').replace(/\?\./g, '.').split('.')
  // parts[0] is the literal "steps" root.
  return normalizeRefSegments(parts.slice(1)).join('.')
}

// Recursively walk any value; for every string, add each chain's canonical
// watched field to `into`. Object keys named `script` are skipped (those are raw
// code and go through the bail-open code scanner instead of the structured path).
export function collectStructuredRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const chain of extractChains(value)) into.add(chainToWatchedField(chain))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredRefs(item, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'script') continue
      collectStructuredRefs(v, into)
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: PASS — all `extractChains`, `normalizeRefSegments`, `chainToWatchedField`, `collectStructuredRefs` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/watched-fields.ts apps/worker/src/engine/__tests__/watched-fields.test.ts
git commit -m "feat(worker): chain regex + structured ref extractor for watched fields (#420)"
```

---

### Task 3: Code-script field extractor (`collectCodeRefs`)

Add the bail-open code-script scanner that recovers deep field paths from a code node's script, reusing `hasDynamicStepsAccess`.

**Files:**
- Modify: `apps/worker/src/engine/watched-fields.ts`
- Test: `apps/worker/src/engine/__tests__/watched-fields.test.ts`

**Interfaces:**
- Consumes: `hasDynamicStepsAccess` from `./nodes/code` (Task 1); `extractChains`, `chainToWatchedField` (Task 2).
- Produces: `export function collectCodeRefs(script: string, into: Set<string>): boolean` — adds canonical fields from the script to `into`; returns `false` and adds nothing when the script bails open (dynamic access), `true` otherwise. The boolean is the "readable" signal Phase 4 will surface.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/engine/__tests__/watched-fields.test.ts` (add `collectCodeRefs` to the import):

```ts
describe('collectCodeRefs', () => {
  it('captures the Scout field from a full literal path', () => {
    const set = new Set<string>()
    const readable = collectCodeRefs(
      'const debt = steps.pennie_or_eligibility?.$return_value?.final ?? null',
      set,
    )
    expect(readable).toBe(true)
    expect([...set]).toEqual(['pennie_or_eligibility.final'])
  })
  it('captures multiple fields across a script', () => {
    const set = new Set<string>()
    collectCodeRefs('const a = steps.x.$return_value.v; const b = steps.y.output.w', set)
    expect([...set].sort()).toEqual(['x.v', 'y.w'])
  })
  it('bails open on bracket access and adds nothing', () => {
    const set = new Set<string>()
    const readable = collectCodeRefs('const v = steps["foo"].bar', set)
    expect(readable).toBe(false)
    expect(set.size).toBe(0)
  })
  it('bails open on whole-object aliasing', () => {
    const set = new Set<string>()
    const readable = collectCodeRefs('const all = steps; return all.x.final', set)
    expect(readable).toBe(false)
    expect(set.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: FAIL — `collectCodeRefs is not exported`.

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/engine/watched-fields.ts`, add the import at the top and the function at the end:

```ts
import { hasDynamicStepsAccess } from './nodes/code'
```

```ts
// Scan a code node's script for full literal `steps.X.Y.Z` field reads. Bails
// open (returns false, adds nothing) on the same dynamic-access patterns
// extractReferencedSteps bails on, so a node we cannot statically read is never
// given a wrong watch. A field read ONLY through a renamed local and never once
// as a full literal is missed by design (scan, not instrument); see the spec.
export function collectCodeRefs(script: string, into: Set<string>): boolean {
  if (hasDynamicStepsAccess(script)) return false
  for (const chain of extractChains(script)) into.add(chainToWatchedField(chain))
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: PASS — including the Scout-capture and both bail-open cases.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/watched-fields.ts apps/worker/src/engine/__tests__/watched-fields.test.ts
git commit -m "feat(worker): bail-open code-script field scanner (#420)"
```

---

### Task 4: `deriveWatchedFields(definition)` end-to-end

Tie the two extractors together over a full definition: whole-tree structured walk (skips `script` keys) plus a per-code-node script scan. This is the function the Phase 0 seam calls.

**Files:**
- Modify: `apps/worker/src/engine/watched-fields.ts`
- Test: `apps/worker/src/engine/__tests__/watched-fields.test.ts`

**Interfaces:**
- Consumes: `collectStructuredRefs` (Task 2), `collectCodeRefs` (Task 3); `WorkflowDefinition`, `NodeDefinition` from `../types`.
- Produces: `export function deriveWatchedFields(definition: WorkflowDefinition): string[]` — sorted, deduped canonical watched fields across all nodes (config minus script, variables), all edges (conditions), and all readable code scripts.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/engine/__tests__/watched-fields.test.ts` (add `deriveWatchedFields` to the import; import the type):

```ts
import type { WorkflowDefinition } from '../../types'

function def(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'wf',
    name: 'wf',
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [],
    edges: [],
    ...partial,
  }
}

describe('deriveWatchedFields', () => {
  it('returns [] for the empty definition', () => {
    expect(deriveWatchedFields(def({}))).toEqual([])
  })

  it('collects structured refs from a node config and an edge condition', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'resp', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
      ],
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.score', operator: 'gt', value: 600 }] }] },
        } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.final', 'y.score'])
  })

  it('scans a code node script and normalizes the Scout field (end to end)', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          id: 'n1',
          namespace: 'pennie_or_eligibility',
          type: 'code',
          config: { script: 'const debt = steps.pennie_or_eligibility?.$return_value?.final ?? null; return { final: debt }' },
        } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['pennie_or_eligibility.final'])
  })

  it('does not pick up structured refs from inside a script and bails the node open', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'c', type: 'code', config: { script: 'const all = steps; return all.x.final' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual([])
  })

  it('dedups the same field reached via output and $return_value wrappers', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { a: 'steps.x.output.v', b: 'steps.x.$return_value.v' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.v'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: FAIL — `deriveWatchedFields is not exported` from `watched-fields`.

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/engine/watched-fields.ts`, add the type import and the function:

```ts
import type { WorkflowDefinition } from '../types'
```

```ts
// The full watched-field set for a definition: structured references across the
// whole tree (node configs minus their `script`, node variables, edge
// conditions) plus deep field reads from each readable code-node script. Derived
// in-engine from the running definition, so it always matches the live version
// (no stored column, no drift).
export function deriveWatchedFields(definition: WorkflowDefinition): string[] {
  const set = new Set<string>()
  collectStructuredRefs(definition.nodes, set)
  collectStructuredRefs(definition.edges, set)
  for (const node of definition.nodes) {
    const script = node.config?.script
    if (typeof script === 'string') collectCodeRefs(script, set)
  }
  return [...set].sort()
}
```

Note: `collectStructuredRefs` already skips the `script` key while walking `definition.nodes`, so the structured walk never sees script source; the explicit loop is the only path that reads scripts (via the bail-open scanner).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- watched-fields.test.ts`
Expected: PASS — all five `deriveWatchedFields` cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/engine/watched-fields.ts apps/worker/src/engine/__tests__/watched-fields.test.ts
git commit -m "feat(worker): deriveWatchedFields over full definition (#420)"
```

---

### Task 5: Wire into `field-presence.ts` and teach `parseWatchedField` the `$return_value` wrapper

Replace the Phase 0 stub: `field-presence.ts` imports `deriveWatchedFields` from the new module and removes the local stub. Extend `parseWatchedField` so the resolve path also strips `$return_value`, keeping one normalization contract. The existing `field-presence.test.ts` import of `deriveWatchedFields` from `../field-presence` keeps working via a re-export.

**Files:**
- Modify: `apps/worker/src/engine/field-presence.ts:1-15,47-49`
- Test: `apps/worker/src/engine/__tests__/field-presence.test.ts`

**Interfaces:**
- Consumes: `deriveWatchedFields` from `./watched-fields` (Task 4).
- Produces: `field-presence.ts` re-exports `deriveWatchedFields`; `fieldPresenceForCapture(flag, steps, definition)` now derives real watched fields when the flag is on (unchanged signature).

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/engine/__tests__/field-presence.test.ts`:

```ts
import { computeFieldPresence, deriveWatchedFields, fieldPresenceForCapture } from '../field-presence'
import type { WorkflowDefinition } from '../../types'

describe('computeFieldPresence with $return_value paths', () => {
  it('resolves a $return_value field path the same as output', () => {
    const steps = { foo: step({ final: 7 }) }
    expect(computeFieldPresence(steps, ['foo.$return_value.final'])).toEqual({ 'foo.final': true })
  })
})

describe('deriveWatchedFields (wired through field-presence)', () => {
  it('derives real fields from a definition (no longer a stub)', () => {
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: [{ id: 'n', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any],
      edges: [],
    }
    expect(deriveWatchedFields(definition)).toEqual(['x.final'])
  })
})

describe('fieldPresenceForCapture with a real definition', () => {
  it('records presence for a derived field when the flag is on', () => {
    const steps = { x: step({ final: 'ok' }) }
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: [{ id: 'n', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any],
      edges: [],
    }
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({ 'x.final': true })
  })
})
```

(Keep the existing `field-presence.test.ts` cases as-is. The current stub tests already use empty definitions — `deriveWatchedFields({nodes:[],edges:[]})` → `[]` (line ~65) and `fieldPresenceForCapture('true', steps, {nodes:[],edges:[]})` → `{}` (line ~81) — both of which stay correct after Phase 1 since an empty definition derives no fields. Update their `it(...)` descriptions to drop the "Phase 0 / empty in Phase 0" wording, but the assertions are unchanged. The new cases above add real-definition coverage.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && pnpm test -- field-presence.test.ts`
Expected: FAIL — the `$return_value` resolve case and the real-derivation cases fail against the stub.

- [ ] **Step 3: Write the implementation**

In `apps/worker/src/engine/field-presence.ts`:

Replace the import block top with:

```ts
import type { StepOutput, WorkflowDefinition } from '../types'
import { resolveStepField } from './context'
import { deriveWatchedFields } from './watched-fields'

export { deriveWatchedFields }
```

Extend `parseWatchedField` to strip `$return_value` as well as `output`:

```ts
function parseWatchedField(field: string): string[] {
  let segs = field.split('.').filter(Boolean)
  if (segs[0] === 'steps') segs = segs.slice(1)
  if (segs[1] === 'output' || segs[1] === '$return_value') segs = [segs[0], ...segs.slice(2)]
  return segs
}
```

Delete the old stub `deriveWatchedFields` function body (lines ~40-49) — it is now imported and re-exported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && pnpm test -- field-presence.test.ts watched-fields.test.ts`
Expected: PASS — all field-presence and watched-fields tests green.

- [ ] **Step 5: Run the full worker suite + typecheck**

Run: `cd apps/worker && pnpm test && pnpm --filter worker typecheck` (or repo `pnpm typecheck`)
Expected: PASS — no regressions; engine `no-unsafe-*` ratchet clean for new files.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/engine/field-presence.ts apps/worker/src/engine/__tests__/field-presence.test.ts
git commit -m "feat(worker): wire real deriveWatchedFields into field-presence capture (#420)"
```

---

## Self-Review

**Spec coverage:**
- Structured derivation (templates, conditions, transforms, formulas, variables) → Task 2 (`collectStructuredRefs`) + Task 4 (walk over nodes + edges). Edge conditions are covered because Task 4 walks `definition.edges`.
- Code-script deep scan, `?.`-tolerant, `$return_value`/output normalized, bail-open → Tasks 1 + 3.
- Consolidate the four bail guards → Task 1 (`hasDynamicStepsAccess`).
- One normalizer, bracket truncation, dedup → Task 2 (`normalizeRefSegments`, regex stops at `[`, `Set`).
- Watch `steps.*` only → the regex matches only `steps`-rooted chains; `trigger`/`env`/`execution` never match.
- Namespace-only refs watch whole output → `normalizeRefSegments(['x'])` → `['x']`, covered in Task 2/4 tests.
- Derive at finalize, return `string[]` → Task 5 keeps the `fieldPresenceForCapture(flag, steps, definition)` seam; no load-time caching added.
- `$return_value` in the resolve path → Task 5 `parseWatchedField`.
- File layout (new `watched-fields.ts`, `field-presence.ts` re-exports, guard exported from `code.ts`) → Tasks 1, 2, 5.
- Booleans-only / no value leaves worker → unchanged from Phase 0; this plan resolves no values for persistence (only `computeFieldPresence` does, already boolean).
- No schema change, ships dark → no migration tasks; flag untouched.

**Placeholder scan:** none — every code step shows full code and exact commands.

**Type consistency:** `deriveWatchedFields(WorkflowDefinition): string[]`, `collectStructuredRefs(unknown, Set<string>): void`, `collectCodeRefs(string, Set<string>): boolean`, `hasDynamicStepsAccess(string): boolean`, `chainToWatchedField(string): string`, `normalizeRefSegments(string[]): string[]`, `extractChains(string): string[]` are used consistently across tasks and the seam.

**Note for the implementer:** the `as any` casts in test fixtures are confined to test files to build minimal `NodeDefinition`/`EdgeDefinition` literals; the worker `no-unsafe-*` ratchet is ERROR for `src/engine/**` non-test code, so production code in `watched-fields.ts` must stay fully typed (it is). If the existing `field-presence.test.ts` already imports `deriveWatchedFields` and asserts `[]`, reconcile that assertion in Task 5 Step 1 rather than leaving a contradicting test.
