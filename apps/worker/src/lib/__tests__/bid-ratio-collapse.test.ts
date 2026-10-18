/**
 * #1168: a bidding workflow recording FAR TOO FEW bids, not only none.
 *
 * #1157's detector reports a workflow that records NO bids. One recording far
 * too few is still silent: a workflow that should write about 500 bid rows and
 * writes 16 passes it. That is the more likely shape of the next occurrence:
 * #1157 itself was total only because one recogniser missed one payload shape,
 * and a partial version (one partner of several dropping out of the derivation,
 * or a branch that stops reaching the producer) leaves the workflow looking
 * healthy with most of its bid history intact, while the economics questions go
 * quietly wrong instead of obviously empty.
 *
 * WHY A STORED PER-WORKFLOW BASELINE AND NOT A FLOOR.
 *
 * The ratio of bid rows to sightings is stable within a workflow and wildly
 * different between them: measured 2026-09-04, Engine 56%, LendSwift 80%,
 * GigFi 64%, Main Flow 35%. So one number cannot judge them all, and any
 * absolute floor is either blind for Main Flow or noisy for LendSwift.
 *
 * The baseline cannot be a longer Postgres window either. Bid rows are purged
 * about a day before their sightings, so an older window is systematically short
 * of bids and its ratio is biased LOW. A baseline biased low makes the current
 * ratio look healthy no matter what, which is the worst failure available: a
 * detector that reads as working and can never fire (L98).
 *
 * So each run records the ratio it measured over the window it has already
 * PROVEN retained, and the baseline is the median of those stored readings. The
 * comparison is relative, so nothing here needs an absolute threshold calibrated
 * against data this code cannot see.
 */
import { describe, it, expect } from 'vitest'
import {
  decideRatioCollapse as decide,
  COLLAPSE_FACTOR,
  MIN_BASELINE_SAMPLES,
  MIN_RATIO_SIGHTINGS,
  type RatioHistory,
} from '../bid-ratio-collapse'

const opts = { minSightings: MIN_RATIO_SIGHTINGS }
/** Every case below is judged with the production floor unless it says otherwise. */
const decideRatioCollapse = (rows: Parameters<typeof decide>[0], histories: Parameters<typeof decide>[1]) =>
  decide(rows, histories, opts)

/** A workflow with `n` prior readings all at `ratio`. */
function history(ratio: number, n = MIN_BASELINE_SAMPLES): RatioHistory {
  return { ratios: Array.from({ length: n }, () => ratio) }
}

// Engine writes a `skipped` row for nine leads in ten, so bid_rows is about ten
// times attempt_rows there; the ratio is over attempts (#1413, L683).
const row = (over: Partial<{ workflow_id: string; workflow_name: string; sightings: number; bid_rows: number; attempt_rows: number; refusal_rows: number }> = {}) => ({
  workflow_id: 'wf-1',
  workflow_name: 'Engine Bidding Workflow',
  sightings: 1000,
  bid_rows: 5600,
  attempt_rows: 560,
  refusal_rows: 0,
  ...over,
})

