/**
 * The per reason rejection rate watch for a lead validation swap (#2592, part
 * of #934). After RML GigFi's validate_bidding_and_state script is replaced by
 * the lead validation node, this compares each rejection reason's share of the
 * last two hours with its share over the week before, and pages when one moves.
 *
 * These tests hold the rule to the spread it was set from (every two hour
 * window of GigFi's real traffic, 2026-10-14 13:00 to 2026-10-21 21:00 UTC),
 * show it pages on the defects a broken swap would cause, and drive the check
 * through a page, a held repeat, an all-clear and the hours it must not judge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../slack', () => ({
  sendLeadValidationRejectionAlert: vi.fn().mockResolvedValue(true),
  getSlackConnection: vi.fn(),
  sendRecoveryAlert: vi.fn(),
}))
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import {
  BASELINE_DAYS,
  BASELINE_DAY_ENDS_UTC_HOUR,
  LEAD_VALIDATION_REJECTION_JOB,
  LEAD_VALIDATION_REJECTION_SIGNAL,
  REJECTION_RULE,
  REJECTION_WATCHES,
  SETTLE_MS,
  WINDOW_MINUTES,
  baselineDays,
  judgeRejectionShares,
  leadValidationRejectionEnding,
  readBaselineCounts,
  readRejectionCounts,
  rejectionBuckets,
  runLeadValidationRejectionWatch,
  type RejectionCounts,
} from '../lead-validation-rejection-watch'
import { getSlackConnection, sendLeadValidationRejectionAlert, sendRecoveryAlert } from '../slack'
import { CRON_JOBS } from '../cron-heartbeat'
import { incidentSignal } from '../incident-signals'
import { outboxEvents, transitions } from './_incident-events'

const GIGFI = '6624acd0-bf61-4d21-85fc-4371ca7ed77d'
const LENDSWIFT = 'e1b810da-16c0-49eb-bf12-ba1c9b67c914'
const LEAD_ECONOMY = '89b1a6af-7e0f-43de-bc66-1e888184551f'
const STEP = 'validate_bidding_and_state'

/** Counts with every reason at zero unless given. */
function counts(runs: number, byReason: Record<string, number> = {}, extra: { failed?: number; otherReason?: number } = {}): RejectionCounts {
  const full: Record<string, number> = Object.fromEntries(LEAD_REJECTION_REASONS.map((r) => [r, byReason[r] ?? 0]))
  const listed = Object.values(full).reduce((a, b) => a + b, 0)
  const failed = extra.failed ?? 0
  return { runs, atStep: listed + failed + (extra.otherReason ?? 0), failed, byReason: full }
}

/** The week the rule was set from: 2026-10-14 13:00 to 2026-10-21 21:00 UTC, 20,835 runs. */
const WEEK = counts(20_835, { 'ineligible state': 2_384, 'loan amount exceeds maximum': 3_318, 'invalid name': 2 })

describe('judgeRejectionShares(): the rule, against the spread it was set from', () => {
  it('stays quiet on the most extreme two hour windows of the measured week', () => {
    // Measured on workflow_executions: ineligible state 8.1% to 14.4% of a two
    // hour window, loan amount exceeds maximum 11.8% to 26.0%, all rejections
    // 21.5% to 39.7%, in windows of 416 to 983 runs.
    expect(judgeRejectionShares(counts(500, { 'ineligible state': 41, 'loan amount exceeds maximum': 70 }), WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(983, { 'ineligible state': 142, 'loan amount exceeds maximum': 256 }), WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(416, { 'ineligible state': 60, 'loan amount exceeds maximum': 49 }), WEEK).state).toBe('normal')
    // Two stray rejections of a reason the week barely saw.
    expect(judgeRejectionShares(counts(600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95, 'invalid name': 2 }), WEEK).state).toBe('normal')
  })

  it('pages a common reason that falls to half its share: a check that lets everything through', () => {
    const v = judgeRejectionShares(counts(600, { 'ineligible state': 0, 'loan amount exceeds maximum': 95 }), WEEK)
    expect(v.state).toBe('shifted')
    if (v.state !== 'shifted') return
    expect(v.shifts).toContainEqual(expect.objectContaining({ bucket: 'ineligible state', direction: 'fell', count: 0, baselineCount: 2_384 }))
  })

  it('pages a common reason that doubles its share: a check that rejects too much', () => {
    const v = judgeRejectionShares(counts(600, { 'ineligible state': 70, 'loan amount exceeds maximum': 300 }), WEEK)
    expect(v.state).toBe('shifted')
    if (v.state !== 'shifted') return
    expect(v.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['loan amount exceeds maximum rose', 'all rejections rose'])
  })

  it('pages a reason the week never saw once it reaches the rare floor in count and share', () => {
    expect(REJECTION_RULE.rareMinCount).toBe(10)
    expect(REJECTION_RULE.rareMinPoints).toBe(0.03)
    // A strict self employed check rejects nearly every lead as unqualified.
    const strict = judgeRejectionShares(counts(600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95, unqualified: 400 }), WEEK)
    expect(strict.state).toBe('shifted')
    // 9 is under the count floor; 12 of 1,000 is under the 3 point floor.
    expect(judgeRejectionShares(counts(300, { 'ineligible state': 35, 'loan amount exceeds maximum': 48, unqualified: 9 }), WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(1_000, { 'ineligible state': 115, 'loan amount exceeds maximum': 160, unqualified: 12 }), WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(300, { 'ineligible state': 35, 'loan amount exceeds maximum': 48, unqualified: 10 }), WEEK).state).toBe('shifted')
  })

  it('counts a failed step and a reason outside the list as buckets of their own', () => {
    const failing = judgeRejectionShares(counts(600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 }, { failed: 40 }), WEEK)
    expect(failing.state === 'shifted' && failing.shifts.map((s) => s.bucket)).toEqual(['the step failed'])
    const renamed = judgeRejectionShares(counts(600, { 'ineligible state': 0, 'loan amount exceeds maximum': 95 }, { otherReason: 70 }), WEEK)
    expect(renamed.state === 'shifted' && renamed.shifts.map((s) => s.bucket)).toEqual(['ineligible state', 'a reason not on the list'])
  })

  it('does not judge a window under the run floor, or against a baseline under its own', () => {
    expect(REJECTION_RULE.minRuns).toBe(300)
    expect(judgeRejectionShares(counts(299, { unqualified: 299 }), WEEK)).toEqual({ state: 'unjudged', runs: 299 })
    expect(REJECTION_RULE.baselineMinRuns).toBe(3_000)
    const thin = judgeRejectionShares(counts(600), counts(2_999, { 'ineligible state': 300 }))
    expect(thin.state).toBe('unmeasured')
    // A baselineSince can make the baseline shorter than a week, so the reason names it as the baseline.
    expect(thin.state === 'unmeasured' && thin.reason).toBe('the baseline holds 2999 runs, under the 3000 it needs')
  })

  it('refuses counts that cannot add up rather than reading them as a shift', () => {
    expect(() => judgeRejectionShares({ runs: 10, atStep: 20, failed: 0, byReason: {} }, WEEK)).toThrow(/do not add up/)
    expect(() => rejectionBuckets({ runs: 100, atStep: 5, failed: 0, byReason: { unqualified: 6 } })).toThrow(/do not add up/)
  })
})

