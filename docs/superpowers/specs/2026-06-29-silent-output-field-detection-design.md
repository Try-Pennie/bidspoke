# Automatic silent-output-field detection (Scout class) — design amendment

> Amends the plan-council outcome in Discussion #418 (milestone #410). This
> document records the design decisions made with Dan on 2026-06-29 that change
> the watch-scope and add a second thread (build-time UI validation). Where this
> doc and #418 disagree, this doc wins.

## Problem

A DB-stored code-node script that does `try { ...fetch... } catch { return null }`
returns `{ output: null, status: 'completed' }`. The engine marks the step green
with no error classification and no page (`engine/nodes/code.ts`,
`engine/index.ts`). The lead proceeds with missing enrichment/eligibility and
routes worse or gets no bid. The Main Flow Scout fallback was dead this way for
3 days / 629 leads with zero alerts. The platform cannot currently detect this
class of silent failure.

## What changed from the plan-council outcome (#418)

The plan-council winner ("thin-slice") proposed watching only *structured*
references automatically and covering code-node-internal reads with a
hand-curated `CURATED_MONEY_PATH_FIELDS` constant, deferring true code-script
scanning to a final Phase 5.

Dan's decisions on 2026-06-29 supersede that:

1. **No money-specific curation.** Watch *any* referenced field, not a
   money-path subset. If a node references a field and it returns nothing, that
   is a candidate signal regardless of path.
2. **Scan code scripts in Phase 1, not Phase 5.** Verified against the live
   Main Flow script (`docs/reference/main-flow-pipedream.ts`): the Scout
   eligibility field is read both through a renamed local
   (`const eligibilityResult = steps.pennie_or_eligibility?.$return_value`, then
   `eligibilityResult.final`) AND as a full literal path at least once
   (`steps.pennie_or_eligibility?.$return_value?.final`, line 520). A scanner
   that captures full literal `steps.X.Y.Z` chains therefore would have caught
   Scout. The "renaming defeats static analysis" concern is real but narrow: a
   field is missed only if it is *never once* written as a full path anywhere in
   the script.
3. **Scan, do not instrument.** The most complete option (wrap the lead data
   handed to each code step and observe real reads at runtime) was rejected:
   it inserts tracking inside live money-moving code that routinely copies,
   spreads, and reshapes data, with real ways to subtly alter author output. The
   scan-the-code approach gets the goal (would have caught Scout) without
   touching live execution.
4. **Silence-with-reason replaces the curated list entirely.** Instead of a
   hand-maintained list of what *to* watch (opt-in, forgettable — the exact
   failure mode that hid Scout), watch everything by default and let an author
   *silence* a specific field with a reason when it is legitimately allowed to
   be empty (opt-out). The coverage view shows silenced fields and their reason.
5. **Build-time UI validation is folded into this milestone (new Thread B).**
   Validate a reference the moment it is typed in the config panel / code
   editor. This is complementary, not a replacement: it catches references that
   point at something that does not exist (typo, deleted/renamed node, wrong
   field) at build time, but cannot catch the Scout class, because Scout's
   reference was valid the whole time and only went dry at runtime.

## Two threads

### Thread A — Runtime silent-drought detection

The original #410 spine, with watch-scope broadened.

- **Watch every referenced field, derived automatically** from two sources:
  - *Structured references* that already carry full dot-paths: `{{...}}`
    templates (`resolveReference`, `context.ts`), filter/branch/edge
    `condition.field` strings (`resolveField`, `graph.ts`, including the `??`
    coalesce split), transform mappings.
  - *Code-script references*: a deep-path extractor that recovers full literal
    `steps.X.Y.Z` chains from code scripts, tolerant of `?.` chaining and
    normalizing the `$return_value`/`output` wrapper. It MUST bail open exactly
    as the existing `extractReferencedSteps` (`code.ts:61`) does on dynamic
    bracket access, whole-object aliasing, and iteration — those nodes get NO
    deep watch and are flagged as unreadable in the coverage view, never given a
    wrong watch.
- **Record presence per run, booleans only.** At engine finalize (block 1,
  `engine/index.ts` ~L528, the `updateExecutionRecord` projection that already
  writes `failed_step_type`/`cost_usd`/`sighting_finalize`), resolve each
  watched path against in-memory `ctx.steps` and stamp a small `field_presence`
  JSONB onto one additive nullable column on `workflow_executions` — one row per
  execution, never per step, off the high-growth `execution_steps` table.
  Computed BEFORE PII redaction (redaction runs later in `flushStepLogs`); only
  booleans persist, so no values leave the worker. Key present ⇒ the producing
  node ran this execution; value ⇒ the field was non-null. This `ran_count`
  denominator (key-present count) vs `present_count` (true count) is what lets
  the detector distinguish "path not taken" from "ran but empty."
- **Alarm only on collapse, never on normal emptiness.**
  - *Tier-1 PAGE — stability gate.* Page only when a watched field's baseline
    presence rate is high-mean and low-variance and then collapses today
    (below `mean − k·stddev`, with a min-sample floor on `ran_count`). This
    structurally excludes legitimately-variable fields (no-bid, no-debt) that
    return null as their normal answer — high variance ⇒ never qualifies as
    stable ⇒ never pages.
  - *Tier-2 DAILY DIGEST — day-one-dead.* A watched field with enough runs and
    presence rate ≈ 0 and no healthy baseline → listed in a once-a-day digest.
    This solves the cold-start case the volume baseline is blind to (Scout was
    exactly this: 629 leads / 3 days / 0 successes, no baseline to regress from).
