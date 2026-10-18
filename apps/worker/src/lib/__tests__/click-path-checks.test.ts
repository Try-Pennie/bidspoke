/**
 * The click buyer path checks (#1546), every 15 minutes. Each alert has a case
 * that fires it and a case that stays quiet, and every input (the clock, the
 * step rows, the offers, the click executions, the counter and Salesforce) is
 * injected, so nothing waits and nothing leaves the process.
 *
 *   check errors   a SHARE of the runs that reached buyer_click_check in the
 *                  last hour that could not complete, with a minimum
 *                  denominator, and saturation below it (L139, L716).
 *   quiet          none of the leads that reached the check inside the
 *                  buyer's selling hours, over up to six hours since its
 *                  profile last changed, was eligible, and at its own eligible
 *                  rate since that change so many with none is under one in
 *                  1,000 (#2104), or, when no lead has been eligible since
 *                  that change, at the share eligible in the 72 hours before
 *                  it (#2426); and offers were made with no click execution
 *                  in three hours.
 *   refusals       a burst of buyer_click_send refusals for one buyer.
 *   reconcile      once per Pacific day: the counted prospects against the
 *                  Salesforce prospects the click wrote Completed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoadedBuyer } from '../buyer-profile-loader'
import type { AlertRemedy } from '../export-alerts'
import {
  CHECK_ERROR_MIN_RUNS,
  CHECK_ERROR_SATURATION_MIN_RUNS,
  CLICK_CHECK_ERRORS_JOB,
  CLICK_CHECK_ERRORS_REMEDY,
  CLICK_PATH_CHECKS_JOB,
  CLICK_PATH_QUIET_JOB,
  CLICK_PATH_UNREAD_REMEDY,
  CLICK_RECONCILE_REMEDY,
  CLICK_RECONCILE_JOB,
  CLICK_SEND_REFUSALS_JOB,
  CLICK_SEND_REFUSALS_REMEDY,
  clickRemedyFor,
  EDIT_PICKUP_GRACE_MS,
  EDIT_PRE_WINDOW_MS,
  NO_CLICK_MIN_OFFERS,
  QUIET_MIN_RUNS,
  QUIET_RATE_WINDOW_MS,
  REFUSAL_MIN_COUNT,
  endingOf,
  judgeCheckErrors,
  judgeRefusals,
  runClickPathChecks,
  type CheckRun,
  type ClickPathDeps,
  type ClickSubject,
  type SendRun,
} from '../click-path-checks'
import { CRON_JOBS } from '../cron-heartbeat'

const PARTNER = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const ORG = '22222222-2222-4222-8222-222222222222'
const MIN = 60_000
const HOUR = 60 * MIN
/** Tuesday 2027-09-21 21:00 UTC: 14:00 Pacific, 17:00 Eastern. The six hours before it are all inside 8am to 6pm Pacific, starting at 8am exactly. */
const NOW = Date.UTC(2027, 8, 21, 21, 0)
/** Mon to Fri 8am to 6pm Pacific, as Eastern minutes (the profile's clock). */
const WEEKDAYS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensMinute: 11 * 60, closesMinute: 21 * 60 }))

const SUBJECT: ClickSubject = {
  organization_id: ORG,
  partner_id: PARTNER,
  check: { workflow_ids: ['wf-engine'], namespaces: ['buyer_click_check'] },
  send: { workflow_ids: ['wf-click'], namespaces: ['click_send'] },
}

function buyer(over: Partial<LoadedBuyer['profile']> = {}, updatedAt = '2027-09-20T10:00:00.000Z'): LoadedBuyer {
  return {
    partner: {
      id: PARTNER, slug: 'liberty1', is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null, extra_extraction: null,
      accept_signals: [], response_classification: null, name: 'Liberty1', click_url: 'https://trypennie.com/portal/libertyone/{prospect_id}',
      external_routing_code: 4, duplicate_signals: [], circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
    },
    profile: {
      partnerId: PARTNER, soldOn: 'click', isEnabled: true, priority: null,
      allowedStates: ['TX'], debtMin: 20000, debtMax: null, loanAmountMin: 2500,
      hourlyLeadCap: null, dailyLeadCap: 50, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows: WEEKDAYS, blackoutDates: [], tiers: [], ...over,
    },
    version: 1,
    updated_at: updatedAt,
  }
}

/** n check runs spread over the window ending at NOW, one reason each. */
function checkRuns(reason: string, n: number, spanMs = HOUR, prefix = reason): CheckRun[] {
  return Array.from({ length: n }, (_, i) => ({
    execution_id: `${prefix}-${i}`,
    started_at: new Date(NOW - Math.floor(((i + 1) * spanMs) / (n + 1))).toISOString(),
    route: reason === 'eligible' ? 'eligible' : 'not_eligible',
    reason,
  }))
}