/**
 * RML LendSwift (#2593): every two hour window of its real traffic, 2026-10-14
 * 02:00 to 2026-10-22 02:00 UTC (113,644 runs, 191 windows of 347 to 2,698).
 * It gets leads around the clock, and no state rejection reaches the step (an
 * earlier filter keeps them out).
 */
const LENDSWIFT_WEEK = counts(113_644, { 'loan amount exceeds maximum': 13_950, 'military status ineligible': 718, 'invalid name': 8 })

describe('judgeRejectionShares(): RML LendSwift, against the spread it was measured on', () => {
  it('stays quiet on the most extreme two hour windows of the measured week', () => {
    // loan amount exceeds maximum ran 6.9% to 19.1% of a window against 12.3%
    // for the week (0.56 to 1.55 times): the lowest is a night window.
    expect(judgeRejectionShares(counts(466, { 'loan amount exceeds maximum': 32, 'military status ineligible': 4 }), LENDSWIFT_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(2_337, { 'loan amount exceeds maximum': 446, 'military status ineligible': 11 }), LENDSWIFT_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(683, { 'loan amount exceeds maximum': 47, 'military status ineligible': 4 }), LENDSWIFT_WEEK).state).toBe('normal')
    // military status ineligible, under the 2% common share, peaked at 18 (1.4%
    // against 0.63%), and invalid name at 6: both under the rare floor.
    expect(judgeRejectionShares(counts(1_305, { 'loan amount exceeds maximum': 138, 'military status ineligible': 18 }), LENDSWIFT_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(1_694, { 'loan amount exceeds maximum': 229, 'military status ineligible': 13, 'invalid name': 6 }), LENDSWIFT_WEEK).state).toBe('normal')
  })

  it('pages a loan amount check that stops rejecting, and a state check that rejects every lead', () => {
    const lenient = judgeRejectionShares(counts(900, { 'loan amount exceeds maximum': 0, 'military status ineligible': 6 }), LENDSWIFT_WEEK)
    expect(lenient.state === 'shifted' && lenient.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['loan amount exceeds maximum fell', 'all rejections fell'])
    const strict = judgeRejectionShares(counts(900, { 'ineligible state': 790, 'loan amount exceeds maximum': 100, 'military status ineligible': 6 }), LENDSWIFT_WEEK)
    expect(strict.state === 'shifted' && strict.shifts.map((s) => s.bucket)).toContain('ineligible state')
  })
})

/**
 * Lead Economy (#2594), measured only from 2026-10-19 15:00 UTC: version 39 was
 * saved at 14:53 that day and began rejecting a loan under $2,000 as
 * unqualified_lead, which moved that reason from about none of the runs to about
 * 30%. Its runs from then to 2026-10-22 02:00 UTC: 7,884, in 20 judged windows of
 * 329 to 723 runs.
 */
const LEAD_ECONOMY_WEEK = counts(7_884, { 'ineligible state': 249, unqualified_lead: 2_335 })