- **Silence-with-reason (opt-out suppression).** An author can silence a
  specific watched field with a required reason; the detector skips it and the
  coverage view records "silenced, because X." Default is full coverage.
- **Coverage view (Slack-adjacent for v1).** Per workflow: the watched-field
  set, each field's source (structured vs code-scan), current health, silenced
  fields + reasons, and any code steps flagged unreadable. So ops never assume
  total coverage.

### Thread B — Build-time UI reference validation

New, folded in. Prevents broken references when building a workflow.

- In the config panel reference inputs and the Monaco code editor, validate a
  reference as it is typed:
  - *Node exists and is reachable.* `steps.<ns>` must name a node in the graph
    that runs before this one. Statically checkable from nodes + edges. A
    reference to a nonexistent or downstream node is an error.
  - *Field exists where the shape is known.* For nodes with a synced schema
    (Salesforce, Snowflake, integration, partner nodes), validate the field
    path. For nodes whose output shape is not statically knowable (a code
    step's return), stay neutral — "cannot verify" is distinct from "wrong."
  - *`env.*`* validated against the env-var list; `execution.*` against its
    known fields; `trigger.*` payload shape is free.
- Severity: warning (amber), not a hard block, because field shapes are not
  always known.
- Reuses the shared reference parser (below).

### Shared core

Both threads need to parse a reference string into `{ namespace, path[] }` and,
for code, to extract reference chains from a script. `apps/web` already has
`rename-step-references.ts` (parses step references for rename) and the worker
has `extractReferencedSteps` (`code.ts`). The truly shared primitive is the
reference-string parser; extract it once and reuse on both sides rather than
maintaining two copies. Worker (Thread A scan) and web (Thread B validate) are
separate packages, so the shared piece is the small pure parser, not the
runtime-specific glue.

## Phases (revised)

| Phase | Issue | Scope |
|-------|-------|-------|
| 0 | #419 | Schema + dark write path. **Unchanged.** Additive nullable `field_presence jsonb` on `workflow_executions`; build it in finalize block 1 from `ctx.steps` + the watched map; persist via `updateExecutionRecord`; booleans only, before PII redaction; write for test runs too (rollup filters `is_test=false`); behind a default-off feature flag, log-only. Watched-map source is a stub returning `[]` this phase. |
| 1 | #420 | Watched-field map (in-engine), broadened. Structured derivation (templates, conditions, transforms) **plus** deep code-script scanning (full literal `steps.X.Y.Z`, `?.`-tolerant, `$return_value`/output normalized, bail-open on dynamic/alias/iteration). **Curated money list dropped.** Single source of truth for the watched map (re-derived in-engine at load so it always matches the running version). |
| 2 | #421 | `field_presence_daily` rollup + `refresh_field_presence_daily()` pg_cron, cloning `refresh_workflow_stats_daily`. **Confirm fan-out cost in the dark phase** — watching every field is a larger set than a curated list. |
| 3 | #422 | Detector, log-only (Tier-1 stability gate + Tier-2 day-one-dead digest), reusing `volume-anomaly.ts` baseline + KV cooldown. **Adds the silence-with-reason mechanism** (storage + skip logic). |
| 4 | #423 | Slack wiring + coverage view (watched set, source, health, silenced+reason, unreadable gaps). Flip the feature flag live after a dark week confirms no false pages and acceptable rollup cost. |
| 5 | #424 | **Repurposed.** Was "code-node deep-path extraction (deferred)" — now absorbed into Phase 1. Becomes **Thread B: build-time UI reference validation** (config panel + Monaco), reusing the shared parser. |

## Non-negotiables carried from #418

- **Expand/contract migrations.** All columns additive/nullable; code tolerates
  their absence; ship dark first. Apply additive migrations via the Supabase
  dashboard SQL editor + register in `supabase_migrations.schema_migrations`,
  then `gh run rerun <id> --failed`. Do NOT `supabase db push` prod from a
  laptop (caused a ~5 min outage 2026-06-26).
- **No raw values leave the worker.** `field_presence` is booleans only,
  computed before PII redaction; the computation path is reviewed to ensure no
  resolved value can leak into the persisted JSONB or logs.
- **Stability gate is load-bearing.** Without it, every normal no-bid lead
  pages and the alerts get muted. It stays regardless of how broad the watch
  set is.

## Open risks

- **Under-derivation is the silent, dangerous direction.** A real reference the
  scanner misses (alias-only or dynamic) is silently unwatched. Mitigation: the
  coverage view makes unreadable code steps *visible* (not a maintained list),
  and the dark week validates coverage before flipping live.
- **Larger fan-out.** Watching every field across ~80 Main Flow namespaces is a
  much larger `field_presence_daily` than a curated list. Confirm refresh stays
  sub-second and row growth bounded in the dark phase (Phase 2).
- **Field-level UI validation depends on synced schemas.** Where no schema
  exists (code-node outputs), Thread B can only validate the node, not the
  field. This is by design (neutral, not a false error) but limits coverage.
- **Silence-with-reason can be over-used.** If everything noisy gets silenced,
  coverage erodes invisibly. The coverage view surfacing silenced counts is the
  check.
