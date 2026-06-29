# Phase 1 (#420) — Watched-field map derivation (in-engine)

> Implements Phase 1 of the silent-output-field detection milestone (#410).
> Builds on the parent design `2026-06-29-silent-output-field-detection-design.md`
> and the shipped Phase 0 dark write-path (#419, PR #431). Where this doc and the
> #420 issue text disagree (e.g. "derive at definition load"), this doc wins —
> the decision and reasoning are recorded below.

## Goal

Replace the Phase 0 stub `deriveWatchedFields(definition): string[]` (currently
returns `[]`) with a real derivation, so the dark `field_presence` write-path
records, per execution, whether every output field a node actually reads carried
a value. This is the input that lets Phase 2's rollup and Phase 3's detector spot
the Scout class (a step that completes green but returns nothing a downstream
consumer reads).

Phase 1 is the watched-map only. No rollup (Phase 2), no detector/alerts
(Phase 3), no coverage view (Phase 4). The feature flag `FIELD_PRESENCE_CAPTURE`
stays off; this ships dark.

## Core insight

Every reference the engine resolves is a `steps.X.Y.Z` string that lives in one
of two places:

- A node's **config tree** — `{{...}}` templates (`resolveReference`,
  `context.ts`), filter/branch/edge `condition.field` strings (`resolveField`,
  `graph.ts`, including both operands of a `??` coalesce), transform `source`
  mappings (`resolveSource`, `transform.ts`), formulas, and value-or-literal
  sides. These are all just strings somewhere in `node.config`.
- A code node's **script** — raw JS read by the sandbox, e.g.
  `steps.pennie_or_eligibility?.$return_value?.final`.

So derivation is: pull every `steps.X.Y.Z` chain out of those two sources,
normalize, dedup.

## Components

### 1. Structured derivation (config tree)

Recursively walk each node's `config` (the same value-tree walk shape as
`renameStepReferences`/`countStepReferences` in
`apps/web/src/lib/rename-step-references.ts`, but worker-side). For every
**string** encountered, apply the chain regex (below) and collect matches. This
single pass covers templates, conditions (both `??` operands, because the regex
finds every `steps.` occurrence in the string), transform sources, formulas, and
value-or-literal sides — they are all strings.

The `config.script` field is **excluded** from this walk; the script goes to the
code-script extractor, which has different (bail-open) semantics.

### 2. Code-script deep scan

For each code node's `script`:

1. Run the shared **bail-open guard** `hasDynamicStepsAccess(script)`. This is the
   four dynamic-access regexes currently inline in `extractReferencedSteps`
   (`apps/worker/src/engine/nodes/code.ts:61`): `steps[` bracket access, whole-
   object aliasing (`const x = steps`), `Object.keys/entries/values/assign(steps)`,
   and `for (... in/of steps)`. Extract them into one named helper and call it from
   both `extractReferencedSteps` and the new field extractor. Behavior-preserving
   for the existing #190 step-scoping path.
