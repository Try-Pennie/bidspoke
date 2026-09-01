import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({
  getSlackConnection: vi.fn(),
  postMessage: vi.fn(),
  sendRecoveryAlert: vi.fn(),
}))
import { getSlackConnection, postMessage, sendRecoveryAlert } from '../slack'
import type { PresenceRow } from '../field-presence-anomaly'
import {
  dailyRate, mean, stddev, isStableBaseline, detectDrought, detectDayOneDead,
  findDroughts, findDayOneDead, excludeSilenced, MIN_TODAY_SAMPLE, DEAD_MIN_RUNS, DEAD_MIN_DAYS,
  runFieldPresenceDroughtCheck, runFieldPresenceDeadCheck,
  classifyDrought, classifyDead,
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

// The dead check needs DEAD_MIN_DAYS distinct days of history before it will
// judge a field at all, so a fixture about the RUN floor or the RATE has to
// spread its runs over enough days or it silently becomes a test of the day
// floor instead. Splits `ran`/`present` evenly across DEAD_MIN_DAYS days.
function deadDays(wf: string, field: string, ran: number, present: number): PresenceRow[] {
  const days = ['2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27', '2026-06-28']
  const used = days.slice(0, DEAD_MIN_DAYS)
  return used.map((d, i) =>
    row(
      wf,
      field,
      d,
      Math.floor(ran / used.length) + (i === 0 ? ran % used.length : 0),
      Math.floor(present / used.length) + (i === 0 ? present % used.length : 0),
    ),
  )
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
    const rows = deadDays('wf2', 'eligibility.final', DMR, 0)
    const hits = findDayOneDead(rows)
    expect(hits.map((h) => h.field_path)).toEqual(['eligibility.final'])
  })

  it('does not flag a field that was healthy on some day', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-20', 100, 100),  // healthy day
      ...deadDays('wf2', 'eligibility.final', DMR, 0),
    ]
    expect(findDayOneDead(rows)).toEqual([])
  })
  it('does not mark everHealthy on a high-rate day with too few runs', () => {
    const rows = [
      row('wf2', 'eligibility.final', '2026-06-20', 5, 5),      // 100% rate but only 5 runs (< floor) -> must NOT set everHealthy
      ...deadDays('wf2', 'eligibility.final', 60000, 0),        // large dead days keep window rate <= DEAD_MAX_RATE
    ]
    expect(findDayOneDead(rows).map((h) => h.field_path)).toEqual(['eligibility.final'])
  })
  it('does not flag day-one-dead just below the run floor', () => {
    expect(findDayOneDead(deadDays('wf2', 'eligibility.final', DMR - 1, 0))).toEqual([])
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
      ...deadDays('w', 'f', DMR, 0),
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
/** In-memory KV standing in for the alert cooldown and recovery markers. */
function makeKv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v) },
    delete: async (k: string) => { m.delete(k) },
  }
}