describe('judgeRejectionShares(): Lead Economy, against the spread it was measured on', () => {
  it('stays quiet on the most extreme two hour windows since version 39', () => {
    // ineligible state 2.0% to 4.5% against 3.2% (0.63 to 1.43 times),
    // unqualified_lead 24.6% to 36.4% against 29.6% (0.83 to 1.23 times).
    expect(judgeRejectionShares(counts(451, { 'ineligible state': 9, unqualified_lead: 130 }), LEAD_ECONOMY_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(575, { 'ineligible state': 26, unqualified_lead: 143 }), LEAD_ECONOMY_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(329, { 'ineligible state': 14, unqualified_lead: 81 }), LEAD_ECONOMY_WEEK).state).toBe('normal')
    expect(judgeRejectionShares(counts(434, { 'ineligible state': 11, unqualified_lead: 158 }), LEAD_ECONOMY_WEEK).state).toBe('normal')
  })

  it('pages a qualified check that lets every lead through, or rejects nearly every one', () => {
    const lenient = judgeRejectionShares(counts(500, { 'ineligible state': 16, unqualified_lead: 0 }), LEAD_ECONOMY_WEEK)
    expect(lenient.state === 'shifted' && lenient.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['unqualified_lead fell', 'all rejections fell'])
    const strict = judgeRejectionShares(counts(500, { 'ineligible state': 16, unqualified_lead: 470 }), LEAD_ECONOMY_WEEK)
    expect(strict.state === 'shifted' && strict.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['unqualified_lead rose', 'all rejections rose'])
  })

  it('would page on every busy window against a week that runs back past version 39, which is why its baseline starts there', () => {
    // The 7 days before 2026-10-21 13:00 UTC as the watch would read them with no
    // start: roughly 2,346 unqualified_lead in 23,000 runs, most of the runs from
    // before the $2,000 minimum. Measured: 24 windows since version 39 paged so.
    const mixed = counts(23_000, { 'ineligible state': 760, unqualified_lead: 2_346 })
    expect(judgeRejectionShares(counts(521, { 'ineligible state': 11, unqualified_lead: 171 }), mixed).state).toBe('shifted')
    expect(judgeRejectionShares(counts(521, { 'ineligible state': 11, unqualified_lead: 171 }), LEAD_ECONOMY_WEEK).state).toBe('normal')
  })
})

/**
 * Lead Economy's week to 2026-10-27 15:00 UTC (#2851), every run counted through
 * lead_validation_rejection_counts: 15,464 runs before the window paged that
 * morning, ineligible state 2.9% of them. Its leads from 8 to 11 AM Eastern are
 * rejected for state less often (1.8%, 45 of 2,462 that week), and a two hour
 * window holds 300 to 500 runs, so half the week's share is a drop of about 11
 * leads to 5. The ratio alone was crossed by four morning windows that week;
 * replayed with the chance floor, none of the 35 judged windows paged.
 */
const LEAD_ECONOMY_OCT_27 = counts(15_464, { 'ineligible state': 442, unqualified_lead: 4_778 })

describe('judgeRejectionShares(): a shift must also be beyond chance at the window\'s count (#2851)', () => {
  it('holds the chance floor at one in a thousand', () => {
    expect(REJECTION_RULE.maxChance).toBe(0.001)
  })

  it('stays quiet on the morning windows the ratio alone paged on', () => {
    // 2026-10-27 12:58 to 14:58 UTC, the page that raised #2851: a 1 in 29 chance.
    expect(judgeRejectionShares(counts(387, { 'ineligible state': 5, unqualified_lead: 120 }), LEAD_ECONOMY_OCT_27).state).toBe('normal')
    // The other three that week (13:00 to 15:00 UTC on Oct 23 and 26, 14:00 to 16:00 on Oct 23).
    expect(judgeRejectionShares(counts(371, { 'ineligible state': 5, unqualified_lead: 115 }), LEAD_ECONOMY_OCT_27).state).toBe('normal')
    expect(judgeRejectionShares(counts(503, { 'ineligible state': 5, unqualified_lead: 156 }), LEAD_ECONOMY_OCT_27).state).toBe('normal')
    expect(judgeRejectionShares(counts(308, { 'ineligible state': 4, unqualified_lead: 95 }), LEAD_ECONOMY_OCT_27).state).toBe('normal')
  })

  it('still pages a state check that stops rejecting, even in the thinnest window it judges', () => {
    // None of 308 at 2.9% is a 1 in 7,500 chance.
    const v = judgeRejectionShares(counts(308, { 'ineligible state': 0, unqualified_lead: 95 }), LEAD_ECONOMY_OCT_27)
    expect(v.state === 'shifted' && v.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['ineligible state fell'])
  })

  it('pages the same share once enough leads stand behind it', () => {
    // 1.3% of 387 is chance; 1.3% of 3,000 is not.
    const v = judgeRejectionShares(counts(3_000, { 'ineligible state': 40, unqualified_lead: 930 }), LEAD_ECONOMY_OCT_27)
    expect(v.state === 'shifted' && v.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['ineligible state fell'])
  })

  it('pages a doubled state share in a busy window, and holds it in a thin one until it is beyond chance', () => {
    // 29 of 503 against 2.9% is a 1 in 2,700 chance; 18 of 308 is 1 in 270, so
    // a doubling that holds is paged by the next, busier window.
    const busy = judgeRejectionShares(counts(503, { 'ineligible state': 29, unqualified_lead: 156 }), LEAD_ECONOMY_OCT_27)
    expect(busy.state === 'shifted' && busy.shifts.map((s) => `${s.bucket} ${s.direction}`)).toEqual(['ineligible state rose'])
    expect(judgeRejectionShares(counts(308, { 'ineligible state': 18, unqualified_lead: 95 }), LEAD_ECONOMY_OCT_27).state).toBe('normal')
  })
})

