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
  LEAD_VALIDATION_REJECTION_JOB,
  LEAD_VALIDATION_REJECTION_SIGNAL,
  REJECTION_RULE,
  REJECTION_WATCHES,
  SETTLE_MS,
  WINDOW_MINUTES,
  judgeRejectionShares,
  readRejectionCounts,
  rejectionBuckets,
  runLeadValidationRejectionWatch,
  type RejectionCounts,
} from '../lead-validation-rejection-watch'
import { getSlackConnection, sendLeadValidationRejectionAlert, sendRecoveryAlert } from '../slack'
import { CRON_JOBS } from '../cron-heartbeat'
import { incidentSignal } from '../incident-signals'
import { transitions } from './_incident-events'

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

/** A Supabase double that applies the filters a head count uses to workflow_executions rows. */
function makeSupabase(rows: ExecRow[], other: Record<string, unknown[]> = {}, opts: { failOn?: string } = {}) {
  const queries: string[] = []
  return {
    queries,
    from(table: string) {
      const filters: Array<(r: ExecRow) => boolean> = []
      const desc: string[] = []
      let head = false
      const col = (r: ExecRow, c: string): unknown => (c === 'response_body->>reason' ? r.reason : (r as unknown as Record<string, unknown>)[c])
      // Any builder method this double does not model (the Slack list read's) passes through.
      const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
        get(_t, prop) { return prop in methods ? methods[prop as string] : () => chain },
      })
      const methods: Record<string, unknown> = {
        select(_cols: string, o?: { count?: string; head?: boolean }) { head = Boolean(o?.head); return chain },
        eq(c: string, v: unknown) { desc.push(`${c}=${String(v)}`); filters.push((r) => col(r, c) === v); return chain },
        neq(c: string, v: unknown) { desc.push(`${c}!=${String(v)}`); filters.push((r) => col(r, c) !== v); return chain },
        gte(c: string, v: string) { filters.push((r) => String(col(r, c)) >= v); return chain },
        lt(c: string, v: string) { filters.push((r) => String(col(r, c)) < v); return chain },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          if (table === 'workflow_executions') {
            queries.push(desc.join(' '))
            if (opts.failOn && desc.join(' ').includes(opts.failOn)) return Promise.resolve({ data: null, count: null, error: { message: 'statement timeout' } }).then(res, rej)
            const n = rows.filter((r) => filters.every((f) => f(r))).length
            return Promise.resolve({ data: head ? null : [], count: n, error: null }).then(res, rej)
          }
          return Promise.resolve({ data: other[table] ?? [], error: null }).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('readRejectionCounts(): head counts over workflow_executions', () => {
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

  it('counts finished live runs in the window, by where they ended and why', async () => {
    const c = await readRejectionCounts(makeSupabase(rows) as never, REJECTION_WATCHES[0], new Date('2026-10-21T14:00:00Z'), new Date('2026-10-21T16:00:00Z'))
    expect(c.runs).toBe(5)
    expect(c.atStep).toBe(4)
    expect(c.failed).toBe(1)
    expect(c.byReason['ineligible state']).toBe(2)
    expect(rejectionBuckets(c).find((b) => b.bucket === 'a reason not on the list')?.count).toBe(1)
  })

  it('throws when a count cannot be read, so the run fails rather than reading as quiet', async () => {
    const supabase = makeSupabase(rows, {}, { failOn: 'status=failed' })
    await expect(readRejectionCounts(supabase as never, REJECTION_WATCHES[0], new Date('2026-10-21T14:00:00Z'), new Date('2026-10-21T16:00:00Z'))).rejects.toThrow(/statement timeout/)
  })
})

// ── The check ───────────────────────────────────────────────────────────────

describe('runLeadValidationRejectionWatch', () => {
  const ORG = '25922592-2592-4592-8592-259225922592'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }
  const URL = 'https://app.example.com'
  const wf = { id: GIGFI, name: 'RML - Bidding Workflow (GigFi)', organization_id: ORG, slack_channel: null }
  const NOW = Date.parse('2026-10-21T18:00:00.000Z')

  function makeKv(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial))
    return {
      store: m,
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
      delete: vi.fn(async (k: string) => { m.delete(k) }),
    }
  }

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

  it('judges the two hours that ended SETTLE_MS ago against the week before them', async () => {
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
    // From the start to the window's start: 2 days less the 2 hour window and the 2 minute settle.
    expect(vi.mocked(sendLeadValidationRejectionAlert).mock.calls[0][2].baseline_days).toBe(1.9)
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
})