const APP_URL = 'https://app.example.com'

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
    await expect(runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)).rejects.toThrow(/field_presence_daily/)
  })

  it('dead check rejects rather than reporting an empty digest', async () => {
    const supabase = makeSupabase({
      workflows: activeWorkflows,
      field_presence_daily: { data: null, error: { message: 'statement timeout' } },
    })
    await expect(runFieldPresenceDeadCheck(supabase as never, makeKv(), APP_URL)).rejects.toThrow(/field_presence_daily/)
  })

  it('the same doubles succeed when the read works, so the rejection is the error and not the harness', async () => {
    // Positive control: a rejection test passes just as well when the code under
    // test cannot run at all, so prove this fixture reaches a clean finish (L140).
    const supabase = makeSupabase({
      workflows: activeWorkflows,
      field_presence_daily: { data: [], error: null },
      field_presence_silences: { data: [], error: null },
    })
    await expect(runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)).resolves.toBeUndefined()
    await expect(runFieldPresenceDeadCheck(supabase as never, makeKv(), APP_URL)).resolves.toBeUndefined()
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
    await expect(runFieldPresenceDeadCheck(supabase as never, makeKv(), APP_URL)).rejects.toThrow(/ran_count/)
  })

  it('refuses a row whose present_count is null', async () => {
    const supabase = makeSupabase([
      { workflow_id: 'wf-1', field_path: 'f', day: '2026-01-01', ran_count: 10, present_count: null },
    ])
    await expect(runFieldPresenceDeadCheck(supabase as never, makeKv(), APP_URL)).rejects.toThrow(/present_count/)
  })

  it('accepts the string form Postgres returns for a bigint', async () => {
    // Positive control: PostgREST renders bigint as a string, so a parse guard
    // that refused strings would refuse every real row and the two tests above
    // would pass for the wrong reason (L140).
    const supabase = makeSupabase([
      { workflow_id: 'wf-1', field_path: 'f', day: '2026-01-01', ran_count: '10', present_count: '3' },
    ])
    await expect(runFieldPresenceDeadCheck(supabase as never, makeKv(), APP_URL)).resolves.toBeUndefined()
  })
})

// Phase 4 (#423): the three-way verdict a live alert needs.
//
// A live alert cannot read "no drought hit" as "healthy". Tier-1 judges TODAY's
// cumulative rate, and today resets at UTC midnight, so at 00:30 a field that is
// still completely dead has too few runs to judge and produces no hit. Treating
// that as healthy would fire an all-clear over an ongoing outage every single
// night, which is worse than never announcing recovery at all (L98, L11).
describe('classifyDrought', () => {
  const DAYS5 = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27']
  const T = '2026-06-29'
  const verdictFor = (rows: PresenceRow[], field: string, today = T) =>
    classifyDrought(rows, today).find((s) => s.field_path === field)?.verdict

  function stable(field: string, todayRan: number, todayPresent: number): PresenceRow[] {
    return [
      ...DAYS5.map((d) => row('wf1', field, d, 100, 100)),
      row('wf1', field, todayRan === 0 ? T : T, todayRan, todayPresent),
    ]
  }

  it('calls a collapsed stable field a drought', () => {
    expect(verdictFor(stable('scout.final', 500, 0), 'scout.final')).toBe('alerting')
  })

  it('calls a stable field at its normal rate healthy', () => {
    expect(verdictFor(stable('scout.final', 500, 500), 'scout.final')).toBe('healthy')
  })

  it('calls a still-dead field insufficient just after UTC midnight, NOT healthy', () => {
    // The whole point: 3 runs so far today, all empty. There is no evidence of
    // recovery here, and calling it healthy would announce an all-clear.
    expect(verdictFor(stable('scout.final', 3, 0), 'scout.final')).toBe('insufficient')
  })

  it('calls a field with no row for today insufficient', () => {
    const rows = DAYS5.map((d) => row('wf1', 'scout.final', d, 100, 100))
    expect(verdictFor(rows, 'scout.final')).toBe('insufficient')
  })

  it('calls a variable no-bid field insufficient even at 0% today', () => {
    // It can never page, so it must never announce a recovery either.
    const rows = [
      ...DAYS5.map((d) => row('wf1', 'bid.amount', d, 100, 40)),
      row('wf1', 'bid.amount', T, 500, 0),
    ]
    expect(verdictFor(rows, 'bid.amount')).toBe('insufficient')
  })
})

describe('classifyDead', () => {
  const verdictFor = (rows: PresenceRow[], field: string) =>
    classifyDead(rows).find((s) => s.field_path === field)?.verdict

  it('calls a never-resolving field with enough runs dead', () => {
    expect(verdictFor(deadDays('wf1', 'f', 25000, 0), 'f')).toBe('alerting')
  })

  it('calls a field under the run floor insufficient, not healthy', () => {
    expect(verdictFor(deadDays('wf1', 'f', DMR - 1, 0), 'f')).toBe('insufficient')
  })

  it('calls a field that started resolving healthy', () => {
    expect(verdictFor(deadDays('wf1', 'f', 25000, 24000), 'f')).toBe('healthy')
  })
})