describe('the watch, its signal and its heartbeat', () => {
  it('watches the validation step of GigFi, LendSwift and Lead Economy for every reason on the shared list', () => {
    expect(REJECTION_WATCHES).toEqual([
      { workflowId: GIGFI, namespace: STEP, reasons: LEAD_REJECTION_REASONS },
      { workflowId: LENDSWIFT, namespace: STEP, reasons: LEAD_REJECTION_REASONS },
      { workflowId: LEAD_ECONOMY, namespace: STEP, reasons: LEAD_REJECTION_REASONS, baselineSince: '2026-10-19T14:53:40.535Z' },
    ])
  })

  it('is a registered signal keyed on the workflow, with the window it judges', () => {
    expect(incidentSignal(LEAD_VALIDATION_REJECTION_SIGNAL)).toMatchObject({ scope: 'org', subject: 'workflow', windowMinutes: WINDOW_MINUTES })
  })

  it('is a watched hourly job, so a dark check pages as itself', () => {
    const job = CRON_JOBS.find((j) => j.id === LEAD_VALIDATION_REJECTION_JOB)
    expect(job?.triggerCron).toBe('0 * * * *')
  })
})

// ── The reads ───────────────────────────────────────────────────────────────

interface ExecRow { workflow_id: string; started_at: string; is_test: boolean; status: string; final_node_namespace: string | null; reason: string | null }

interface CountArgs { p_workflow_id: string; p_namespace: string; p_from: string; p_to: string }

/**
 * A Supabase double. lead_validation_rejection_counts is computed from the rows
 * the way the SQL function computes it (supabase/tests/lead_validation_rejection_counts.test.sql
 * proves the function against a real database); every other table answers `other`.
 */
function makeSupabase(rows: ExecRow[], other: Record<string, unknown[]> = {}, opts: { fail?: (a: CountArgs) => boolean } = {}) {
  const counted: CountArgs[] = []
  return {
    counted,
    rpc(name: string, a: CountArgs) {
      if (name !== 'lead_validation_rejection_counts') return Promise.resolve({ data: null, error: { message: `no function ${name}` } })
      counted.push(a)
      if (opts.fail?.(a)) return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } })
      const live = rows.filter((r) => r.workflow_id === a.p_workflow_id && !r.is_test && r.status !== 'running' && r.started_at >= a.p_from && r.started_at < a.p_to)
      const atStep = live.filter((r) => r.final_node_namespace === a.p_namespace)
      const byReason: Record<string, number> = {}
      for (const r of atStep) if (r.status !== 'failed' && r.reason !== null) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
      return Promise.resolve({ data: [{ runs: live.length, at_step: atStep.length, failed: atStep.filter((r) => r.status === 'failed').length, by_reason: byReason }], error: null })
    },
    from(table: string) {
      // Any builder method this double does not model (the Slack list read's) passes through.
      const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
        get(_t, prop) {
          if (prop === 'then') return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: other[table] ?? [], error: null }).then(res, rej)
          return () => chain
        },
      })
      return chain
    },
  }
}

function makeKv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    store: m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _o?: { expirationTtl?: number }) => { m.set(k, v) }),
    delete: vi.fn(async (k: string) => { m.delete(k) }),
  }
}

describe('readRejectionCounts(): one pass over workflow_executions', () => {
  const at = '2026-10-21T15:00:00.000Z'
  const base = { workflow_id: GIGFI, started_at: at, is_test: false, status: 'completed' }
  const rows: ExecRow[] = [
    { ...base, final_node_namespace: 'return_response', reason: null },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state' },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state' },
    { ...base, final_node_namespace: STEP, reason: 'renamed reason' },
    { ...base, final_node_namespace: STEP, reason: null, status: 'failed' },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state', is_test: true },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state', status: 'running' },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state', workflow_id: 'another' },
    { ...base, final_node_namespace: STEP, reason: 'ineligible state', started_at: '2026-10-21T17:00:00.000Z' },
  ]

  it('counts finished live runs in the window, by where they ended and why, in one read', async () => {
    const supabase = makeSupabase(rows)
    const c = await readRejectionCounts(supabase as never, REJECTION_WATCHES[0], new Date('2026-10-21T14:00:00Z'), new Date('2026-10-21T16:00:00Z'))
    expect(c.runs).toBe(5)
    expect(c.atStep).toBe(4)
    expect(c.failed).toBe(1)
    expect(c.byReason['ineligible state']).toBe(2)
    // Only the listed reasons are named; a reason off the list is what remains.
    expect(Object.keys(c.byReason).sort()).toEqual([...LEAD_REJECTION_REASONS].sort())
    expect(rejectionBuckets(c).find((b) => b.bucket === 'a reason not on the list')?.count).toBe(1)
    expect(supabase.counted).toEqual([{ p_workflow_id: GIGFI, p_namespace: STEP, p_from: '2026-10-21T14:00:00.000Z', p_to: '2026-10-21T16:00:00.000Z' }])
  })

  it('throws when the count cannot be read, so the run fails rather than reading as quiet', async () => {
    const supabase = makeSupabase(rows, {}, { fail: () => true })
    await expect(readRejectionCounts(supabase as never, REJECTION_WATCHES[0], new Date('2026-10-21T14:00:00Z'), new Date('2026-10-21T16:00:00Z'))).rejects.toThrow(/statement timeout/)
  })

  it('throws on an answer that is not one row of whole counts, rather than judging a misread', async () => {
    const bad = (data: unknown) => ({ rpc: () => Promise.resolve({ data, error: null }) })
    const from = new Date('2026-10-21T14:00:00Z')
    const to = new Date('2026-10-21T16:00:00Z')
    await expect(readRejectionCounts(bad([]) as never, REJECTION_WATCHES[0], from, to)).rejects.toThrow(/not one row of counts/)
    await expect(readRejectionCounts(bad([{ runs: '5', at_step: 1, failed: 0, by_reason: {} }]) as never, REJECTION_WATCHES[0], from, to)).rejects.toThrow(/not one row of counts/)
    await expect(readRejectionCounts(bad([{ runs: 5, at_step: 1, failed: 0, by_reason: { x: -1 } }]) as never, REJECTION_WATCHES[0], from, to)).rejects.toThrow(/not one row of counts/)
  })
})