/** n check runs spread evenly over [fromMs, toMs), one reason each. */
function runsBetween(reason: string, n: number, fromMs: number, toMs: number, prefix = reason): CheckRun[] {
  return Array.from({ length: n }, (_, i) => ({
    execution_id: `${prefix}-${i}`,
    started_at: new Date(fromMs + Math.floor(((i + 0.5) * (toMs - fromMs)) / n)).toISOString(),
    route: reason === 'eligible' ? 'eligible' : 'not_eligible',
    reason,
  }))
}

function sendRuns(route: string, n: number): SendRun[] {
  return Array.from({ length: n }, (_, i) => ({ started_at: new Date(NOW - (i + 1) * MIN).toISOString(), route }))
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

interface World {
  checks?: CheckRun[]
  sends?: SendRun[]
  clicks?: number
  offers?: string[]
  buyer?: LoadedBuyer | null | Error
  members?: Record<string, string[]>
  salesforce?: Array<{ id: string; at: string }> | Error
  submissions?: Array<{ id: string; at: string }> | Error
  now?: number
  kv?: ReturnType<typeof fakeKv>
}

function deps(w: World = {}) {
  const pages: Record<string, string[][]> = {}
  const remedies: Record<string, AlertRemedy[]> = {}
  const notify = (job: string) => async (lines: string[], remedy: AlertRemedy) => {
    ;(pages[job] ??= []).push(lines)
    ;(remedies[job] ??= []).push(remedy)
  }
  const sfCalls: Array<{ routingCode: number; fromMs: number; toMs: number }> = []
  const submissionCalls: Array<{ routingCode: number; fromMs: number; toMs: number }> = []
  const d: ClickPathDeps = {
    listSubjects: async () => [SUBJECT],
    readPartner: async () => ({ slug: 'liberty1', external_routing_code: 4 }),
    loadBuyer: async () => {
      if (w.buyer instanceof Error) throw w.buyer
      return w.buyer === undefined ? buyer() : w.buyer
    },
    readCheckRuns: async (_s, fromMs, toMs) => (w.checks ?? checkRuns('eligible', 30)).filter((r) => Date.parse(r.started_at) >= fromMs && Date.parse(r.started_at) < toMs),
    readSendRuns: async (_s, fromMs, toMs) => (w.sends ?? []).filter((r) => Date.parse(r.started_at) >= fromMs && Date.parse(r.started_at) < toMs),
    countClickExecutions: async () => w.clicks ?? 5,
    readOfferExecutionIds: async () => w.offers ?? [],
    counterMembers: async (_p, date) => w.members?.[date] ?? [],
    readCompletedProspects: async (_org, routingCode, fromMs, toMs) => {
      sfCalls.push({ routingCode, fromMs, toMs })
      if (w.salesforce instanceof Error) throw w.salesforce
      return w.salesforce ?? []
    },
    readCompletedSubmissionsWithoutProspect: async (_org, routingCode, fromMs, toMs) => {
      submissionCalls.push({ routingCode, fromMs, toMs })
      if (w.submissions instanceof Error) throw w.submissions
      return w.submissions ?? []
    },
    kv: w.kv ?? fakeKv(),
    notify: {
      [CLICK_CHECK_ERRORS_JOB]: notify(CLICK_CHECK_ERRORS_JOB),
      [CLICK_PATH_QUIET_JOB]: notify(CLICK_PATH_QUIET_JOB),
      [CLICK_SEND_REFUSALS_JOB]: notify(CLICK_SEND_REFUSALS_JOB),
      [CLICK_RECONCILE_JOB]: notify(CLICK_RECONCILE_JOB),
    },
    now: () => w.now ?? NOW,
    localDev: false,
    appUrl: 'https://app.test',
    log: () => undefined,
  }
  return { d, pages, remedies, sfCalls, submissionCalls }
}

/** The lines a family was last notified with, or undefined when it was not notified this run. */
const last = (pages: Record<string, string[][]>, job: string) => pages[job]?.[pages[job].length - 1]

describe('the job', () => {
  it('is watched by the cron heartbeat on the 15 minute schedule it runs on', () => {
    const job = CRON_JOBS.find((j) => j.id === CLICK_PATH_CHECKS_JOB)
    expect(job).toMatchObject({ triggerCron: '*/15 * * * *' })
  })

  it('does nothing in local dev', async () => {
    const { d, pages } = deps()
    const s = await runClickPathChecks({ ...d, localDev: true })
    expect(s.skipped).toBe('local_dev')
    expect(pages).toEqual({})
  })
})

describe('check errors: a share of the runs that reached the check, never a count', () => {
  it('fires when a fifth or more of an hour of runs could not complete, naming the reasons', async () => {
    const runs = [...checkRuns('eligible', 20), ...checkRuns('cap_check_error', 6), ...checkRuns('profile_copy_stale', 1)]
    const { d, pages } = deps({ checks: runs })
    await runClickPathChecks(d)
    const lines = last(pages, CLICK_CHECK_ERRORS_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('liberty1')
    expect(lines[0]).toContain('7 of 27')
    expect(lines[0]).toMatch(/cap_check_error 6/)
    expect(lines[0]).toMatch(/profile_copy_stale 1/)
  })

  it('stays quiet on the same count of errors among many more runs, because it is a share', async () => {
    const runs = [...checkRuns('eligible', 200), ...checkRuns('cap_check_error', 7)]
    const { d, pages } = deps({ checks: runs })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_CHECK_ERRORS_JOB)).toEqual([])
  })

  it('below the minimum denominator a high share is not judged, unless every run failed (saturation)', () => {
    const few = [...checkRuns('eligible', 2), ...checkRuns('cap_check_error', 3)]
    expect(few.length).toBeLessThan(CHECK_ERROR_MIN_RUNS)
    expect(judgeCheckErrors(few, NOW).verdict).toBe('quiet')
    const saturated = checkRuns('cap_check_error', CHECK_ERROR_SATURATION_MIN_RUNS)
    expect(judgeCheckErrors(saturated, NOW)).toMatchObject({ verdict: 'elevated' })
    expect(judgeCheckErrors(checkRuns('cap_check_error', CHECK_ERROR_SATURATION_MIN_RUNS - 1), NOW).verdict).toBe('quiet')
  })

  it('reads only the last hour: errors older than that are not counted', () => {
    const old = checkRuns('cap_check_error', 30, 3 * HOUR).filter((r) => Date.parse(r.started_at) < NOW - HOUR)
    const judged = judgeCheckErrors([...old, ...checkRuns('eligible', 25)], NOW)
    expect(judged.verdict).toBe('normal')
  })
})

