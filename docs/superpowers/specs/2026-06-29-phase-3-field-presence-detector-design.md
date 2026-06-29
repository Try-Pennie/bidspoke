# Phase 3 (#422) — Field-presence detector (log-only)

> Implements Phase 3 of the silent-output-field detection milestone (#410).
> Reads the Phase 2 `field_presence_daily` rollup. Mirrors `volume-anomaly.ts`.
> Where this doc and the #422 issue text disagree (KV cooldown placement), this
> doc wins; the reasoning is recorded.

## Goal

Detect two shapes of silent output failure from the `field_presence_daily`
rollup, and **log the intended page/digest without sending anything** (log-only
this phase). The detector is the brain; Phase 4 wires the Slack delivery,
per-field cooldown, silence-with-reason, and flips it live after a dark week.

- **Tier-1 (drought):** a field that is normally always present collapses today.
- **Tier-2 (day-one-dead):** a field that has never carried a value despite many
  runs (the cold-start Scout case, with no healthy baseline to collapse from).

## Metric

Per `(workflow_id, field_path)`, the **daily presence rate** = `present_count /
ran_count` for that day. A rate, not a count. Because it is a rate, there is no
weekday/weekend split (presence is not day-type dependent, unlike volume).

`ran_count` is the denominator (executions where the producing node ran);
`present_count` is the numerator (executions where the field carried a value).
A day with `ran_count = 0` for a field has no row and contributes no rate.

## Components

New `apps/worker/src/lib/field-presence-anomaly.ts`. Pure detection functions
(unit-tested) + two orchestrators (read rollup, group, log).

### Pure functions

```
dailyRate(ran: number, present: number): number          // present/ran; ran must be > 0
mean(xs: number[]): number
stddev(xs: number[]): number                             // population stddev

isStableBaseline(rates: number[]): boolean
  // rates.length >= MIN_BASELINE_DAYS
  //   && mean(rates) >= STABLE_MEAN_MIN
  //   && stddev(rates) <= STABLE_STDDEV_MAX

detectDrought(baselineRates: number[], todayRate: number, todayRan: number):
  { mean: number; stddev: number; todayRate: number } | null
  // null unless: todayRan >= MIN_TODAY_SAMPLE
  //   && isStableBaseline(baselineRates)
  //   && todayRate < mean(baselineRates) - COLLAPSE_K * stddev(baselineRates)

detectDayOneDead(windowRan: number, windowPresent: number, everHealthy: boolean):
  boolean
  // windowRan >= DEAD_MIN_RUNS
  //   && (windowPresent / windowRan) <= DEAD_MAX_RATE
  //   && !everHealthy
```

`everHealthy` = any day in the window whose daily rate ≥ STABLE_MEAN_MIN. Its
absence is what distinguishes "born dead" (Tier-2) from "was healthy, then died"
(which Tier-1 catches as a collapse).

### Thresholds (named constants, provisional — validated in the dark run)

| Constant | Value | Why |
|----------|-------|-----|
| `MIN_BASELINE_DAYS` | 3 (import from volume-anomaly) | enough days to estimate mean/variance |
| `BASELINE_MIN_DAY_RUNS` | 10 | a baseline day needs enough runs for its rate to be meaningful |
| `STABLE_MEAN_MIN` | 0.98 | "essentially always present" |
| `STABLE_STDDEV_MAX` | 0.02 | low variance, so variable (no-bid/no-debt) fields never qualify as stable |
| `COLLAPSE_K` | 4 | conservative; today must fall well below the stable band |
| `MIN_TODAY_SAMPLE` | 20 | single conservative sample floor (per council decision) — never page on a handful of runs |
| `DEAD_WINDOW_DAYS` | 7 | window for the day-one-dead scan |
| `DEAD_MIN_RUNS` | 200 | conservative: many runs, still nothing |
| `DEAD_MAX_RATE` | 0.005 | presence rate ≈ 0 |

The stability gate (`STABLE_*` + `MIN_TODAY_SAMPLE`) is load-bearing: it is what
keeps normal no-bid/no-debt nulls from paging. It stays regardless of tuning.

### Tier-1 orchestrator — `runFieldPresenceDroughtCheck(supabase)`

Hourly. Reads `field_presence_daily` for active workflows over the last
~`MIN_BASELINE_DAYS + 7` days (covers baseline + today), `is_test = false`.
Groups by `(workflow_id, field_path)`. For each:
- baseline = prior days (`day < today`) with `ran_count >= BASELINE_MIN_DAY_RUNS`,
  most recent ~7, as daily rates.
- today = today's row; `todayRan`, `todayRate`.
- `detectDrought(...)`; on a hit, `console.log` a structured `field_presence_drought`
  event (workflow_id, field_path, mean, stddev, todayRate, todayRan). **No send.**

Measures *today's partial* (the rollup refreshes every 5 min) — the point is to
catch a drought fast, and a rate is stable enough intraday for this to be safe
with the sample floor.

### Tier-2 orchestrator — `runFieldPresenceDeadCheck(supabase)`

Daily (in the existing `0 13 * * *` batch). Reads the last `DEAD_WINDOW_DAYS` of
`field_presence_daily` for active workflows, `is_test = false`. Groups by
`(workflow_id, field_path)`, sums `ran_count`/`present_count`, computes
`everHealthy`. For each `detectDayOneDead(...)` hit, collect into one structured
`field_presence_dead_digest` `console.log` per run (the whole list, once). **No
send.**

## Cron wiring

- Tier-1 → the existing hourly `0 * * * *` branch (`index.ts` ~L242). Confirm in
  the plan it does not contend with whatever already runs there (the #422 issue
  flags the Salesforce sync); it is fire-and-forget via `ctx.waitUntil`,
  post-nothing, so contention is CPU/subrequest only.
- Tier-2 → the existing daily `0 13 * * *` batch (`index.ts` ~L182), alongside
  `runVolumeAnomalyCheck`.

## Decisions (recorded)

1. **Log-only; defer Slack send, per-field KV cooldown, AND silence-with-reason
   to Phase 4.** A log-only detector pages no one, so a cooldown only throttles
   log lines and silence suppresses nothing. Phase 3 logs *every* detection,
   which is the cleanest signal for validating false-positive rate during the
   dark run. The #422 issue lists the cooldown key under Phase 3; this doc moves
   it to Phase 4 alongside the actual send it gates, consistent with deferring
   silence (Dan, 2026-06-29).
2. **Run across all active workflows, not just Slack-configured orgs.** Log-only
   wants maximum coverage for dark-run validation. Phase 4 adds the
   Slack-org scoping + send (mirroring `volume-anomaly.ts`).
3. **Presence rate, no day-type split.** Unlike volume counts, a presence rate is
   not weekday/weekend dependent.
4. **Single conservative sample floor** (`MIN_TODAY_SAMPLE`) for all fields, per
   the council decision (no smaller floor for any subset).

## Testing (TDD)

Unlike Phase 2, the detection core is pure TypeScript and fully unit-testable:
- `isStableBaseline`: stable (high mean, low stddev, enough days) → true;
  variable (high stddev) → false; low mean → false; too few days → false.
- `detectDrought`: stable baseline + today collapses + enough today-runs → hit;
  same collapse but `todayRan < MIN_TODAY_SAMPLE` → null; variable baseline (a
  no-bid field that's normally ~40% present and is 0% today) → null (the
  critical false-positive guard); stable baseline but today still in-band → null.
- `detectDayOneDead`: many runs + ~0 presence + never healthy → true; same but
  `everHealthy` → false (Tier-1's job); too few runs → false.
- `dailyRate`/`mean`/`stddev`: basic numeric correctness incl. single-element and
  zero-variance cases.
- Orchestrators: mocked Supabase (mirror the `volume-anomaly` test harness if one
  exists) — a seeded rollup with one drought field and one normal no-bid field
  asserts exactly one `field_presence_drought` log and none for the no-bid field.

## Non-negotiables

- No schema change this phase (reads the Phase 2 table; silence storage is Phase 4).
- Detector reads ONLY `field_presence_daily`, never raw `execution_steps`.
- Log-only: no Slack message, no DB write, no KV write this phase.
- Stability gate stays regardless of threshold tuning (the no-bid false-page guard).
