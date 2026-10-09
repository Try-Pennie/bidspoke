/**
 * A bidding workflow recording FAR TOO FEW bids, not only none (#1168).
 *
 * `bid-recording-coverage.ts` (#1157) reports a workflow that records NO bids.
 * One recording far too few is still silent: a workflow that should write about
 * 500 bid rows and writes 16 passes it. That is the likelier shape of the next
 * occurrence. #1157 was total only because one recogniser missed one payload
 * shape; a partial version, one partner of several dropping out of the
 * derivation or a branch that stops reaching the producer, leaves the workflow
 * looking healthy with most of its bid history intact while every economics
 * question over it goes quietly wrong.
 *
 * WHY A STORED PER-WORKFLOW BASELINE RATHER THAN A THRESHOLD.
 *
 * The ratio of bid rows to sightings is stable within a workflow and wildly
 * different between them. Measured 2026-09-04: Engine 56%, LendSwift 80%,
 * GigFi 64%, Main Flow 35%. One number cannot judge them all, and any absolute
 * floor is either blind for Main Flow or noisy for LendSwift.
 *
 * The baseline also cannot come from a longer Postgres window. Bid rows are
 * purged about a day before their sightings are, so an older window is
 * systematically short of bids and its ratio is biased LOW. A baseline biased
 * low makes every current ratio look healthy, which is the worst failure
 * available: a detector that reads as working and can never fire (L98).
 *
 * So each run records the ratio it measured over the window the caller has
 * already PROVEN retained (the peer check in bid-recording-coverage), and the
 * baseline is the median of those stored readings. The comparison is relative,
 * so no absolute threshold has to be calibrated against data this code cannot
 * see.
 *
 * IT IS INERT UNTIL IT HAS HISTORY, DELIBERATELY. A workflow with fewer than
 * MIN_BASELINE_SAMPLES readings cannot be judged and is named in `unbaselined`
 * rather than passing silently, so the blind spot is visible while it fills.
 */

/**
 * How far below its own baseline a workflow's ratio must fall to count as a
 * collapse.
 *
 * Half. A ratio is a stable quantity within a workflow, so halving is well
 * outside ordinary variation, and the fault this exists to catch (a producer
 * dropping out of the derivation) removes a whole partner's or branch's worth of
 * rows rather than shaving a few percent.
 *
 * This is the one number here that is chosen rather than measured, because the
 * distribution of a workflow's own ratio over time does not exist yet: the
 * readings this module stores are what will produce it. Once several weeks have
 * accumulated, re-derive it from the stored histories rather than trusting this
 * comment (L172), the same way the field-presence floors were re-derived.
 */
export const COLLAPSE_FACTOR = 0.5

/**
 * Readings required before a workflow can be judged at all.
 *
 * Seven, so a weekly cycle is represented and one unusual day cannot set the
 * bar. Below this the workflow is reported as unbaselined rather than passed.
 */
export const MIN_BASELINE_SAMPLES = 7

/**
 * Leads a workflow must have in the window before its ratio is judged or stored
 * (#1929).
 *
 * Fifty, the same floor the total silence check beside this one applies. A ratio
 * over a handful of leads is not a measurement (L716, L139): on 2026-10-09 RML
 * (GigFi) was judged on its first six leads of the day, four of them validation
 * rejects that never bid by design, and paged at 17% against a stored normal of
 * 100% that was itself the median of first-minute readings like 1, 0.5 and 0.67.
 * At fifty the sampling noise on a rate near 0.6 is about 0.07, well inside the
 * halving this detector looks for.
 *
 * Below the floor nothing is judged AND nothing is stored, or the baseline is
 * built from the same noise. The workflow is named in `unjudged` so the gap is
 * visible rather than implied.
 */
export const MIN_RATIO_SIGHTINGS = 50

/** Readings kept per workflow. Older ones fall off, so the baseline tracks a
 *  genuine change in how a workflow bids rather than defending its first week. */
export const MAX_BASELINE_SAMPLES = 30

export interface RatioHistory {
  ratios: number[]
}