// #2104: zero eligible is judged against the buyer's own eligible rate since its
// profile last changed, over up to six hours of its selling time, and only pages
// when that many leads with none eligible would happen less than once in 1,000.
describe('quiet: zero eligible, judged against the buyer\'s own eligible rate', () => {
  /** Monday 2027-09-20, 17:00 to 21:00 Eastern: the selling hours the day before NOW, inside the 24 hour rate window. */
  const MON_FROM = Date.UTC(2027, 8, 20, 21, 0)
  const MON_TO = Date.UTC(2027, 8, 21, 1, 0)
  /** Tuesday 11:00 to 17:00 Eastern: the six hours of selling time before NOW. */
  const TUE_FROM = NOW - 6 * HOUR
  /** A Monday with 25 eligible in 100: with today's 100 none eligible, the rate is 12.5 percent and 52 leads with none is under 1 in 1,000. */
  const monday = (eligible = 25, total = 100) => [...runsBetween('eligible', eligible, MON_FROM, MON_TO, 'mon-e'), ...runsBetween('state_not_allowed', total - eligible, MON_FROM, MON_TO, 'mon-s')]
  const today = (n = 100) => [...runsBetween('state_not_allowed', Math.ceil(n * 0.6), TUE_FROM, NOW, 'tue-s'), ...runsBetween('missing_lead_field', Math.floor(n * 0.4), TUE_FROM, NOW, 'tue-m')]

  it('fires when today\'s leads with none eligible would happen less than once in 1,000 at the buyer\'s own rate, naming the minutes, the rate and why', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today()] })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet.verdict).toBe('quiet')
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/100 leads reached the Buyer Click Check in 360 minutes of its selling hours/)
    expect(lines[0]).toMatch(/none was eligible/)
    expect(lines[0]).toMatch(/12.5% of leads have been eligible/)
    expect(lines[0]).toMatch(/state_not_allowed 60/)
  })

  it('stays quiet when the buyer\'s rate is low enough that this many with none is ordinary, and says what it would take', async () => {
    // 12 eligible in 300 on Monday plus 100 none today: 3 percent, so it takes 227 leads.
    const { d, pages } = deps({ checks: [...monday(12, 300), ...today()] })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/100 leads.*227 needed at 3% eligible/)
  })

  it('does not page on a profile switched on 15 minutes before the run, however many leads it has seen since (#2104)', async () => {
    const switchedOn = new Date(NOW - 15 * MIN).toISOString()
    // 60, not the issue's 30: at Monday's rate (25 in 160) 41 with none would page, so only the switch on keeps this quiet.
    const runs = [...monday(), ...runsBetween('state_not_allowed', 60, NOW - 15 * MIN, NOW, 'since')]
    const { d, pages } = deps({ checks: runs, buyer: buyer({}, switchedOn) })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
  })

  it('judges only the runs since the profile last changed: a rule change today resets both the rate and the window', async () => {
    // Monday's busy rate would make today's 100 none eligible a page, but the profile changed two hours ago, so only the 33 since count.
    const changed = new Date(NOW - 2 * HOUR).toISOString()
    const { d, pages } = deps({ checks: [...monday(), ...today()], buyer: buyer({}, changed) })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
  })

  it('cannot judge a buyer with no eligible lead since its profile changed, and says its rate is not known rather than paging', async () => {
    const { d, pages } = deps({ checks: [...runsBetween('state_not_allowed', 100, MON_FROM, MON_TO, 'mon'), ...today()] })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/rate is not known/)
  })

  it('counts only leads that arrived inside the selling hours, judged from the profile\'s own windows', async () => {
    // 12:00 Eastern: selling since 11:00, so the six hours reach back to 06:00 and the leads before 11:00 do not count.
    const now = Date.UTC(2027, 8, 21, 16, 0)
    const early = runsBetween('state_not_allowed', 200, now - 6 * HOUR, now - HOUR, 'early')
    const open = runsBetween('state_not_allowed', 20, now - HOUR, now, 'open')
    const { d, pages } = deps({ checks: [...monday(), ...early, ...open], now })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/^20 leads in 60 minutes/)
  })

  it('cannot judge a profile whose last change time cannot be read, rather than judging the whole window and losing the switch on guard', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today()], buyer: buyer({}, 'not a time') })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/last change.*cannot be read/)
  })

  it('says how long it looked when there was no selling time, never more than since the profile changed', async () => {
    const now = Date.UTC(2027, 8, 19, 21, 0)
    const { d } = deps({ checks: [], now, buyer: buyer({}, new Date(now - 20 * MIN).toISOString()) })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'not_open' })
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/^no selling time in the 20 minutes judged/)
  })

  it('is not open when none of the six hours were selling time', async () => {
    // Sunday 2027-09-19 17:00 Eastern: no window on Sundays.
    const now = Date.UTC(2027, 8, 19, 21, 0)
    const { d, pages } = deps({ checks: runsBetween('state_not_allowed', 80, now - 6 * HOUR, now, 'sun'), now })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet.verdict).toBe('not_open')
  })

  it('stays quiet when one lead in the six hours was eligible', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today(), ...runsBetween('eligible', 1, TUE_FROM, NOW, 'e')], offers: [] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('stays quiet when the day\'s cap was reached, because not eligible is then the cap working', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today(), ...runsBetween('daily_click_cap', 5, TUE_FROM, NOW, 'c')] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('never judges fewer than QUIET_MIN_RUNS, and does not count runs the disabled profile answered', async () => {
    // A rate so high one lead would do: the absolute minimum still holds.
    const { d, pages } = deps({ checks: [...monday(90, 100), ...runsBetween('state_not_allowed', QUIET_MIN_RUNS - 1, TUE_FROM, NOW, 'few'), ...runsBetween('profile_disabled', 50, TUE_FROM, NOW, 'off')] })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
  })

  it('reads the check runs back across the whole rate window, once', async () => {
    const { d } = deps({ checks: [...monday(), ...today()] })
    const calls: Array<[number, number]> = []
    const read = d.readCheckRuns
    d.readCheckRuns = async (s, from, to) => { calls.push([from, to]); return read(s, from, to) }
    await runClickPathChecks(d)
    expect(calls).toHaveLength(1)
    expect(NOW - calls[0][0]).toBeGreaterThanOrEqual(QUIET_RATE_WINDOW_MS)
  })

  it('is not judged for a buyer with no enabled profile, which is the switch being off', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today()], buyer: null })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet.verdict).toBe('not_enabled')
  })

  it('a profile that cannot be read leaves the quiet check unmeasured, never clean', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today()], buyer: new Error('db down') })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'unmeasured' })
    expect(endingOf(s).outcome).toBe('unmeasured')
     // Unmeasured must page, never pass silently for a clean run (L98).
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([expect.stringMatching(/liberty1: .*could not be read.*db down/)])
  })

  it('keeps a found no-eligible problem when the offer half cannot be read, and says that half is unknown', async () => {
    const { d, pages } = deps({ checks: [...monday(), ...today()] })
    d.readPartner = async () => { throw new Error('partner read failed') }
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet.verdict).toBe('quiet')
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines.some((l) => /none was eligible/.test(l))).toBe(true)
    expect(lines.some((l) => /not known.*partner read failed/.test(l))).toBe(true)
  })

  it('refusals that cannot be read page as unknown, never as a quiet hour', async () => {
    const { d, pages } = deps()
    d.readSendRuns = async () => { throw new Error('steps timed out') }
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].refusals).toMatchObject({ verdict: 'unmeasured' })
    expect(last(pages, CLICK_SEND_REFUSALS_JOB)).toEqual([expect.stringMatching(/liberty1: .*could not be read.*steps timed out/)])
  })
})

