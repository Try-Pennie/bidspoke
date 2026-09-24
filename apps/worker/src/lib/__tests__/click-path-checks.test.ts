/**
 * The click buyer path checks (#1546), every 15 minutes. Each alert has a case
 * that fires it and a case that stays quiet, and every input (the clock, the
 * step rows, the offers, the click executions, the counter and Salesforce) is
 * injected, so nothing waits and nothing leaves the process.
 *
 *   check errors   a SHARE of the runs that reached buyer_click_check in the
 *                  last hour that could not complete, with a minimum
 *                  denominator, and saturation below it (L139, L716).
 *   quiet          inside the buyer's selling hours for the whole three hours,
 *                  leads reached the check and none was eligible; and offers
 *                  were made with no click execution at all.
 *   refusals       a burst of buyer_click_send refusals for one buyer.
 *   reconcile      once per Pacific day: the counted prospects against the
 *                  Salesforce prospects the click wrote Completed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LoadedBuyer } from '../buyer-profile-loader'
import {
  CHECK_ERROR_MIN_RUNS,
  CHECK_ERROR_SATURATION_MIN_RUNS,
  CLICK_CHECK_ERRORS_JOB,
  CLICK_PATH_CHECKS_JOB,
  CLICK_PATH_QUIET_JOB,
  CLICK_RECONCILE_JOB,
  CLICK_SEND_REFUSALS_JOB,
  NO_CLICK_MIN_OFFERS,
  QUIET_MIN_RUNS,
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
/** Tuesday 2027-09-21 21:00 UTC: 14:00 Pacific, 17:00 Eastern. The three hours before it are all inside 8am to 6pm Pacific. */
const NOW = Date.UTC(2027, 8, 21, 21, 0)
/** Mon to Fri 8am to 6pm Pacific, as Eastern minutes (the profile's clock). */
const WEEKDAYS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensMinute: 11 * 60, closesMinute: 21 * 60 }))

const SUBJECT: ClickSubject = {
  organization_id: ORG,
  partner_id: PARTNER,
  check: { workflow_ids: ['wf-engine'], namespaces: ['buyer_click_check'] },
  send: { workflow_ids: ['wf-click'], namespaces: ['click_send'] },
}

function buyer(over: Partial<LoadedBuyer['profile']> = {}): LoadedBuyer {
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
    updated_at: '2027-09-20T10:00:00.000Z',
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
  now?: number
  kv?: ReturnType<typeof fakeKv>
}

function deps(w: World = {}) {
  const pages: Record<string, string[][]> = {}
  const notify = (job: string) => async (lines: string[]) => { (pages[job] ??= []).push(lines) }
  const sfCalls: Array<{ routingCode: number; fromMs: number; toMs: number }> = []
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
  return { d, pages, sfCalls }
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

describe('quiet: zero eligible for three hours inside the selling hours', () => {
  const noneEligible = () => [...checkRuns('state_not_allowed', 20, 3 * HOUR, 'a'), ...checkRuns('missing_lead_field', 14, 3 * HOUR, 'b')]

  it('fires when leads kept reaching the check for three open hours and none was eligible, naming why', async () => {
    const { d, pages } = deps({ checks: noneEligible() })
    await runClickPathChecks(d)
    const lines = last(pages, CLICK_PATH_QUIET_JOB) ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/34 leads reached the Buyer Click Check/)
    expect(lines[0]).toMatch(/none was eligible/)
    expect(lines[0]).toMatch(/state_not_allowed 20/)
  })

  it('stays quiet when one lead in the three hours was eligible', async () => {
    const { d, pages } = deps({ checks: [...noneEligible(), ...checkRuns('eligible', 1, 3 * HOUR, 'e')], offers: [] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('stays quiet when the three hours were not all inside the selling hours (the window opened an hour ago)', async () => {
    // 16:00 UTC is 9am Pacific: the window opened at 8am, so the three hours reach back before it.
    const now = Date.UTC(2027, 8, 21, 16, 0)
    const runs = noneEligible().map((r, i) => ({ ...r, started_at: new Date(now - (i + 1) * 3 * MIN).toISOString() }))
    const { d, pages } = deps({ checks: runs, now })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet.verdict).toBe('not_open')
  })

  it('stays quiet when the day\'s cap was reached, because not eligible is then the cap working', async () => {
    const { d, pages } = deps({ checks: [...noneEligible(), ...checkRuns('daily_click_cap', 5, 3 * HOUR, 'c')] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('stays quiet below the minimum of leads, and does not count runs the disabled profile answered', async () => {
    const few = checkRuns('state_not_allowed', QUIET_MIN_RUNS - 1, 3 * HOUR)
    const { d, pages } = deps({ checks: [...few, ...checkRuns('profile_disabled', 50, 3 * HOUR, 'off')] })
    await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
  })

  it('is not judged for a buyer with no enabled profile, which is the switch being off', async () => {
    const { d, pages } = deps({ checks: noneEligible(), buyer: null })
    const s = await runClickPathChecks(d)
    expect(last(pages, CLICK_PATH_QUIET_JOB)).toEqual([])
    expect(s.subjects[0].quiet.verdict).toBe('not_enabled')
  })

  it('a profile that cannot be read leaves the quiet check unmeasured, never clean', async () => {
    const { d } = deps({ checks: noneEligible(), buyer: new Error('db down') })
    const s = await runClickPathChecks(d)
    expect(s.subjects[0].quiet).toMatchObject({ verdict: 'unmeasured' })
    expect(endingOf(s).outcome).toBe('unmeasured')
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