describe('baselineDays(): the baseline is seven whole days, so it is counted a day at a time', () => {
  it('ends at the last 08:00 UTC at or before the window starts, in seven day long pieces', () => {
    expect(BASELINE_DAY_ENDS_UTC_HOUR).toBe(8)
    const days = baselineDays(new Date('2026-10-22T12:58:00Z'))
    expect(days).toHaveLength(BASELINE_DAYS)
    expect(days[0]).toEqual({ from: new Date('2026-10-15T08:00:00Z'), to: new Date('2026-10-16T08:00:00Z') })
    expect(days[6]).toEqual({ from: new Date('2026-10-21T08:00:00Z'), to: new Date('2026-10-22T08:00:00Z') })
    // Before 08:00 the day before's boundary still stands, and exactly at it the new one does.
    expect(baselineDays(new Date('2026-10-22T07:59:59Z'))[6].to).toEqual(new Date('2026-10-21T08:00:00Z'))
    expect(baselineDays(new Date('2026-10-22T08:00:00Z'))[6].to).toEqual(new Date('2026-10-22T08:00:00Z'))
  })

  it('starts no earlier than a baselineSince, dropping the days before it and cutting the day it falls in', () => {
    const days = baselineDays(new Date('2026-10-22T12:58:00Z'), Date.parse('2026-10-19T14:53:40.535Z'))
    expect(days.map((d) => d.from.toISOString())).toEqual(['2026-10-19T14:53:40.535Z', '2026-10-20T08:00:00.000Z', '2026-10-21T08:00:00.000Z'])
    // A since after the boundary leaves no baseline at all, which judges as unmeasured.
    expect(baselineDays(new Date('2026-10-22T12:58:00Z'), Date.parse('2026-10-22T09:00:00Z'))).toEqual([])
  })
})