describe('quiet: a profile edit that leaves no lead eligible pages against the share before it (#2426)', () => {
  /** Monday 2027-09-20 11:00 to 16:30 Eastern: selling hours more than 24 hours before NOW, so only a read reaching before the edit sees them. */
  const PRE_FROM = Date.UTC(2027, 8, 20, 15, 0)
  const PRE_TO = Date.UTC(2027, 8, 20, 20, 30)
  /** Liberty1 after its collections cap: about 4 percent eligible (#2111), here 20 of 500. */
  const before = (eligible = 20, total = 500) => [
    ...runsBetween('eligible', eligible, PRE_FROM, PRE_TO, 'pre-e'),
    ...runsBetween('debt_above_max', total - eligible, PRE_FROM, PRE_TO, 'pre-n'),
  ]
  /** Tuesday 13:00 Eastern, four hours before NOW, inside the selling day. */
  const EDIT = NOW - 4 * HOUR
  const editedBuyer = (at = EDIT) => buyer({ debtMin: 90000 }, new Date(at).toISOString())
  /** Every lead after the edit out on the new floor, from 20 minutes after it, past the pickup grace. */
  const after = (n = 200, from = EDIT + 20 * MIN) => [
    ...runsBetween('debt_below_min', Math.ceil(n * 0.6), from, NOW, 'post-d'),
    ...runsBetween('loan_amount_below_min', Math.floor(n * 0.4), from, NOW, 'post-l'),
  ]

  it('pages when a Liberty1 profile edit takes the eligible share from its level before the edit to zero', async () => {
    const { d, pages } = deps({ checks: [...before(), ...after()], buyer: editedBuyer() })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet.verdict).toBe('quiet')
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/200 leads reached the Buyer Click Check in its selling hours since its profile was changed at Sep 21, 1:00 PM ET, and none was eligible/)
    expect(lines[0]).toMatch(/4% of leads were eligible \(20 of 500\) in the 72 hours before that change/)
    expect(lines[0]).toMatch(/debt_below_min 120, loan_amount_below_min 80/)
  })

  it('reads the leads before the edit from before the 24 hour rate window, only when nothing has been eligible since the edit', async () => {
    const { d } = deps({ checks: [...before(), ...after()], buyer: editedBuyer() })
    const calls: Array<[number, number]> = []
    const read = d.readCheckRuns
    d.readCheckRuns = async (s, from, to) => { calls.push([from, to]); return read(s, from, to) }
    await runClickPathChecks(d)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([EDIT - EDIT_PRE_WINDOW_MS, calls[0][0]])
  })

  it('pages even when leads inside the pickup grace after the edit were eligible, because they may have been judged on the old copy', async () => {
    const stale = runsBetween('eligible', 3, EDIT, EDIT + 10 * MIN, 'stale')
    const { d, pages } = deps({ checks: [...before(), ...stale, ...after()], buyer: editedBuyer() })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet.verdict).toBe('quiet')
    expect((last(pages, CLICK_PATH_QUIET_JOB) ?? [])[0]).toMatch(/since its profile was changed/)
    expect(EDIT_PICKUP_GRACE_MS).toBeGreaterThanOrEqual(15 * MIN)
  })

  it('does not page yet when too few leads have arrived since the edit, and says what it would take at the share before it', async () => {
    const edit = NOW - HOUR
    const { d, pages } = deps({ checks: [...before(), ...after(40, edit + 20 * MIN)], buyer: editedBuyer(edit) })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'too_few' })
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/40 leads in selling hours since the profile changed.*none eligible.*170 needed at the 4% eligible in the 72 hours before/)
  })

  it('stays quiet when the day\'s cap was reached after the edit, because not eligible is then the cap working', async () => {
    const capped = runsBetween('daily_click_cap', 2, NOW - 30 * MIN, NOW, 'cap')
    const { d, pages } = deps({ checks: [...before(), ...after(), ...capped], buyer: editedBuyer() })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('an ordinary edit that leaves some leads eligible re-baselines on the share since it, as before', async () => {
    // Edited Monday 18:00 Eastern at 25 percent; since then 5 of 200 eligible, so the bar is 2.5 percent and
    // today's 100 with none is not yet unusual, where the share before the edit would have paged on them.
    const edit = Date.UTC(2027, 8, 20, 22, 0)
    const runs = [
      ...runsBetween('eligible', 50, PRE_FROM, edit, 'pre-e'), ...runsBetween('debt_above_max', 150, PRE_FROM, edit, 'pre-n'),
      ...runsBetween('eligible', 5, edit + 20 * MIN, Date.UTC(2027, 8, 21, 1, 0), 'mon-e'), ...runsBetween('debt_above_max', 95, edit + 20 * MIN, Date.UTC(2027, 8, 21, 1, 0), 'mon-n'),
      ...runsBetween('debt_below_min', 100, NOW - 6 * HOUR, NOW, 'tue'),
    ]
    const { d, pages } = deps({ checks: runs, buyer: editedBuyer(edit) })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/100 leads in 360 minutes of selling time, 273 needed at 2.5% eligible/)
  })

  it('with no edit in the kept history and none eligible, says the rate is not known as before, reading once', async () => {
    const { d, pages } = deps({
      checks: [...runsBetween('state_not_allowed', 100, Date.UTC(2027, 8, 20, 21, 0), Date.UTC(2027, 8, 21, 1, 0), 'mon'), ...after(100, NOW - 6 * HOUR)],
      buyer: buyer({}, '2027-09-11T10:00:00.000Z'),
    })
    const calls: Array<[number, number]> = []
    const read = d.readCheckRuns
    d.readCheckRuns = async (s, from, to) => { calls.push([from, to]); return read(s, from, to) }
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/rate is not known/)
    expect(calls).toHaveLength(1)
  })

  it('with no lead eligible before the edit either, there is no share to compare, so it says the rate is not known as before', async () => {
    const { d, pages } = deps({ checks: [...before(0, 500), ...after()], buyer: editedBuyer() })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/rate is not known/)
  })

  it('trusts no share from fewer than QUIET_RATE_MIN_RUNS leads before the edit, however high it is', async () => {
    // 10 of 30 is a third, at which 60 with none would page; 30 leads is too few to trust.
    const { d, pages } = deps({ checks: [...before(10, 30), ...after(60)], buyer: editedBuyer() })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect((s.subjects[0].quiet as { detail?: string }).detail).toMatch(/rate is not known/)
  })

  it('a read of the leads before the edit that fails says the check is not known, never a clean run', async () => {
    const { d, pages } = deps({ checks: [...before(), ...after()], buyer: editedBuyer() })
    const read = d.readCheckRuns
    d.readCheckRuns = async (s, from, to) => { if (from < NOW - QUIET_RATE_WINDOW_MS) throw new Error('steps timed out'); return read(s, from, to) }
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'unmeasured' })
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([expect.stringMatching(/liberty1: .*not known.*before the profile change.*steps timed out/)])
  })
})

