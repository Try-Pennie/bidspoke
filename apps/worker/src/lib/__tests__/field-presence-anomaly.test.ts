import { describe, it, expect } from 'vitest'
import type { PresenceRow } from '../field-presence-anomaly'
import {
  dailyRate, mean, stddev, isStableBaseline, detectDrought, detectDayOneDead,
  findDroughts, findDayOneDead, excludeSilenced, MIN_TODAY_SAMPLE, DEAD_MIN_RUNS,
  runFieldPresenceDroughtCheck, runFieldPresenceDeadCheck,
} from '../field-presence-anomaly'

const DMR = DEAD_MIN_RUNS

describe('numeric helpers', () => {
  it('dailyRate is present/ran', () => {
    expect(dailyRate(100, 99)).toBeCloseTo(0.99)
  })
  it('mean of one element', () => {
    expect(mean([0.99])).toBeCloseTo(0.99)
  })
  it('stddev is zero for constant input', () => {
    expect(stddev([0.99, 0.99, 0.99])).toBeCloseTo(0)
  })
  it('stddev is population stddev', () => {
    expect(stddev([0, 1])).toBeCloseTo(0.5)
  })
})

describe('isStableBaseline', () => {
  it('true for high-mean low-variance with enough days', () => {
    expect(isStableBaseline([0.99, 1, 0.99, 1])).toBe(true)
  })
  it('false when too few days', () => {
    expect(isStableBaseline([1, 1])).toBe(false)
  })
  it('false when mean is below the stable floor', () => {
    expect(isStableBaseline([0.5, 0.5, 0.5, 0.5])).toBe(false)
  })
  it('false when variance is high (a variable no-bid field)', () => {
    expect(isStableBaseline([1, 0.2, 0.9, 0.3])).toBe(false)
  })
})

describe('detectDrought', () => {
  const STABLE = [1, 0.99, 1, 0.99, 1]
  it('fires when a stable field collapses today with enough runs', () => {
    const r = detectDrought(STABLE, 0.0, 100)
    expect(r).not.toBeNull()
    expect(r!.todayRate).toBe(0)
  })
  it('does NOT fire when today has too few runs', () => {
    expect(detectDrought(STABLE, 0.0, MIN_TODAY_SAMPLE - 1)).toBeNull()
  })
  it('does NOT fire for a variable (no-bid) baseline even at 0% today', () => {
    expect(detectDrought([1, 0.2, 0.9, 0.3], 0.0, 100)).toBeNull()
  })
  it('does NOT fire when today is still within the stable band', () => {
    expect(detectDrought(STABLE, 0.99, 100)).toBeNull()
  })
  it('does NOT over-fire on a zero-variance baseline for a small dip (collapse floor)', () => {
    expect(detectDrought([1, 1, 1, 1, 1], 0.95, 100)).toBeNull()
  })
  it('fires on a zero-variance baseline for a real collapse below the floor', () => {
    expect(detectDrought([1, 1, 1, 1, 1], 0.5, 100)).not.toBeNull()
  })
})

describe('detectDayOneDead', () => {
  it('fires for many runs, ~0 presence, never healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, false)).toBe(true)
  })
  it('does NOT fire if the field was ever healthy', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS, 0, true)).toBe(false)
  })
  it('does NOT fire with too few runs', () => {
    expect(detectDayOneDead(DEAD_MIN_RUNS - 1, 0, false)).toBe(false)
  })
})

function row(wf: string, field: string, day: string, ran: number, present: number): PresenceRow {
  return { workflow_id: wf, field_path: field, day, ran_count: ran, present_count: present }
}

const DAYS = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27']
const TODAY = '2026-06-29'