describe('readBaselineCounts(): each whole day is counted once and kept', () => {
  const watch = REJECTION_WATCHES[1]
  const rowsOn = (day: string, n: number, reason: string): ExecRow[] =>
    Array.from({ length: n }, () => ({ workflow_id: LENDSWIFT, started_at: `${day}T12:00:00.000Z`, is_test: false, status: 'completed', final_node_namespace: STEP, reason }))
  const rows = [...rowsOn('2026-10-16', 3, 'loan amount exceeds maximum'), ...rowsOn('2026-10-21', 2, 'military status ineligible'), ...rowsOn('2026-10-21', 1, 'renamed reason')]
  const days = baselineDays(new Date('2026-10-22T12:58:00Z'))

  it('sums the days, and reads each from the database only until it is kept', async () => {
    const supabase = makeSupabase(rows)
    const kv = makeKv()
    const first = await readBaselineCounts(supabase as never, kv as never, watch, days)
    expect(first).toMatchObject({ runs: 6, atStep: 6, failed: 0 })
    expect(first.byReason['loan amount exceeds maximum']).toBe(3)
    expect(first.byReason['military status ineligible']).toBe(2)
    expect(supabase.counted).toHaveLength(BASELINE_DAYS)
    // Kept for longer than the baseline reaches back, so a day is never counted twice.
    expect(kv.put.mock.calls.every((c) => (c[2]?.expirationTtl ?? 0) > BASELINE_DAYS * 86_400)).toBe(true)

    const again = await readBaselineCounts(supabase as never, kv as never, watch, days)
    expect(again).toEqual(first)
    expect(supabase.counted).toHaveLength(BASELINE_DAYS)
  })

  it('counts a day again when what was kept for it is not a whole set of counts', async () => {
    const supabase = makeSupabase(rows)
    const kv = makeKv()
    await readBaselineCounts(supabase as never, kv as never, watch, days)
    const key = [...kv.store.keys()].find((k) => k.endsWith(':2026-10-21T08:00:00.000Z:2026-10-22T08:00:00.000Z'))
    expect(key).toBeDefined()
    kv.store.set(key as string, '{"runs":"lots"}')
    const c = await readBaselineCounts(supabase as never, kv as never, watch, days)
    expect(c.runs).toBe(6)
    expect(supabase.counted).toHaveLength(BASELINE_DAYS + 1)
  })

  it('still counts when the store cannot be read or written, saying so in the log', async () => {
    const supabase = makeSupabase(rows)
    const kv = makeKv()
    kv.get.mockRejectedValue(new Error('kv down'))
    kv.put.mockRejectedValue(new Error('kv down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = await readBaselineCounts(supabase as never, kv as never, watch, days)
    expect(c.runs).toBe(6)
    expect(err.mock.calls.some((args) => String(args[0]).includes('kv down'))).toBe(true)
    err.mockRestore()
  })

  it('throws when a day cannot be counted, and keeps nothing for it', async () => {
    const supabase = makeSupabase(rows, {}, { fail: (a) => a.p_from === '2026-10-18T08:00:00.000Z' })
    const kv = makeKv()
    await expect(readBaselineCounts(supabase as never, kv as never, watch, days)).rejects.toThrow(/statement timeout/)
    expect([...kv.store.keys()].some((k) => k.endsWith(':2026-10-18T08:00:00.000Z:2026-10-19T08:00:00.000Z'))).toBe(false)
    // The days before it were counted and kept.
    expect([...kv.store.keys()].some((k) => k.endsWith(':2026-10-17T08:00:00.000Z:2026-10-18T08:00:00.000Z'))).toBe(true)
  })
})

// ── The check ───────────────────────────────────────────────────────────────

describe('runLeadValidationRejectionWatch', () => {
  const ORG = '25922592-2592-4592-8592-259225922592'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }
  const URL = 'https://app.example.com'
  const wf = { id: GIGFI, name: 'RML - Bidding Workflow (GigFi)', organization_id: ORG, slack_channel: null }
  const NOW = Date.parse('2026-10-21T18:00:00.000Z')

  /** `n` finished runs at `at`, `rejected` of them at the step with `reason`. */
  function runs(at: string, n: number, byReason: Record<string, number>): ExecRow[] {
    const out: ExecRow[] = []
    for (const [reason, k] of Object.entries(byReason)) for (let i = 0; i < k; i++) out.push({ workflow_id: GIGFI, started_at: at, is_test: false, status: 'completed', final_node_namespace: STEP, reason })
    while (out.length < n) out.push({ workflow_id: GIGFI, started_at: at, is_test: false, status: 'completed', final_node_namespace: 'return_response', reason: null })
    return out
  }

  const windowAt = new Date(NOW - SETTLE_MS - 30 * 60_000).toISOString()
  const weekAt = new Date(NOW - 3 * 24 * 3_600_000).toISOString()
  const week = runs(weekAt, 20_000, { 'ineligible state': 2_300, 'loan amount exceeds maximum': 3_200 })
  const db = (window: ExecRow[]) => makeSupabase([...week, ...window], { service_connections: [{ organization_id: ORG }], workflows: [wf] })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    vi.mocked(sendLeadValidationRejectionAlert).mockResolvedValue(true)
  })

  it('judges the two hours that ended SETTLE_MS ago against the seven whole days before them', async () => {
    const supabase = db(runs(windowAt, 600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 }))
    const out = await runLeadValidationRejectionWatch(supabase as never, makeKv() as never, URL, NOW)
    expect(BASELINE_DAYS).toBe(7)
    expect(out.judged).toEqual([{ workflowId: GIGFI, state: 'normal', runs: 600, baselineRuns: 20_000 }])
    expect(sendLeadValidationRejectionAlert).not.toHaveBeenCalled()
  })

  it('pages once for a shift, opening the incident, and holds the repeat behind the cooldown', async () => {
    const kv = makeKv()
    const supabase = db(runs(windowAt, 600, { 'loan amount exceeds maximum': 95 }))
    const first = await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW)
    expect(first.paged).toEqual([GIGFI])
    expect(sendLeadValidationRejectionAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendLeadValidationRejectionAlert).mock.calls[0][2]).toMatchObject({
      workflow_id: GIGFI, workflow_name: wf.name, runs: 600, baseline_runs: 20_000, window_minutes: WINDOW_MINUTES,
      shifts: [expect.objectContaining({ bucket: 'ineligible state', direction: 'fell', count: 0 })],
    })
    expect(transitions(kv.store)).toEqual([`opened ${GIGFI}`, `paged ${GIGFI}`])

    const second = await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW + 3_600_000)
    expect(second.paged).toEqual([])
    expect(sendLeadValidationRejectionAlert).toHaveBeenCalledTimes(1)
  })

  it('records a page Slack refused as not delivered, keeping the incident that was due, and tries again next hour (#3056)', async () => {
    vi.mocked(sendLeadValidationRejectionAlert).mockResolvedValue(false)
    const kv = makeKv()
    const supabase = db(runs(windowAt, 600, { 'loan amount exceeds maximum': 95 }))
    const first = await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW)
    expect(first.paged).toEqual([])
    expect(first.undelivered).toEqual([GIGFI])
    expect(transitions(kv.store)).toEqual([`undelivered ${GIGFI}`])
    expect(outboxEvents(kv.store)[0]).toMatchObject({ unannounced: true, startedAt: new Date(NOW).toISOString() })
    // No marker: nobody was told, so no all-clear is owed and no page reads as a repeat.
    expect(kv.store.has(`${LEAD_VALIDATION_REJECTION_SIGNAL}-recovery:${GIGFI}`)).toBe(false)
    expect(kv.store.has(`${LEAD_VALIDATION_REJECTION_SIGNAL}-cooldown:${GIGFI}`)).toBe(false)
    expect(leadValidationRejectionEnding(first)).toMatchObject({ outcome: 'page_not_delivered', summary: { paged: [], undelivered: [GIGFI] } })

    // The next hour Slack takes it: the same shift, paged now.
    vi.mocked(sendLeadValidationRejectionAlert).mockResolvedValue(true)
    const second = await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW + 3_600_000)
    expect(second.paged).toEqual([GIGFI])
    expect(second.undelivered).toEqual([])
    expect(transitions(kv.store)).toEqual([`undelivered ${GIGFI}`, `opened ${GIGFI}`, `paged ${GIGFI}`])
    expect(leadValidationRejectionEnding(second).outcome).toBe('ok')
  })

  it('records a page that delivered as paged, and the run as ok', async () => {
    const out = await runLeadValidationRejectionWatch(db(runs(windowAt, 600, { 'loan amount exceeds maximum': 95 })) as never, makeKv() as never, URL, NOW)
    expect(out.undelivered).toEqual([])
    expect(leadValidationRejectionEnding(out)).toMatchObject({ outcome: 'ok', summary: { paged: [GIGFI], undelivered: [] } })
  })

  it('records a page with no Slack connection to send through as not delivered too', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(null)
    const kv = makeKv()
    const out = await runLeadValidationRejectionWatch(db(runs(windowAt, 600, { 'loan amount exceeds maximum': 95 })) as never, kv as never, URL, NOW)
    expect(out.undelivered).toEqual([GIGFI])
    expect(transitions(kv.store)).toEqual([`undelivered ${GIGFI}`])
  })

  it('sends the all-clear on a judged normal window past the re-arm window, and clears the incident', async () => {
    const alertedAt = new Date(NOW - 5 * 3_600_000).toISOString()
    const lastSeen = new Date(NOW - 3 * 3_600_000).toISOString()
    const kv = makeKv({
      [`${LEAD_VALIDATION_REJECTION_SIGNAL}-recovery:${GIGFI}`]: alertedAt,
      [`${LEAD_VALIDATION_REJECTION_SIGNAL}-active:${GIGFI}`]: lastSeen,
      [`${LEAD_VALIDATION_REJECTION_SIGNAL}-cooldown:${GIGFI}`]: '1',
    })
    const out = await runLeadValidationRejectionWatch(db(runs(windowAt, 600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 })) as never, kv as never, URL, NOW)
    expect(out.allClear).toEqual([GIGFI])
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ signal: 'lead validation rejections', subject: wf.name, alertedAt, endedAt: lastSeen })
    // Logged under its fixed kind (#2948).
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][3]).toBe('lead-validation-rejection-rate-all-clear')
    expect(kv.store.has(`${LEAD_VALIDATION_REJECTION_SIGNAL}-recovery:${GIGFI}`)).toBe(false)
    expect(kv.store.has(`${LEAD_VALIDATION_REJECTION_SIGNAL}-cooldown:${GIGFI}`)).toBe(false)
  })

  it('keeps an open incident through a night with no leads, and sends no all-clear for it', async () => {
    const alertedAt = new Date(NOW - 5 * 3_600_000).toISOString()
    const kv = makeKv({ [`${LEAD_VALIDATION_REJECTION_SIGNAL}-recovery:${GIGFI}`]: alertedAt })
    const out = await runLeadValidationRejectionWatch(db([]) as never, kv as never, URL, NOW)
    expect(out.judged).toEqual([{ workflowId: GIGFI, state: 'unjudged', runs: 0 }])
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(sendLeadValidationRejectionAlert).not.toHaveBeenCalled()
    expect(kv.store.get(`${LEAD_VALIDATION_REJECTION_SIGNAL}-recovery:${GIGFI}`)).toBe(alertedAt)
  })

  it('reads a watch\'s baseline only from its baselineSince, so a change of rule before it is not judged as a shift', async () => {
    // Before the start: no unqualified_lead at all. After it: about 30%, as now.
    const since = new Date(NOW - 2 * 24 * 3_600_000).toISOString()
    const before = runs(new Date(NOW - 5 * 24 * 3_600_000).toISOString(), 20_000, { 'ineligible state': 600 })
    const after = runs(new Date(NOW - 24 * 3_600_000).toISOString(), 5_000, { 'ineligible state': 150, unqualified_lead: 1_500 })
    const window = runs(windowAt, 500, { 'ineligible state': 15, unqualified_lead: 150 })
    const supabase = () => makeSupabase([...before, ...after, ...window], { service_connections: [{ organization_id: ORG }], workflows: [wf] })
    const watch = { workflowId: GIGFI, namespace: STEP, reasons: LEAD_REJECTION_REASONS }

    const started = await runLeadValidationRejectionWatch(supabase() as never, makeKv() as never, URL, NOW, [{ ...watch, baselineSince: since }])
    expect(started.judged).toEqual([{ workflowId: GIGFI, state: 'normal', runs: 500, baselineRuns: 5_000 }])
    expect(sendLeadValidationRejectionAlert).not.toHaveBeenCalled()

    const unstarted = await runLeadValidationRejectionWatch(supabase() as never, makeKv() as never, URL, NOW, [watch])
    expect(unstarted.judged).toEqual([{ workflowId: GIGFI, state: 'shifted', runs: 500, baselineRuns: 25_000 }])
    expect(vi.mocked(sendLeadValidationRejectionAlert).mock.calls[0][2].baseline_days).toBe(7)
  })

  it('pages against a started baseline naming the days it covered, not a week', async () => {
    const since = new Date(NOW - 2 * 24 * 3_600_000).toISOString()
    const after = runs(new Date(NOW - 24 * 3_600_000).toISOString(), 5_000, { 'ineligible state': 150, unqualified_lead: 1_500 })
    const window = runs(windowAt, 500, { 'ineligible state': 15, unqualified_lead: 0 })
    const supabase = makeSupabase([...after, ...window], { service_connections: [{ organization_id: ORG }], workflows: [wf] })
    const out = await runLeadValidationRejectionWatch(supabase as never, makeKv() as never, URL, NOW, [{ workflowId: GIGFI, namespace: STEP, reasons: LEAD_REJECTION_REASONS, baselineSince: since }])
    expect(out.paged).toEqual([GIGFI])
    // From the start (2026-10-19 18:00) to the end of the baseline's last whole day (2026-10-21 08:00).
    expect(vi.mocked(sendLeadValidationRejectionAlert).mock.calls[0][2].baseline_days).toBe(1.6)
  })

  it('refuses a baselineSince that is not a time, rather than reading the whole week', async () => {
    const supabase = db(runs(windowAt, 600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 }))
    await expect(runLeadValidationRejectionWatch(supabase as never, makeKv() as never, URL, NOW, [{ workflowId: GIGFI, namespace: STEP, reasons: LEAD_REJECTION_REASONS, baselineSince: 'version 39' }])).rejects.toThrow(/baselineSince version 39 is not a time/)
  })

  it('leaves the baseline at 7 days once baselineSince is further back than that', async () => {
    const supabase = db(runs(windowAt, 600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 }))
    const out = await runLeadValidationRejectionWatch(supabase as never, makeKv() as never, URL, NOW, [
      { workflowId: GIGFI, namespace: STEP, reasons: LEAD_REJECTION_REASONS, baselineSince: new Date(NOW - 30 * 24 * 3_600_000).toISOString() },
    ])
    expect(out.judged).toEqual([{ workflowId: GIGFI, state: 'normal', runs: 600, baselineRuns: 20_000 }])
  })

  it('judges nothing when the workflow is not live in an organization with Slack', async () => {
    const supabase = makeSupabase(runs(windowAt, 600, { unqualified: 600 }), { service_connections: [{ organization_id: ORG }], workflows: [] })
    const out = await runLeadValidationRejectionWatch(supabase as never, makeKv() as never, URL, NOW)
    expect(out.judged).toEqual([])
    expect(sendLeadValidationRejectionAlert).not.toHaveBeenCalled()
  })

  it('reads only the two hour window on the next hour, the baseline days being kept', async () => {
    const kv = makeKv()
    const supabase = db(runs(windowAt, 600, { 'ineligible state': 70, 'loan amount exceeds maximum': 95 }))
    await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW)
    expect(supabase.counted).toHaveLength(1 + BASELINE_DAYS)
    const next = await runLeadValidationRejectionWatch(supabase as never, kv as never, URL, NOW + 3_600_000)
    expect(next.judged).toEqual([{ workflowId: GIGFI, state: 'normal', runs: 600, baselineRuns: 20_000 }])
    expect(supabase.counted).toHaveLength(2 + BASELINE_DAYS)
  })
})