describe('quiet: offers made and no click execution for three hours', () => {
  const eligible = checkRuns('eligible', NO_CLICK_MIN_OFFERS + 5, 3 * HOUR)
  const offered = eligible.map((r) => r.execution_id)

  it('fires when enough offers were made and no click execution ran', async () => {
    const { d, pages } = deps({ checks: eligible, offers: offered, clicks: 0 })
    await runClickPathChecks(d)
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines.some((l) => /offers/.test(l) && /no click/.test(l))).toBe(true)
  })

  it('stays quiet when one click execution ran', async () => {
    const { d, pages } = deps({ checks: eligible, offers: offered, clicks: 1 })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('stays quiet below the minimum of offers', async () => {
    const { d, pages } = deps({ checks: eligible, offers: offered.slice(0, NO_CLICK_MIN_OFFERS - 1), clicks: 0 })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('counts only offers made by this organization\'s own check runs', async () => {
    const foreign = Array.from({ length: 40 }, (_, i) => `other-org-${i}`)
    const { d, pages } = deps({ checks: eligible, offers: foreign, clicks: 0 })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('says so when no live workflow sends this buyer\'s clicks at all', async () => {
    const { d, pages } = deps({ checks: eligible, offers: offered, clicks: 0 })
    const noSend = { ...d, listSubjects: async () => [{ ...SUBJECT, send: { workflow_ids: [], namespaces: [] } }] }
    await runClickPathChecks(noSend)
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines.some((l) => /no live workflow sends/.test(l))).toBe(true)
  })
})

describe('refusals: a burst of buyer_click_send refusals for one buyer', () => {
  it('fires on a burst: enough refusals that they are most of the answered sends', async () => {
    const { d, pages } = deps({ sends: [...sendRuns('refused', 6), ...sendRuns('sent', 3)] })
    await runClickPathChecks(d)
    const lines = last(pages, CLICK_SEND_REFUSALS_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/6 of 9/)
  })

  it('stays quiet on refusals that are a small share of what was sent', async () => {
    const { d, pages } = deps({ sends: [...sendRuns('refused', 6), ...sendRuns('sent', 30)] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_SEND_REFUSALS_JOB)).toEqual([])
  })

  it('stays quiet under the minimum count however high the share, and counts only answered sends', () => {
    expect(judgeRefusals(sendRuns('refused', REFUSAL_MIN_COUNT - 1), NOW).verdict).toBe('quiet')
    expect(judgeRefusals([...sendRuns('refused', REFUSAL_MIN_COUNT), ...sendRuns('already_sent', 50)], NOW).verdict).toBe('elevated')
  })
})

describe('reconcile: the counted prospects against Salesforce, once per Pacific day', () => {
  /** 2027-09-20 is the Pacific day before NOW; it began at 07:00 UTC. */
  const DAY = '2027-09-20'
  const at = (h: number) => new Date(Date.UTC(2027, 8, 20, h, 0)).toISOString()

  it('pages naming the prospects on each side of a mismatch', async () => {
    const { d, pages } = deps({
      members: { [DAY]: ['a0X000000000001', 'a0X000000000002'] },
      salesforce: [{ id: 'a0X000000000001', at: at(18) }, { id: 'a0X000000000003', at: at(19) }],
    })
    await runClickPathChecks(d)
    const lines = last(pages, CLICK_RECONCILE_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(DAY)
    expect(lines[0]).toMatch(/counted.*a0X000000000002/)
    expect(lines[0]).toMatch(/never counted.*a0X000000000003/)
  })

  it('stays quiet when both sides hold the same prospects, and runs once for the day', async () => {
    const kv = fakeKv()
    const w: World = { kv, members: { [DAY]: ['a0X000000000001'] }, salesforce: [{ id: 'a0X000000000001', at: at(18) }] }
    const first = deps(w)
    await runClickPathChecks(first.d)
    expect(last(first.pages, CLICK_RECONCILE_JOB)).toEqual([])
    expect(first.sfCalls).toHaveLength(1)
    // Bounded to the Pacific day, padded for a click counted just before midnight and written just after.
    expect(first.sfCalls[0].routingCode).toBe(4)
    expect(first.sfCalls[0].fromMs).toBeLessThan(Date.UTC(2027, 8, 20, 7))
    expect(first.sfCalls[0].toMs).toBeGreaterThan(Date.UTC(2027, 8, 21, 7))
    const second = deps(w)
    await runClickPathChecks(second.d)
    expect(second.sfCalls).toHaveLength(0)
    expect(last(second.pages, CLICK_RECONCILE_JOB)).toBeUndefined()
  })

  it('a click counted on the day and written to Salesforce just after midnight is not a mismatch, nor one counted the day before', async () => {
    const { d, pages } = deps({
      members: { [DAY]: ['a0X000000000001'], '2027-09-19': ['a0X000000000009'] },
      salesforce: [{ id: 'a0X000000000001', at: new Date(Date.UTC(2027, 8, 21, 7, 0, 30)).toISOString() }, { id: 'a0X000000000009', at: at(7) }],
    })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_RECONCILE_JOB)).toEqual([])
  })

  it('waits for the day to settle: before 1am Pacific the previous day is not read', async () => {
    const early = Date.UTC(2027, 8, 21, 7, 30) // 00:30 Pacific
    const { d, sfCalls } = deps({ now: early, members: { [DAY]: ['a0X000000000001'] } })
    await runClickPathChecks(d)
    expect(sfCalls).toHaveLength(0)
  })

  it('a Submission-only sale (no Prospect, keyed on the submission) matches its Completed submission, read over the same padded day', async () => {
    const { d, pages, sfCalls, submissionCalls } = deps({
      members: { [DAY]: ['a0X000000000001', 'a04000000000001'] },
      salesforce: [{ id: 'a0X000000000001', at: at(18) }],
      submissions: [{ id: 'a04000000000001', at: at(19) }],
    })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].reconcile).toMatchObject({ verdict: 'match' })
    expect(last(pages, CLICK_RECONCILE_JOB)).toEqual([])
    expect(submissionCalls).toEqual(sfCalls)
  })

  it('a Completed Liberty1 submission with no Prospect that was never counted pages naming it', async () => {
    const { d, pages } = deps({ members: { [DAY]: [] }, submissions: [{ id: 'a04000000000002', at: at(19) }] })
    await runClickPathChecks(d)
    expect((last(pages, CLICK_RECONCILE_JOB) ?? [])[0]).toMatch(/never counted.*a04000000000002/)
  })

  it('a counted click with neither a Completed prospect nor a Completed submission is a mismatch named as such', async () => {
    const { d, pages } = deps({ members: { [DAY]: ['a04000000000003'] } })
    await runClickPathChecks(d)
    expect((last(pages, CLICK_RECONCILE_JOB) ?? [])[0]).toMatch(/no Completed prospect or submission.*a04000000000003/)
  })

  it('a submission read that fails is unreconciled, never a match on the prospects alone', async () => {
    const { d } = deps({ members: { [DAY]: ['a0X000000000001'] }, salesforce: [{ id: 'a0X000000000001', at: at(18) }], submissions: new Error('Salesforce query failed (503)') })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].reconcile).toMatchObject({ verdict: 'unmeasured' })
  })

  // #1766: buyer_click_send now pages "may not have been counted" when the counter gave no
  // answer, because such an add can land late. This check is where that is settled, so its
  // fix hint says which of those clicks it lists, and keeps "read low" for what it measured.
  it('the fix hint says a click paged as possibly not counted is listed only when its add never landed', () => {
    expect(CLICK_RECONCILE_REMEDY.fixHint).toMatch(/A click paged as possibly not counted is listed here only when its add never landed\./)
    expect(CLICK_RECONCILE_REMEDY.fixHint).toMatch(/Completed but never counted: .* so the day's count read low by that many\./)
  })

  it('a Salesforce read that fails is reported as unreconciled, never as a match, and is retried on the next run', async () => {
    const kv = fakeKv()
    const failing = deps({ kv, members: { [DAY]: ['a0X000000000001'] }, salesforce: new Error('Salesforce query failed (503)') })
    const s = await runClickPathChecks(failing.d)
    expect(s.subjects[0].reconcile).toMatchObject({ verdict: 'unmeasured' })
    expect((last(failing.pages, CLICK_RECONCILE_JOB) ?? [])[0]).toMatch(/could not be reconciled/)
    const retry = deps({ kv, members: { [DAY]: ['a0X000000000001'] }, salesforce: [{ id: 'a0X000000000001', at: at(18) }] })
    await runClickPathChecks(retry.d)
    expect(retry.sfCalls).toHaveLength(1)
  })
})