describe('findDroughts', () => {
  it('flags a stable field that collapses today, and ignores a normal no-bid field', () => {
    const rows: PresenceRow[] = []
    for (const d of DAYS) {
      rows.push(row('wf1', 'scout.final', d, 100, 100))   // stable, always present
      rows.push(row('wf1', 'bid.amount', d, 100, 40))     // no-bid: ~40%, low rate -> not stable
    }
    rows.push(row('wf1', 'scout.final', TODAY, 80, 0))    // collapsed today, enough runs
    rows.push(row('wf1', 'bid.amount', TODAY, 80, 0))     // 0% today but never stable
    const hits = findDroughts(rows, TODAY)
    expect(hits.map((h) => h.field_path)).toEqual(['scout.final'])
  })

  it('does not flag when today has too few runs', () => {
    const rows: PresenceRow[] = DAYS.map((d) => row('wf1', 'scout.final', d, 100, 100))
    rows.push(row('wf1', 'scout.final', TODAY, 5, 0))   // below MIN_TODAY_SAMPLE
    expect(findDroughts(rows, TODAY)).toEqual([])
  })
  it('skips a field that has baseline rows but no row for today', () => {
    const rows = DAYS.map((d) => row('wf1', 'scout.final', d, 100, 100))
    // no TODAY row for scout.final
    expect(findDroughts(rows, TODAY)).toEqual([])
  })
})

describe('findDayOneDead', () => {
  it('flags a field with many runs and zero presence, never healthy', () => {
    const rows = [row('wf2', 'eligibility.final', '2026-06-28', DMR, 0)]
    const hits = findDayOneDead(rows)
    expect(hits.map((h) => h.field_path)).toEqual(['eligibility.final'])
  })

  it('does not flag a field that was healthy on some day', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-27', 100, 100),  // healthy day
      row('wf2', 'eligibility.final', '2026-06-28', DMR, 0),
    ]
    expect(findDayOneDead(rows)).toEqual([])
  })
  it('does not mark everHealthy on a high-rate day with too few runs', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-26', 5, 5),      // 100% rate but only 5 runs (< floor) -> must NOT set everHealthy
      row('wf2', 'eligibility.final', '2026-06-28', 20000, 0),  // large dead day keeps window rate <= DEAD_MAX_RATE
    ]
    expect(findDayOneDead(rows).map((h) => h.field_path)).toEqual(['eligibility.final'])
  })
  it('does not flag day-one-dead just below the run floor', () => {
    expect(findDayOneDead([row('wf2', 'eligibility.final', '2026-06-28', DMR - 1, 0)])).toEqual([])
  })
})

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

// Threshold injection (#432). The dark-run validation has to ask "what would a
// different mean floor have paged over the same 24 real days", and the only
// honest way to answer is to drive the SHIPPED predicate with a different
// number rather than reimplement it beside the tool (L107). So every threshold
// the detector consults is injectable, defaulting to the shipped constant.
describe('threshold overrides', () => {
  // A field present ~85% of the time: outside the calibrated 0.90 floor, so
  // each case contrasts a real decline with a real admission.
  const EIGHTY_FIVE = [0.85, 0.855, 0.848, 0.852]

  it('isStableBaseline admits an 85% field when the mean floor is lowered', () => {
    expect(isStableBaseline(EIGHTY_FIVE)).toBe(false)
    expect(isStableBaseline(EIGHTY_FIVE, { stableMeanMin: 0.8 })).toBe(true)
  })

  it('isStableBaseline still rejects a variable field under a lowered mean floor', () => {
    // Lowering the mean floor must not admit a genuinely variable field: the
    // stddev gate is what excludes those, and it is unchanged.
    expect(isStableBaseline([1, 0.2, 0.9, 0.3], { stableMeanMin: 0.5 })).toBe(false)
  })

  it('detectDrought fires on a lowered mean floor where the default declined', () => {
    expect(detectDrought(EIGHTY_FIVE, 0.1, 500)).toBeNull()
    expect(detectDrought(EIGHTY_FIVE, 0.1, 500, { stableMeanMin: 0.8 })).not.toBeNull()
  })

  it('detectDayOneDead accepts a rare-but-real field only when the ceiling is loosened', () => {
    // 68 present in 25831 runs is 0.26%: over the calibrated 0.1% ceiling, under
    // the 0.5% one that shipped before #432. This is the real Main Flow
    // eligibility field, and the pair documents which call it was.
    expect(detectDayOneDead(25831, 68, false)).toBe(false)
    expect(detectDayOneDead(25831, 68, false, { deadMaxRate: 0.005 })).toBe(true)
  })

  it('detectDayOneDead still fires on a never-present field at the default', () => {
    expect(detectDayOneDead(25831, 0, false)).toBe(true)
  })

  it('findDroughts passes thresholds through to the per-field predicate', () => {
    const rows: PresenceRow[] = [
      { workflow_id: 'w', field_path: 'f', day: '2026-01-01', ran_count: 100, present_count: 85 },
      { workflow_id: 'w', field_path: 'f', day: '2026-01-02', ran_count: 100, present_count: 85 },
      { workflow_id: 'w', field_path: 'f', day: '2026-01-03', ran_count: 100, present_count: 86 },
      { workflow_id: 'w', field_path: 'f', day: '2026-01-04', ran_count: 100, present_count: 0 },
    ]
    expect(findDroughts(rows, '2026-01-04')).toHaveLength(0)
    expect(findDroughts(rows, '2026-01-04', { stableMeanMin: 0.8 })).toHaveLength(1)
  })

  it('findDayOneDead passes thresholds through to the per-field predicate', () => {
    const rows: PresenceRow[] = [
      { workflow_id: 'w', field_path: 'f', day: '2026-01-01', ran_count: DMR, present_count: 0 },
    ]
    expect(findDayOneDead(rows)).toHaveLength(1)
    expect(findDayOneDead(rows, { deadMinRuns: DMR + 1 })).toHaveLength(0)
  })
})