export interface RatioRow {
  workflow_id: string
  workflow_name: string
  sightings: number
  /** Every bid row, `skipped` rows included; only its zero matters here (#1157 owns that case). */
  bid_rows: number
  /** Bid rows whose skip_reason is distinct from `skipped`: the real attempts (#1413, L683). */
  attempt_rows: number
}

export interface CollapsedWorkflow {
  workflow_id: string
  workflow_name: string
  ratio: number
  baseline: number
  sightings: number
  bid_rows: number
  attempt_rows: number
  /** Attempts this workflow would have recorded at its usual rate. */
  expected_rows: number
}

export interface RatioDecision {
  collapsed: CollapsedWorkflow[]
  /** Below the lead floor, so neither judged nor recorded (#1929). Named, not implied. */
  unjudged: string[]
  /** Judged nothing because there is not enough history yet. Named, not implied. */
  unbaselined: string[]
  /** The ratio each workflow measured this run, for the next run's baseline. */
  readings: Array<{ workflow_id: string; ratio: number }>
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0
}

/** Median of a non-empty list. Robust to a previous incident sitting in the history. */
export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function decideRatioCollapse(
  rows: RatioRow[],
  histories: Record<string, RatioHistory>,
  opts: { minSightings: number },
): RatioDecision {
  const collapsed: CollapsedWorkflow[] = []
  const unjudged: string[] = []
  const unbaselined: string[] = []
  const readings: Array<{ workflow_id: string; ratio: number }> = []

  for (const r of rows) {
    if (!isCount(r.sightings) || !isCount(r.bid_rows) || !isCount(r.attempt_rows)) continue
    // A ratio over zero leads is not a measurement. Storing it would poison the
    // median with a value the workflow never had.
    if (r.sightings === 0) continue

    // A workflow recording NOTHING AT ALL is #1157's finding, and it says so far
    // better than this would. Reporting it here as well would page twice for one
    // fault. Rows with no attempts among them are NOT that case: #1157 sees rows
    // and stays quiet, so this is the only check that can see it.
    if (r.bid_rows === 0) continue

    if (r.sightings < opts.minSightings) {
      unjudged.push(r.workflow_name)
      continue
    }

    // Attempts per sighting, not rows (#1413, L683): Engine writes a `skipped`
    // row for nine leads in ten, rows that appear whether or not anything was
    // attempted, and Stage C of the buyer_select cutover removes them.
    const ratio = r.attempt_rows / r.sightings
    const history = histories[r.workflow_id]?.ratios ?? []

    if (history.length < MIN_BASELINE_SAMPLES) {
      unbaselined.push(r.workflow_name)
      // Still recorded, or a new workflow never accumulates the history it needs
      // and stays unjudgeable for ever.
      readings.push({ workflow_id: r.workflow_id, ratio })
      continue
    }

    const baseline = median(history)
    // A baseline of zero cannot be divided into, and a workflow whose usual rate
    // is zero is not one this detector has anything to say about.
    if (baseline <= 0) {
      unbaselined.push(r.workflow_name)
      readings.push({ workflow_id: r.workflow_id, ratio })
      continue
    }

    if (ratio < baseline * COLLAPSE_FACTOR) {
      collapsed.push({
        workflow_id: r.workflow_id,
        workflow_name: r.workflow_name,
        ratio,
        baseline,
        sightings: r.sightings,
        bid_rows: r.bid_rows,
        attempt_rows: r.attempt_rows,
        expected_rows: Math.round(baseline * r.sightings),
      })
      // Deliberately NOT recorded: a sustained fault would otherwise walk the
      // median down until the detector accepts the broken rate as normal, and
      // the alarm would switch itself off precisely while the fault persisted.
      continue
    }

    readings.push({ workflow_id: r.workflow_id, ratio })
  }

  return { collapsed, unjudged, unbaselined, readings }
}

/** Append a reading, keeping the most recent MAX_BASELINE_SAMPLES. */
export function appendReading(history: RatioHistory | undefined, ratio: number): RatioHistory {
  const ratios = [...(history?.ratios ?? []), ratio]
  return { ratios: ratios.slice(-MAX_BASELINE_SAMPLES) }
}