describe('decideRatioCollapse: a workflow judged against its own history', () => {
  it('judges ATTEMPTS per sighting, not rows: Engine\u2019s skipped rows are nine in ten and must not read as bids (#1413, L683)', () => {
    // 5,600 rows, 56 real attempts: the rows alone would read as a healthy 5.6 per lead.
    const out = decideRatioCollapse([row({ bid_rows: 5600, attempt_rows: 56 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0]).toMatchObject({ ratio: 0.056, attempt_rows: 56, expected_rows: 560 })
  })

  it('a workflow with rows but no attempts at all is judged, because the no rows check cannot see it', () => {
    const out = decideRatioCollapse([row({ bid_rows: 5000, attempt_rows: 0 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0].ratio).toBe(0)
  })

  it('says nothing when the ratio matches its baseline', () => {
    const out = decideRatioCollapse([row()], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
  })

  it('flags a ratio that has collapsed well below its own baseline', () => {
    // 500 expected, 16 recorded: the shape the issue names.
    const out = decideRatioCollapse([row({ attempt_rows: 16 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0]).toMatchObject({ workflow_id: 'wf-1', ratio: 0.016, baseline: 0.56 })
  })

  it('judges each workflow against ITS OWN baseline, not a shared one', () => {
    // Main Flow at 35% is healthy; LendSwift at 35% has halved from 80%.
    const rows = [
      row({ workflow_id: 'main', workflow_name: 'Main Flow', sightings: 1000, attempt_rows: 350 }),
      row({ workflow_id: 'lend', workflow_name: 'RML (LendSwift)', sightings: 1000, attempt_rows: 350 }),
    ]
    const out = decideRatioCollapse(rows, { main: history(0.35), lend: history(0.80) })
    expect(out.collapsed.map((c) => c.workflow_id)).toEqual(['lend'])
  })

  it('does not flag an ordinary dip above the collapse factor', () => {
    // Just inside the factor: a normal bad hour must not page.
    const justInside = 0.56 * (COLLAPSE_FACTOR + 0.05)
    const out = decideRatioCollapse([row({ attempt_rows: Math.round(1000 * justInside) })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
  })

  it('uses the median, so one bad reading in the history does not move the bar', () => {
    const ratios = Array.from({ length: MIN_BASELINE_SAMPLES }, () => 0.56)
    ratios[0] = 0.01  // a previous incident, recorded like any other reading
    const out = decideRatioCollapse([row({ attempt_rows: 100 })], { 'wf-1': { ratios } })
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0].baseline).toBeCloseTo(0.56, 6)
  })
})

describe('decideRatioCollapse: what it refuses to judge', () => {
  it('cannot judge a workflow with too little history, and names it', () => {
    // The blind spot is real for a new workflow and must be visible, not implied.
    const out = decideRatioCollapse([row({ attempt_rows: 16 })], { 'wf-1': history(0.56, MIN_BASELINE_SAMPLES - 1) })
    expect(out.collapsed).toEqual([])
    expect(out.unbaselined).toEqual(['Engine Bidding Workflow'])
  })

  it('cannot judge a workflow with no history at all', () => {
    const out = decideRatioCollapse([row({ attempt_rows: 16 })], {})
    expect(out.collapsed).toEqual([])
    expect(out.unbaselined).toEqual(['Engine Bidding Workflow'])
  })

  it('does not judge a window with no sightings, which measures nothing', () => {
    const out = decideRatioCollapse([row({ sightings: 0, bid_rows: 0, attempt_rows: 0 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
    expect(out.unbaselined).toEqual([])
  })

  it('leaves a total silence to the existing check rather than reporting it twice', () => {
    // bid_rows === 0 is #1157's job. Reporting it here too would page twice for
    // one fault and make the two detectors argue about the same workflow.
    const out = decideRatioCollapse([row({ bid_rows: 0, attempt_rows: 0 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
  })

  it('refuses a baseline of zero rather than dividing by it', () => {
    const out = decideRatioCollapse([row({ attempt_rows: 16 })], { 'wf-1': history(0) })
    expect(out.collapsed).toEqual([])
    expect(out.unbaselined).toEqual(['Engine Bidding Workflow'])
  })

  it('ignores a row whose counts are not usable counts', () => {
    const bad = { ...row(), sightings: -1 }
    const out = decideRatioCollapse([bad], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
  })

  it('does not flag a ratio ABOVE its baseline', () => {
    const out = decideRatioCollapse([row({ attempt_rows: 900 })], { 'wf-1': history(0.56) })
    expect(out.collapsed).toEqual([])
  })
})

/**
 * #1929: the check judged RML (GigFi) on its first six leads of the day.
 *
 * GigFi runs 9 AM to 7 PM ET and the check ran at 9:01 AM ET, so its window held
 * four validation rejects (no bid by design), one bid, and one lead still
 * running. 1 in 6 against a stored "normal" of 1.0, itself built from readings
 * of a handful of leads each, paged as a collapse. A ratio over a few leads is
 * not a measurement (L716, L139), so below a floor the workflow is not judged
 * and the reading is not stored.
 */
describe('decideRatioCollapse: the minimum number of leads (#1929)', () => {
  const gigfi = (over: Partial<{ sightings: number; bid_rows: number; attempt_rows: number }>) =>
    row({ workflow_id: 'gigfi', workflow_name: 'RML - Bidding Workflow (GigFi)', ...over })

  it('does not judge the 2026-10-09 case: six leads, one attempt, a stored normal of 100%', () => {
    const out = decideRatioCollapse([gigfi({ sightings: 6, bid_rows: 1, attempt_rows: 1 })], { gigfi: history(1) })
    expect(out.collapsed).toEqual([])
    expect(out.unjudged).toEqual(['RML - Bidding Workflow (GigFi)'])
  })

  it('does not store a reading taken over too few leads, so the baseline is not built from noise', () => {
    const out = decideRatioCollapse([gigfi({ sightings: 6, bid_rows: 1, attempt_rows: 1 })], {})
    expect(out.readings).toEqual([])
    expect(out.unbaselined).toEqual([])
  })

  it('judges a workflow at exactly the floor', () => {
    const n = MIN_RATIO_SIGHTINGS
    const out = decideRatioCollapse([gigfi({ sightings: n, bid_rows: 1, attempt_rows: 1 })], { gigfi: history(0.67) })
    expect(out.unjudged).toEqual([])
    expect(out.collapsed.map((c) => c.workflow_id)).toEqual(['gigfi'])
  })

  it('still catches GigFi on a full day whose rate has halved', () => {
    // A day of GigFi is about 3,000 leads at about 0.67 attempts each.
    const out = decideRatioCollapse([gigfi({ sightings: 3000, bid_rows: 1000, attempt_rows: 1000 })], { gigfi: history(0.67) })
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0]).toMatchObject({ workflow_id: 'gigfi', sightings: 3000, attempt_rows: 1000 })
  })

  it('takes the floor from its caller rather than assuming one', () => {
    const rows = [gigfi({ sightings: 20, bid_rows: 2, attempt_rows: 2 })]
    expect(decide(rows, { gigfi: history(0.67) }, { minSightings: 10 }).collapsed).toHaveLength(1)
    expect(decide(rows, { gigfi: history(0.67) }, { minSightings: 21 }).collapsed).toEqual([])
  })
})

describe('the recorded reading', () => {
  it('returns the ratio each judged workflow measured, so the next run has a baseline', () => {
    const out = decideRatioCollapse([row({ attempt_rows: 560 })], { 'wf-1': history(0.56) })
    expect(out.readings).toEqual([{ workflow_id: 'wf-1', ratio: 0.56 }])
  })

  it('records a reading even for a workflow it could not yet judge', () => {
    // Otherwise a new workflow never accumulates the history it needs and stays
    // unjudgeable forever.
    const out = decideRatioCollapse([row({ attempt_rows: 560 })], {})
    expect(out.readings).toEqual([{ workflow_id: 'wf-1', ratio: 0.56 }])
  })

  it('does not record a reading from a window with no sightings', () => {
    // A ratio over zero leads is not a measurement, and storing it would poison
    // the median with a value no workflow ever had.
    const out = decideRatioCollapse([row({ sightings: 0, bid_rows: 0, attempt_rows: 0 })], {})
    expect(out.readings).toEqual([])
  })

  it('does not record a collapsed reading, so an outage cannot become the new normal', () => {
    // A sustained fault would otherwise walk the median down until the detector
    // accepts the broken rate as healthy.
    const out = decideRatioCollapse([row({ attempt_rows: 16 })], { 'wf-1': history(0.56) })
    expect(out.readings).toEqual([])
  })
})

/**
 * #2391: a deliberate eligibility rule is not a recording fault.
 *
 * Version 110 of the Engine flow (2026-10-15) made tripoint_ping refuse a sell
 * off lead with a loan amount under 2,000. Those leads had been Tripoint
 * attempts, so the attempts per lead fell from about 5.2% to 2.4% and the check
 * paged every day, since a collapsed reading is never stored and the median
 * never moves.
 *
 * Measured over the 2026-10-18 window (13:00 UTC on the 17th to 12:50 UTC on
 * the 18th): 50,284 leads, 1,210 attempts, and 1,283 tripoint_ping refusals for
 * loan_amount_below_min (none for missing_lead_field). Stored readings, oldest
 * first: 5.5, 5.5, 5.0, 5.1, 5.4, 5.4, 3.4, 2.9 percent.
 *
 * Leaving the refusals out of the DENOMINATOR cannot absorb this: they are
 * 2.6% of leads but half of what used to be attempts, so 1,210 over 49,001 is
 * still 2.5%, under the 2.6% half of the baseline. What the refusals replaced
 * was ATTEMPTS, so a lead the workflow recorded a refusal for counts as
 * recorded, beside its attempts. Every reading stored before the rule had no
 * refusals, so the history means the same thing and needs no reset.
 */
describe('decideRatioCollapse: refusals by a buyer\'s own rule (#2391)', () => {
  const OCT_18 = { sightings: 50_284, bid_rows: 28_862, attempt_rows: 1_210, refusal_rows: 1_283 }
  const STORED = { 'wf-1': { ratios: [0.055, 0.055, 0.05, 0.051, 0.054, 0.054, 0.034, 0.029] } }

  it('does not page on the 2026-10-18 reading, and stores it as normal', () => {
    const out = decideRatioCollapse([row(OCT_18)], STORED)
    expect(out.collapsed).toEqual([])
    expect(out.readings).toHaveLength(1)
    expect(out.readings[0].ratio).toBeCloseTo((1_210 + 1_283) / 50_284, 9)
  })

  it('would still page if the refusals were only taken out of the denominator', () => {
    // The arithmetic that rules the denominator out, kept so it is not tried again.
    const denominatorOnly = OCT_18.attempt_rows / (OCT_18.sightings - OCT_18.refusal_rows)
    expect(denominatorOnly).toBeLessThan(median(STORED['wf-1'].ratios) * COLLAPSE_FACTOR)
  })

  it('still pages when the recording itself drops, refusals and attempts alike', () => {
    // The producer dropping out of the derivation loses its refusals too.
    const out = decideRatioCollapse([row({ ...OCT_18, attempt_rows: 300, refusal_rows: 0 })], STORED)
    expect(out.collapsed).toHaveLength(1)
    expect(out.collapsed[0]).toMatchObject({ attempt_rows: 300, refusal_rows: 0 })
    expect(out.readings).toEqual([])
  })

  it('reports the refusals it counted on a collapsed workflow, so the alert can name them', () => {
    const out = decideRatioCollapse([row({ ...OCT_18, attempt_rows: 100, refusal_rows: 200 })], STORED)
    expect(out.collapsed[0]).toMatchObject({ attempt_rows: 100, refusal_rows: 200 })
    expect(out.collapsed[0].ratio).toBeCloseTo(300 / 50_284, 9)
  })

  it('ignores a row with no usable refusal count rather than judging it as zero', () => {
    const bad = { ...row(OCT_18), refusal_rows: undefined as unknown as number }
    expect(decideRatioCollapse([bad], STORED)).toMatchObject({ collapsed: [], readings: [] })
  })
})

/**
 * Keeping the history: the baseline is only as good as what accumulates.
 */
import { appendReading, median, MAX_BASELINE_SAMPLES } from '../bid-ratio-collapse'

describe('appendReading', () => {
  it('starts a history from nothing', () => {
    expect(appendReading(undefined, 0.56)).toEqual({ ratios: [0.56] })
  })

  it('keeps the most recent readings and drops the oldest', () => {
    const full = { ratios: Array.from({ length: MAX_BASELINE_SAMPLES }, (_, i) => i / 100) }
    const next = appendReading(full, 0.99)
    expect(next.ratios).toHaveLength(MAX_BASELINE_SAMPLES)
    expect(next.ratios.at(-1)).toBe(0.99)
    expect(next.ratios[0]).toBe(0.01)  // the original 0.00 fell off
  })

  it('lets a genuine change in how a workflow bids become the new baseline', () => {
    // A workflow legitimately moving from 56% to 80% must stop being flagged once
    // the window has turned over, or the detector defends a rate that is gone.
    let h = { ratios: Array.from({ length: MAX_BASELINE_SAMPLES }, () => 0.56) }
    for (let i = 0; i < MAX_BASELINE_SAMPLES; i++) h = appendReading(h, 0.80)
    expect(median(h.ratios)).toBeCloseTo(0.80, 6)
  })
})