2. If the guard trips, the node contributes **no** watched fields (and is tracked
   internally as "unreadable" — surfaced by Phase 4's coverage view, not Phase 1).
3. Otherwise apply the same chain regex, which is `?.`-tolerant, to recover full
   literal `steps.X.Y.Z` chains.

### 3. Normalization (`normalizeRefSegments`)

Given the raw segments after `steps` from one matched chain:

- Drop a leading wrapper segment if it is `output` **or** `$return_value`
  (`steps.x.output.y`, `steps.x.$return_value.y`, and `steps.x.y` all normalize to
  `x.y`).
- Truncate the chain at the first bracket segment, so `steps.x.list[0].field` and
  `steps.x.map[*].id` both normalize to `x.list` / `x.map` (the array field
  exists). The chain regex naturally stops at `[` because `[` is not an identifier
  char; truncation falls out for free.
- Emit the canonical dotted form `ns.f1.f2` (no `steps.` prefix, no wrapper).

`deriveWatchedFields` dedups normalized strings via a `Set` and returns a sorted
array. `parseWatchedField` in `field-presence.ts` (consumed by
`computeFieldPresence`) is taught to also strip `$return_value` so a single
normalizer governs both derive-time and resolve-time, and canonical strings
round-trip unchanged.

### The chain regex

Matches `steps` followed by one or more dot or optional-chain segments:
`steps` then repeating `(?:\.|\?\.)([A-Za-z_$][\w$]*)`. Captures the full chain as
a substring; the matcher then splits it into segments for `normalizeRefSegments`.
Bracket access ends a chain (the next char after the last identifier is `[`, not an
identifier char). Applied globally so multiple references in one string (coalesce
operands, arithmetic operands, inline interpolation) are all captured.

## Scope decisions

- **Watch `steps.*` only.** Skip `trigger.*` (inbound lead, not a producing node),
  `env.*` (config), and `execution.*` (engine metadata). `computeFieldPresence`
  already ignores non-`steps` namespaces, but the extractor only collects `steps`
  chains so nothing else enters the set.
- **Namespace-only refs included.** `steps.x` / `{{steps.x.$return_value}}`
  normalize to `['x']` and watch the whole node output (did it run and return
  non-null). Cheap; the Phase 3 stability gate protects against no-bid/no-debt
  nodes that return null as their normal answer.
- **Curated money-list dropped** per the parent design (no `CURATED_MONEY_PATH_FIELDS`).

## Decisions (recorded)

1. **Derive at finalize, not definition load.** Keep the Phase 0 seam:
   `fieldPresenceForCapture(flag, steps, definition)` derives from the in-memory
   definition at engine finalize. The #420 issue text said "derive at definition
   load (definition-loader.ts)"; this doc overrides it. Reasoning: the in-memory
   definition at finalize *is* the running version, so zero staleness (load-caching
   adds a 5-minute stale window after a save plus plumbing through three layers);
   derivation is gated by `FIELD_PRESENCE_CAPTURE` (early-return when off, so zero
   cost while dark); and it is ~1-2ms of regex running post-response in
   `waitUntil`. Phase 2 is chartered to measure dark-phase cost and may add
   load-time caching then if real numbers demand it. Do not pre-optimize.
2. **Return `string[]` now.** Per-field source tagging and the unreadable-node
   list are only consumed by Phase 4's coverage view (#423). Build the extractor
   internals structured (per-node results, unreadable tracked internally) so Phase
   4 exposes them cheaply, but keep the seam minimal.

## File layout

- New `apps/worker/src/engine/watched-fields.ts`: `deriveWatchedFields`, the
  structured config-tree extractor, the code-script extractor, the chain regex, and
  `normalizeRefSegments`.
- `apps/worker/src/engine/field-presence.ts`: keeps `computeFieldPresence` and
  `fieldPresenceForCapture`; imports `deriveWatchedFields`; `parseWatchedField`
  gains `$return_value` handling (or delegates to the shared normalizer).
- `apps/worker/src/engine/nodes/code.ts`: export `hasDynamicStepsAccess`;
  `extractReferencedSteps` calls it instead of inlining the four guards.

## Testing (TDD)

Drive each piece with a failing test first:

- **Structured extraction** — template (`{{steps.x.output.final}}`), inline
  interpolation, condition `steps.x.output.field`, coalesce `steps.a.x ?? steps.b.x`
  (both captured), arithmetic `steps.x.amount * 0.65`, transform source, value-or-
  literal side, bracket truncation (`steps.x.list[0].field` → `x.list`,
  `[*]` map-over → array field). Nested config objects/arrays.
- **Code-script extraction** — the Scout case
  `steps.pennie_or_eligibility?.$return_value?.final` → `pennie_or_eligibility.final`;
  `?.` chaining; `$return_value` and `output` wrapper normalization; bail-open on
  each of the four dynamic patterns (returns no fields for that node).
- **Normalizer** — wrapper drop, bracket truncation, dedup of
  `steps.x.output.y` + `steps.x.y` into one entry.
- **End-to-end** — a fixture definition resembling Main Flow asserts the Scout
  field is in the derived set and a no-bid bare-`null` code node still derives its
  referenced fields.
- **Regression guard** — `extractReferencedSteps` produces identical output before
  and after the `hasDynamicStepsAccess` extraction (the #190 scoping behavior is
  unchanged).

## Known limitation (accepted)

A field read in a script **only** through a renamed local (e.g.
`const r = steps.x.$return_value; ... r.final`) and **never once** as a full
`steps.x...final` literal is silently unwatched — the literal-path scan cannot see
it. This is inherent to scan-not-instrument (the chosen approach; instrumenting
live money-moving code was rejected). Verified the live Main Flow does not hit this
for Scout: the field appears as a full literal at
`docs/reference/main-flow-pipedream.ts:520`, so it is caught — but coverage hinges
on that one occurrence. Phase 4's coverage view flags nodes the scanner cannot read
at all; it does not flag this alias-only-read case. Dan accepted this gap on
2026-06-29.

## Non-negotiables carried forward

- Booleans only; no resolved value leaves the worker. (Phase 0 already enforces
  this; Phase 1 only changes which paths are resolved.)
- Ships dark behind `FIELD_PRESENCE_CAPTURE` (off).
- No DB schema change in Phase 1 (the column shipped in Phase 0).