// Phase 4 (#423): the alerting itself. Everything below drives the real runner
// against doubles, because the rules that matter here (dedupe, cooldown only on
// delivery, the org gate, silence, and never announcing a recovery this run
// could not establish) live in the runner and not in the pure predicates.
describe('field-presence alerting', () => {
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C-default', volume_alerts_enabled: true }
  const WF = {
    id: 'wf-1',
    name: 'Main Flow',
    organization_id: 'org-1',
    slack_channel: null,
  }

  /** Rows for one field: five perfect baseline days, then a collapsed today. */
  function collapsedToday(field: string, todayRan: number, todayPresent: number, today: string): unknown[] {
    const days = ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27']
    return [
      ...days.map((d) => ({ workflow_id: 'wf-1', field_path: field, day: d, ran_count: 100, present_count: 100 })),
      { workflow_id: 'wf-1', field_path: field, day: today, ran_count: todayRan, present_count: todayPresent },
    ]
  }

  function makeSupabase(rollup: unknown[], silences: unknown[] = [], workflows: unknown[] = [WF]) {
    return {
      from: (table: string) => {
        const data =
          table === 'workflows' ? workflows
            : table === 'field_presence_daily' ? rollup
              : table === 'field_presence_silences' ? silences
                : []
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res)
            return () => chain
          },
        })
        return chain
      },
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(postMessage).mockResolvedValue('ts-1')
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
  })

  it('pages once for a collapsed field and names the field and both rates', async () => {
    const supabase = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const text = JSON.stringify(vi.mocked(postMessage).mock.calls[0])
    expect(text).toContain('scout.final')
    expect(text).toContain('Main Flow')
    expect(text).toContain('100.0%')
    expect(text).toContain('0.0%')
  })

  it('does not page twice for the same field while the cooldown holds', async () => {
    const kv = makeKv()
    const supabase = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(supabase as never, kv, APP_URL)
    await runFieldPresenceDroughtCheck(supabase as never, kv, APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('does NOT start the cooldown when the send failed, so the next run retries', async () => {
    // A kicked bot must not buy 12 hours of silence over a field that is still
    // empty. postMessage returns null when Slack did not accept the message.
    const kv = makeKv()
    vi.mocked(postMessage).mockResolvedValueOnce(null)
    const supabase = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(supabase as never, kv, APP_URL)
    await runFieldPresenceDroughtCheck(supabase as never, kv, APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('says nothing when the org has volume alerts switched off', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue({ ...CONN, volume_alerts_enabled: false } as never)
    const supabase = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('says nothing about a silenced field', async () => {
    const supabase = makeSupabase(
      collapsedToday('scout.final', 500, 0, today),
      [{ workflow_id: 'wf-1', field_path: 'scout.final' }],
    )
    await runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('honours a per-workflow channel override', async () => {
    const supabase = makeSupabase(collapsedToday('scout.final', 500, 0, today), [], [
      { ...WF, slack_channel: 'C-override' },
    ])
    await runFieldPresenceDroughtCheck(supabase as never, makeKv(), APP_URL)
    expect(vi.mocked(postMessage).mock.calls[0][1]).toBe('C-override')
  })

  it('announces the all-clear once the field is measured healthy again', async () => {
    const kv = makeKv()
    const broken = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(broken as never, kv, APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(1)

    // Move the incident's running end far enough back that the re-arm window
    // has elapsed, rather than waiting out real time.
    kv.store.set('field-presence-drought-active:wf-1 scout.final', new Date(Date.now() - 3600_000).toISOString())
    const fixed = makeSupabase(collapsedToday('scout.final', 500, 500, today))
    await runFieldPresenceDroughtCheck(fixed as never, kv, APP_URL)
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({
      subject: 'Main Flow scout.final',
    })
  })

  it('does NOT announce an all-clear just after UTC midnight while the field is still dead', async () => {
    // The trap this whole three-way verdict exists for. Today has 3 runs, all
    // empty: no hit, because there is not enough of today to judge. Reading that
    // as healthy would send an all-clear over an outage that is still running,
    // every night, for as long as the field stays broken.
    const kv = makeKv()
    const broken = makeSupabase(collapsedToday('scout.final', 500, 0, today))
    await runFieldPresenceDroughtCheck(broken as never, kv, APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(1)

    kv.store.set('field-presence-drought-active:wf-1 scout.final', new Date(Date.now() - 3600_000).toISOString())
    const freshDay = makeSupabase(collapsedToday('scout.final', 3, 0, today))
    await runFieldPresenceDroughtCheck(freshDay as never, kv, APP_URL)
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    // And the incident is still open, so a real recovery can still be announced.
    expect(kv.store.has('field-presence-drought-recovery:wf-1 scout.final')).toBe(true)
  })

  it('pages for a never-resolving field on the dead check, with its own wording', async () => {
    const rows = deadDays('wf-1', 'equifax.links', 25000, 0)
    await runFieldPresenceDeadCheck(makeSupabase(rows) as never, makeKv(), APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const text = JSON.stringify(vi.mocked(postMessage).mock.calls[0])
    expect(text).toContain('equifax.links')
    expect(text).toContain('never resolved')
  })

  it('keeps the two tiers on separate incident markers', async () => {
    // Both tiers can be alerting on the same field at once. If they shared a
    // cooldown or recovery key, one tier's page would silence the other's and
    // one tier's all-clear would close the other's incident (L53).
    const kv = makeKv()
    const field = 'equifax.links'
    const deadRows = deadDays('wf-1', field, 25000, 0)
    await runFieldPresenceDeadCheck(makeSupabase(deadRows) as never, kv, APP_URL)
    await runFieldPresenceDroughtCheck(makeSupabase(collapsedToday(field, 500, 0, today)) as never, kv, APP_URL)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(kv.store.has(`field-presence-dead-cooldown:wf-1 ${field}`)).toBe(true)
    expect(kv.store.has(`field-presence-drought-cooldown:wf-1 ${field}`)).toBe(true)
  })
})

// A newly watched field has no history, and "never resolved over 7 days" is not
// established by 7 hours of data (#435). #435 added 108 fields to the watched
// set at once by resolving aliases; on a high-volume workflow each of them
// clears the 200-run floor within hours, so without a span floor every one of
// them would have been judged on its first partial day and any that looked
// empty would have paged on day one. The same applies whenever an author edits
// a workflow to read a field it did not read before.
describe('dead check requires enough days, not just enough runs', () => {
  it('does not call a field dead on a single day of history', () => {
    const rows = [row('wf1', 'f', '2026-06-28', 25000, 0)]
    expect(findDayOneDead(rows)).toEqual([])
    expect(classifyDead(rows)[0].verdict).toBe('insufficient')
  })

  it('calls it dead once the window spans enough days', () => {
    const rows = [
      row('wf1', 'f', '2026-06-26', 9000, 0),
      row('wf1', 'f', '2026-06-27', 9000, 0),
      row('wf1', 'f', '2026-06-28', 9000, 0),
    ]
    expect(findDayOneDead(rows).map((h) => h.field_path)).toEqual(['f'])
  })

  it('counts distinct days, not rows', () => {
    // Two rows for one day is one day of evidence.
    const rows = [
      row('wf1', 'f', '2026-06-27', 9000, 0),
      row('wf1', 'f', '2026-06-27', 9000, 0),
      row('wf1', 'f', '2026-06-28', 9000, 0),
    ]
    expect(findDayOneDead(rows)).toEqual([])
  })
})