describe('the job run record', () => {
  it('is ok only when everything measured and agreed, and findings when anything paged', async () => {
    const quiet = await runClickPathChecks(deps().d)
    expect(endingOf(quiet).outcome).toBe('ok')
    const loud = await runClickPathChecks(deps({ sends: sendRuns('refused', 8) }).d)
    expect(endingOf(loud).outcome).toBe('findings')
  })

  it('a subject list that cannot be read is unmeasured and pages, never a quiet run', async () => {
    const { d, pages } = deps()
    const s = await runClickPathChecks({ ...d, listSubjects: async () => { throw new Error('workflows unreadable') } })
    expect(endingOf(s).outcome).toBe('unmeasured')
    expect((last(pages, CLICK_CHECK_ERRORS_JOB) ?? [])[0]).toMatch(/workflows unreadable/)
  })
})

/**
 * Each family's page says what its lines measured (#835). A family used to carry
 * one paragraph, so a line saying a read failed arrived under "a click sold
 * buyer is not being offered on many leads" or "refused most of the clicks".
 */
describe('the page wording follows what was measured (#835)', () => {
  const lastRemedy = (remedies: Record<string, AlertRemedy[]>, job: string) => remedies[job]?.[remedies[job].length - 1]

  it('a family whose only lines are reads that failed gets the unread wording, never the finding', async () => {
    const { d, remedies } = deps()
    d.readSendRuns = async () => { throw new Error('steps timed out') }
    await runClickPathChecks(d)
    expect(lastRemedy(remedies, CLICK_SEND_REFUSALS_JOB)).toBe(CLICK_PATH_UNREAD_REMEDY)
  })

  it('a profile that cannot be read is not called a path gone quiet', async () => {
    const { d, remedies } = deps({ buyer: new Error('db down') })
    await runClickPathChecks(d)
    expect(lastRemedy(remedies, CLICK_PATH_QUIET_JOB)).toBe(CLICK_PATH_UNREAD_REMEDY)
  })

  it('a subject list that cannot be read is not called a check that cannot answer', async () => {
    const { d, remedies } = deps()
    await runClickPathChecks({ ...d, listSubjects: async () => { throw new Error('workflows unreadable') } })
    expect(lastRemedy(remedies, CLICK_CHECK_ERRORS_JOB)).toBe(CLICK_PATH_UNREAD_REMEDY)
  })

  it('a real finding keeps its own wording', async () => {
    const runs = [...checkRuns('eligible', 20), ...checkRuns('cap_check_error', 6)]
    const { d, remedies } = deps({ checks: runs })
    await runClickPathChecks(d)
    expect(lastRemedy(remedies, CLICK_CHECK_ERRORS_JOB)).toBe(CLICK_CHECK_ERRORS_REMEDY)
  })

  it('a finding beside a failed read keeps the finding wording and adds the read fix', () => {
    const r = clickRemedyFor(CLICK_SEND_REFUSALS_JOB, 1, 1)
    expect(r.consequence).toContain(CLICK_SEND_REFUSALS_REMEDY.consequence.replace(/:$/, ''))
    expect(r.consequence).toMatch(/read failed/)
    expect(r.fixHint).toContain(CLICK_SEND_REFUSALS_REMEDY.fixHint)
    expect(r.fixHint).toContain(CLICK_PATH_UNREAD_REMEDY.fixHint)
  })

  it('says a refusal frees the claim for a later click, never that later clicks are not sent', () => {
    expect(CLICK_SEND_REFUSALS_REMEDY.consequence).not.toMatch(/later clicks on it are not sent|is final/)
    expect(CLICK_SEND_REFUSALS_REMEDY.consequence).toMatch(/later click on it is sent again/)
  })
})
