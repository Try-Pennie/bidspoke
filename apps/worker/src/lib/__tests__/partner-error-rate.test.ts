/**
 * The partner ping failure page (#2582).
 *
 * Since #2582 a LendSwift failure ends the lead as a completed no bid, with
 * `lendswift_error` on the ping_lendswift step, so the failure saturation page
 * can no longer see a LendSwift outage. These tests hold the bar to the measured
 * spread it was set from, and drive the check itself through a page, a held
 * repeat, an all-clear and the cases that must do neither.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../slack', () => ({
  sendPartnerErrorRateAlert: vi.fn().mockResolvedValue('ts-1'),
  getSlackConnection: vi.fn(),
  sendRecoveryAlert: vi.fn(),
}))
import {
  ERROR_SHARE,
  MIN_ERRORS,
  MIN_PINGS,
  PARTNER_ERROR_WATCHES,
  judgePartnerErrors,
  runPartnerErrorRateCheck,
  type PingRow,
} from '../partner-error-rate'
import { getSlackConnection, sendPartnerErrorRateAlert, sendRecoveryAlert } from '../slack'
import { CRON_JOBS } from '../cron-heartbeat'
import { transitions } from './_incident-events'

const answered = (n: number): PingRow[] => new Array(n).fill(0).map(() => ({ kind: null }))
const failed = (n: number, kind = 'http_error'): PingRow[] => new Array(n).fill(0).map(() => ({ kind }))

describe('judgePartnerErrors(): the bar, against the spread it was set from', () => {
  it('pages on the 2026-10-21 windows: 20 of 20, and 15 of 20', () => {
    expect(judgePartnerErrors(failed(20)).state).toBe('spiking')
    expect(judgePartnerErrors([...failed(15), ...answered(5)]).state).toBe('spiking')
  })

  it('stays quiet on the worst normal windows of the 7 days before: 1 of 19, and 2 failures in a busy window', () => {
    expect(judgePartnerErrors([...failed(1), ...answered(18)]).state).toBe('healthy')
    expect(judgePartnerErrors([...failed(2), ...answered(36)]).state).toBe('healthy')
  })

  it('needs MIN_ERRORS failures, however high the share', () => {
    expect(MIN_ERRORS).toBe(5)
    expect(judgePartnerErrors([...failed(4), ...answered(6)]).state).toBe('healthy')
    expect(judgePartnerErrors([...failed(5), ...answered(5)]).state).toBe('spiking')
  })

  it('needs ERROR_SHARE of the pings, however many failures', () => {
    expect(ERROR_SHARE).toBe(0.25)
    expect(judgePartnerErrors([...failed(9), ...answered(28)]).state).toBe('healthy')
    expect(judgePartnerErrors([...failed(9), ...answered(27)]).state).toBe('spiking')
  })

  it('does not judge fewer than MIN_PINGS pings, even all failed', () => {
    expect(MIN_PINGS).toBe(10)
    expect(judgePartnerErrors(failed(9))).toEqual({ state: 'unjudged', pings: 9, errors: 9 })
    expect(judgePartnerErrors([]).state).toBe('unjudged')
  })

  it('counts each kind the script records', () => {
    const v = judgePartnerErrors([...failed(4, 'http_error'), ...failed(2, 'timeout'), ...answered(4)])
    expect(v).toEqual({ state: 'spiking', pings: 10, errors: 6, kinds: { http_error: 4, timeout: 2 } })
  })
})

describe('the watch and its heartbeat', () => {
  it('watches RML LendSwift\'s ping_lendswift for the marker the script writes', () => {
    expect(PARTNER_ERROR_WATCHES).toEqual([
      { workflowId: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914', namespace: 'ping_lendswift', marker: 'lendswift_error', partner: 'LendSwift' },
    ])
  })

  it('is a watched minute job, so a dark or failing check pages as itself', () => {
    const job = CRON_JOBS.find((j) => j.id === 'partner-error-rate')
    expect(job?.triggerCron).toBe('* * * * *')
    expect(job?.completionDroughtMs).toBeGreaterThan(0)
  })
})

describe('runPartnerErrorRateCheck', () => {
  const WF = PARTNER_ERROR_WATCHES[0].workflowId
  const ORG = '25822582-2582-4582-8582-258225822582'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }
  const URL = 'https://app.example.com'
  const wf = { id: WF, name: 'RML - Bidding Workflow (LendSwift)', organization_id: ORG, slack_channel: null }

  function makeKv(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial))
    return {
      store: m,
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
      delete: vi.fn(async (k: string) => { m.delete(k) }),
    }
  }

  /** Chainable Supabase double; awaiting any chain resolves the table's rows, or its error. */
  function makeSupabase(tables: Record<string, unknown[] | { error: string }>) {
    const selects: Record<string, string[]> = {}
    return {
      selects,
      from: (table: string) => {
        const entry = tables[table] ?? []
        const result = Array.isArray(entry) ? { data: entry, error: null } : { data: null, error: { message: entry.error } }
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
            if (prop === 'select') return (cols: string) => { (selects[table] ??= []).push(cols); return chain }
            return () => chain
          },
        })
        return chain
      },
    }
  }

  const db = (pings: PingRow[]) => makeSupabase({ service_connections: [{ organization_id: ORG }], workflows: [wf], execution_steps: pings })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    vi.mocked(sendPartnerErrorRateAlert).mockResolvedValue('ts-1')
  })

  it('pages once for an outage, opening the incident, and holds the repeat behind the cooldown', async () => {
    const kv = makeKv()
    const supabase = db([...failed(18, 'http_error'), ...failed(2, 'timeout'), ...answered(7)])
    const first = await runPartnerErrorRateCheck(supabase as never, kv as never, URL)
    expect(first.paged).toEqual([WF])
    expect(sendPartnerErrorRateAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendPartnerErrorRateAlert).mock.calls[0][3]).toMatchObject({
      workflow_id: WF, partner: 'LendSwift', error_count: 20, ping_count: 27, kinds: { http_error: 18, timeout: 2 }, window_minutes: 5,
    })
    expect(transitions(kv.store)).toEqual([`opened ${WF}`, `paged ${WF}`])
    expect(kv.store.has(`partner-error-rate-cooldown:${WF}`)).toBe(true)

    const second = await runPartnerErrorRateCheck(supabase as never, kv as never, URL)
    expect(second.paged).toEqual([])
    expect(sendPartnerErrorRateAlert).toHaveBeenCalledTimes(1)
  })

  it('reads only the marker\'s kind from the step output, never what the partner said', async () => {
    const supabase = db(answered(12))
    await runPartnerErrorRateCheck(supabase as never, makeKv() as never, URL)
    expect(supabase.selects.execution_steps).toEqual(['id, kind:output->lendswift_error->>kind'])
  })

  it('sends the all-clear once pings are answered again, past the re-arm window', async () => {
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const lastSeen = new Date(Date.now() - 45 * 60_000).toISOString()
    const kv = makeKv({
      [`partner-error-rate-recovery:${WF}`]: alertedAt,
      [`partner-error-rate-active:${WF}`]: lastSeen,
      [`partner-error-rate-cooldown:${WF}`]: '1',
    })
    const out = await runPartnerErrorRateCheck(db([...failed(1), ...answered(30)]) as never, kv as never, URL)
    expect(out.allClear).toEqual([WF])
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({
      signal: 'partner error', subject: wf.name, alertedAt, endedAt: lastSeen, recoveredPhrase: 'is getting answers from LendSwift again',
    })
    expect(kv.store.has(`partner-error-rate-recovery:${WF}`)).toBe(false)
    expect(kv.store.has(`partner-error-rate-cooldown:${WF}`)).toBe(false)
  })

  it('holds the all-clear while too few pings arrive to judge, and keeps the incident open', async () => {
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({ [`partner-error-rate-recovery:${WF}`]: alertedAt })
    const out = await runPartnerErrorRateCheck(db(answered(3)) as never, kv as never, URL)
    expect(out.judged).toEqual([{ workflowId: WF, state: 'unjudged', pings: 3, errors: 0 }])
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(sendPartnerErrorRateAlert).not.toHaveBeenCalled()
    expect(kv.store.get(`partner-error-rate-recovery:${WF}`)).toBe(alertedAt)
  })

  it('does not page a few failures among many answers', async () => {
    const out = await runPartnerErrorRateCheck(db([...failed(2), ...answered(40)]) as never, makeKv() as never, URL)
    expect(out.judged).toEqual([{ workflowId: WF, state: 'healthy', pings: 42, errors: 2 }])
    expect(sendPartnerErrorRateAlert).not.toHaveBeenCalled()
  })

  it('judges nothing when the workflow is not active in an organization with Slack', async () => {
    const supabase = makeSupabase({ service_connections: [{ organization_id: ORG }], workflows: [], execution_steps: failed(30) })
    const out = await runPartnerErrorRateCheck(supabase as never, makeKv() as never, URL)
    expect(out.judged).toEqual([])
    expect(sendPartnerErrorRateAlert).not.toHaveBeenCalled()
  })

  it('throws when the pings cannot be read, so the job counts a failed run instead of a quiet partner', async () => {
    const supabase = makeSupabase({ service_connections: [{ organization_id: ORG }], workflows: [wf], execution_steps: { error: 'canceling statement due to statement timeout' } })
    await expect(runPartnerErrorRateCheck(supabase as never, makeKv() as never, URL)).rejects.toThrow(/partner-error-rate ping_lendswift query failed: canceling statement/)
    expect(sendPartnerErrorRateAlert).not.toHaveBeenCalled()
  })

  it('starts no cooldown when the page did not reach Slack, so the next minute tries again', async () => {
    vi.mocked(sendPartnerErrorRateAlert).mockResolvedValueOnce(null)
    const kv = makeKv()
    const out = await runPartnerErrorRateCheck(db(failed(20)) as never, kv as never, URL)
    expect(out.paged).toEqual([])
    expect(kv.store.has(`partner-error-rate-cooldown:${WF}`)).toBe(false)
    await runPartnerErrorRateCheck(db(failed(20)) as never, kv as never, URL)
    expect(sendPartnerErrorRateAlert).toHaveBeenCalledTimes(2)
  })
})