// Calibration against the dark run (#432). Every number below is a real
// measurement from `field_presence_daily` over 2026-08-09..2026-09-01 (24 days,
// 144 (workflow, field) pairs, 40.7M ran-events), reproducible with
// `npx tsx scripts/diagnose-field-presence.ts`. These tests exist so a future
// edit that moves a threshold back has to argue with the measurement rather
// than only with a comment.
describe('calibration against the measured dark run', () => {
  it('covers the Scout field the milestone exists for', () => {
    // Main Flow `pennie_or_eligibility.final`: 94.4% mean, 0.011 stddev over 24
    // days. The shipped 0.98 mean floor excluded it, so a TOTAL Scout collapse
    // could not have paged; that is the failure this whole milestone was built
    // after. The stddev gate is what excludes genuinely variable fields, and it
    // is unchanged.
    const scoutBaseline = [0.944, 0.938, 0.951, 0.942, 0.947, 0.939, 0.945]
    expect(isStableBaseline(scoutBaseline)).toBe(true)
    expect(detectDrought(scoutBaseline, 0.0, 5000)).not.toBeNull()
  })

  it('still refuses a genuinely variable field at the calibrated floor', () => {
    // A no-bid style field. Its stddev is what disqualifies it, not its mean,
    // so lowering the mean floor must not let it through.
    expect(isStableBaseline([1, 0.2, 0.9, 0.3, 0.75])).toBe(false)
  })

  it('does not fire on the measured near-miss fields at their real baselines', () => {
    // These are stable-but-imperfect real fields now inside the gate. At their
    // own steady rates they must stay quiet; only a collapse pages.
    const cases: number[][] = [
      [0.978, 0.974, 0.981, 0.977, 0.979], // GigFi create_applicant.body.id
      [0.953, 0.947, 0.958, 0.951, 0.955], // LendSwift create_applicant.body.id
      [0.929, 0.931, 0.927, 0.930, 0.928], // Engine generate_trades_body.prospectId
    ]
    for (const baseline of cases) {
      expect(isStableBaseline(baseline)).toBe(true)
      expect(detectDrought(baseline, mean(baseline), 5000)).toBeNull()
    }
  })

  it('flags every measured never-resolving reference', () => {
    // The four references that resolved on 0 of their runs over the 7-day
    // window: Main Flow equifax_credit_report.data.links (0/25831, #709),
    // Main Flow mutate_bes.value (0/25831), Engine create_prospect.id
    // (0/498167) and Engine equifax_credit_report.data (0/324356).
    for (const ran of [25831, 25831, 498167, 324356]) {
      expect(detectDayOneDead(ran, 0, false)).toBe(true)
    }
  })

  it('does not flag the measured rare-but-real fields', () => {
    // The dead ceiling sits in the empty band the measurement found between
    // 0% and 0.26%. These three fields are legitimately rare, not dead, and the
    // shipped 0.5% ceiling called all three dead.
    expect(detectDayOneDead(25831, 68, false)).toBe(false) // 0.263%, eligibility
    expect(detectDayOneDead(24312, 165, false)).toBe(false) // 0.679%, besOverwrite
    expect(detectDayOneDead(9454, 546, false)).toBe(false) // 5.78%, eligibilityPull
  })

  it('still flags a chronically dead field that succeeds a handful of times', () => {
    // Not knife-edged at exactly zero: a field alive on 0.04% of a large sample
    // is dead in every sense that matters and must still be caught.
    expect(detectDayOneDead(498167, 200, false)).toBe(true)
  })
})