/**
 * The read budget (#2647), held against the largest watched workflow. RML
 * LendSwift ran 99,115 times in the week to 2026-10-22, about five times GigFi
 * or Lead Economy, and its week is about 101,000 heap pages, 790 MB of a 1 GB
 * shared_buffers. Twelve counts of that week every hour were cancelled at the
 * 30 s service_role ceiling at 04:00 and 09:00 UTC that day. One day of it is
 * about 14,500 runs and 14,400 pages (37 ms warm, measured 2026-10-22 15:30
 * UTC). So no read may span more than one day, a whole day is read once and
 * then kept, and an hourly run reads the two hour window and nothing else.
 */
describe('the read budget: no hourly run recounts the week', () => {
  const ORG = '26472647-2647-4647-8647-264726472647'
  const wfs = [GIGFI, LENDSWIFT, LEAD_ECONOMY].map((id) => ({ id, name: id, organization_id: ORG, slack_channel: null }))
  const START = Date.parse('2026-10-21T18:00:00.000Z')
  const DAY = 24 * 3_600_000

  /** 160 finished runs every hour for each workflow, from 9 days before START to a day after it. */
  function traffic(): ExecRow[] {
    const out: ExecRow[] = []
    for (let h = START - 9 * DAY; h < START + DAY; h += 3_600_000) {
      const at = new Date(h + 30 * 60_000).toISOString()
      for (const wf of wfs) for (let i = 0; i < 160; i++) out.push({ workflow_id: wf.id, started_at: at, is_test: false, status: 'completed', final_node_namespace: i < 20 ? STEP : 'return_response', reason: i < 20 ? 'loan amount exceeds maximum' : null })
    }
    return out
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue({ bot_token: 'xoxb-t', default_channel: 'C1' } as never)
  })

  it('over a day of hourly runs reads each whole day once per watch, and every read is at most a day long', async () => {
    const supabase = makeSupabase(traffic(), { service_connections: [{ organization_id: ORG }], workflows: wfs })
    const kv = makeKv()
    const perRun: number[] = []
    for (let h = 0; h < 24; h++) {
      const before = supabase.counted.length
      const out = await runLeadValidationRejectionWatch(supabase as never, kv as never, 'https://app.example.com', START + h * 3_600_000)
      expect(out.judged.map((j) => j.state)).toEqual(['normal', 'normal', 'normal'])
      perRun.push(supabase.counted.length - before)
    }
    const span = (a: CountArgs) => Date.parse(a.p_to) - Date.parse(a.p_from)
    expect(Math.max(...supabase.counted.map(span))).toBeLessThanOrEqual(DAY)

    const windows = supabase.counted.filter((a) => span(a) === WINDOW_MINUTES * 60_000)
    const days = supabase.counted.filter((a) => span(a) !== WINDOW_MINUTES * 60_000)
    expect(windows).toHaveLength(24 * 3)
    // No whole day is read twice for the same watch.
    expect(new Set(days.map((a) => `${a.p_workflow_id} ${a.p_from} ${a.p_to}`)).size).toBe(days.length)
    // The first run reads the week a day at a time; one new day joins at 11:00 UTC (08:00 plus the window and the settle).
    for (const wf of [GIGFI, LENDSWIFT]) expect(days.filter((a) => a.p_workflow_id === wf)).toHaveLength(BASELINE_DAYS + 1)
    // Lead Economy's baseline starts at its version 39 save, so it holds fewer days.
    expect(days.filter((a) => a.p_workflow_id === LEAD_ECONOMY)).toHaveLength(3)
    // Every run after the first reads only the windows, apart from the one that takes in the new day.
    expect(perRun.slice(1).filter((n) => n !== 3)).toEqual([6])
  })
})