// The rollup read is the detector's only input, so what it does when that read
// FAILS decides whether the detector can lie. Before #432 it paged with a bare
// `.range()` and swallowed an error by breaking out of the loop with whatever it
// had, which meant a failed or torn read reported "no fields are dead" in
// exactly the same words as a healthy sweep (L98, L211, L215).
describe('runFieldPresence*Check on a failing rollup read', () => {
  /** Chainable Supabase double; awaiting a chain resolves that table's result. */
  function makeSupabase(tables: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
    return {
      from: (table: string) => {
        const result = tables[table] ?? { data: [], error: null }
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
            }
            return () => chain
          },
        })
        return chain
      },
    }
  }

  const activeWorkflows = { data: [{ id: 'wf-1' }], error: null }

  it('drought check rejects rather than reporting an all-clear', async () => {
    const supabase = makeSupabase({
      workflows: activeWorkflows,
      field_presence_daily: { data: null, error: { message: 'statement timeout' } },
    })
    await expect(runFieldPresenceDroughtCheck(supabase as never)).rejects.toThrow(/field_presence_daily/)
  })

  it('dead check rejects rather than reporting an empty digest', async () => {
    const supabase = makeSupabase({
      workflows: activeWorkflows,
      field_presence_daily: { data: null, error: { message: 'statement timeout' } },
    })
    await expect(runFieldPresenceDeadCheck(supabase as never)).rejects.toThrow(/field_presence_daily/)
  })

  it('the same doubles succeed when the read works, so the rejection is the error and not the harness', async () => {
    // Positive control: a rejection test passes just as well when the code under
    // test cannot run at all, so prove this fixture reaches a clean finish (L140).
    const supabase = makeSupabase({
      workflows: activeWorkflows,
      field_presence_daily: { data: [], error: null },
      field_presence_silences: { data: [], error: null },
    })
    await expect(runFieldPresenceDroughtCheck(supabase as never)).resolves.toBeUndefined()
    await expect(runFieldPresenceDeadCheck(supabase as never)).resolves.toBeUndefined()
  })
})

// A count that fails to parse must not reach a comparison (L50). Every
// threshold here is a `>=` or a rate, and NaN compares false against all of
// them, so an unparseable ran_count would drop the field out of its own
// baseline silently and land on the do-not-page side. The row is refused
// instead, for the same reason a failed read is: a detector judging "this field
// is dead" from counts it could not read is worse than one that says nothing.
describe('rollup rows with an unparseable count', () => {
  function makeSupabase(rows: unknown[]) {
    return {
      from: (table: string) => {
        const data = table === 'field_presence_daily' ? rows : []
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              return (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: table === 'workflows' ? [{ id: 'wf-1' }] : data, error: null }).then(res)
            }
            return () => chain
          },
        })
        return chain
      },
    }
  }

  it('refuses a row whose ran_count is not a number', async () => {
    const supabase = makeSupabase([
      { workflow_id: 'wf-1', field_path: 'f', day: '2026-01-01', ran_count: 'not-a-number', present_count: 0 },
    ])
    await expect(runFieldPresenceDeadCheck(supabase as never)).rejects.toThrow(/ran_count/)
  })

  it('refuses a row whose present_count is null', async () => {
    const supabase = makeSupabase([
      { workflow_id: 'wf-1', field_path: 'f', day: '2026-01-01', ran_count: 10, present_count: null },
    ])
    await expect(runFieldPresenceDeadCheck(supabase as never)).rejects.toThrow(/present_count/)
  })

  it('accepts the string form Postgres returns for a bigint', async () => {
    // Positive control: PostgREST renders bigint as a string, so a parse guard
    // that refused strings would refuse every real row and the two tests above
    // would pass for the wrong reason (L140).
    const supabase = makeSupabase([
      { workflow_id: 'wf-1', field_path: 'f', day: '2026-01-01', ran_count: '10', present_count: '3' },
    ])
    await expect(runFieldPresenceDeadCheck(supabase as never)).resolves.toBeUndefined()
  })
})
