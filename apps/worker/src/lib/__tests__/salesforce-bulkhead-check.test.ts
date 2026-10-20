import { describe, it, expect, vi } from 'vitest'
import {
  OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT,
  SALESFORCE_BULKHEAD_CHECK_JOB,
  SALESFORCE_BULKHEAD_SIGNAL,
  SALESFORCE_BULKHEAD_SUBJECT,
  runSalesforceBulkheadCheck,
  type SalesforceBulkheadCheckDeps,
} from '../salesforce-bulkhead-check'
import { recoveryKey } from '../alert-recovery'
import { salesforceBulkheadLimit } from '../bulkhead-client'
import { incidentSignal } from '../incident-signals'
import { cronJob } from '../cron-heartbeat'
import { salesforceBulkheadLimitMessage } from '../slack'
import type { Env } from '../../index'

/**
 * #2336 phase 6 item 5: the daily check that the Salesforce bulkhead limit
 * still resolves to the 20 Dan's ops Salesforce lane decision was sized
 * against, and pages every organization when it does not.
 */
const NOW = Date.parse('2026-10-20T13:00:00.000Z')
const DAY = 24 * 60 * 60_000
/** The long dashes, and a hyphen standing alone between spaces, built from char codes. */
const DASH_PUNCTUATION = new RegExp(`[\\u2014\\u2013]|\\s${String.fromCharCode(45)}\\s`)

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

type Kv = ReturnType<typeof memoryKv>

function deps(over: Partial<Omit<SalesforceBulkheadCheckDeps, 'kv'>> & { limit?: number; kv?: Kv } = {}) {
  const kv = over.kv ?? memoryKv()
  const sendAlert = over.sendAlert ?? vi.fn(async () => true)
  const sendRecovery = over.sendRecovery ?? vi.fn(async () => true)
  const d: SalesforceBulkheadCheckDeps = {
    resolvedLimit: () => over.limit ?? 20,
    orgsToTell: async () => ['org-one', 'org-two'],
    now: () => NOW,
    ...over,
    kv,
    sendAlert,
    sendRecovery,
  }
  return { d, kv, sendAlert: vi.mocked(sendAlert), sendRecovery: vi.mocked(sendRecovery) }
}

const marker = (kv: Kv) => kv.store.get(recoveryKey(SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT))

describe('the value the ops lane was sized against', () => {
  it('is 20, the bulkhead limit recorded with Dan\'s lane decision on #2336', () => {
    expect(OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT).toBe(20)
  })

  it('is what an unset SALESFORCE_BULKHEAD_LIMIT resolves to today, so the check is quiet as deployed', () => {
    expect(salesforceBulkheadLimit({} as Env)).toBe(OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT)
    expect(salesforceBulkheadLimit({ SALESFORCE_BULKHEAD_LIMIT: '24' } as Env)).toBe(24)
  })

  it('has a heartbeat entry and an incident signal of its own', () => {
    expect(cronJob(SALESFORCE_BULKHEAD_CHECK_JOB)).toMatchObject({ triggerCron: '0 13 * * *' })
    expect(incidentSignal(SALESFORCE_BULKHEAD_SIGNAL)).toMatchObject({ scope: 'platform', subject: 'name', windowMinutes: null, label: 'Salesforce bulkhead limit' })
  })
})

describe('runSalesforceBulkheadCheck', () => {
  it('is quiet when the limit resolves to 20, and arms nothing', async () => {
    const { d, kv, sendAlert, sendRecovery } = deps()
    const s = await runSalesforceBulkheadCheck(d)
    expect(s).toMatchObject({ limit: 20, verdict: 'matches', paged: 0 })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(sendRecovery).not.toHaveBeenCalled()
    expect(marker(kv)).toBeUndefined()
  })

  it.each([24, 19])('pages every organization when the limit resolves to %i, naming both numbers', async (limit) => {
    const { d, kv, sendAlert } = deps({ limit })
    const s = await runSalesforceBulkheadCheck(d)
    expect(s).toMatchObject({ limit, verdict: 'differs', paged: 2 })
    expect(sendAlert.mock.calls.map((c) => c[0])).toEqual(['org-one', 'org-two'])
    expect(sendAlert.mock.calls[0][1]).toEqual({ limit, sizedFor: 20, firstReportedAt: null })
    // The incident is opened on the delivered page, and the page is recorded.
    expect(marker(kv)).toBe(new Date(NOW).toISOString())
  })

  it('says when it was first reported on the next day\'s page', async () => {
    const first = deps({ limit: 24 })
    await runSalesforceBulkheadCheck(first.d)
    const next = deps({ limit: 24, kv: first.kv, now: () => NOW + DAY })
    await runSalesforceBulkheadCheck(next.d)
    expect(next.sendAlert.mock.calls[0][1]).toMatchObject({ firstReportedAt: new Date(NOW).toISOString() })
    // The start never moves.
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
  })

  it('arms nothing when no page reached Slack, so the all clear never follows an unseen page', async () => {
    const { d, kv } = deps({ limit: 24, sendAlert: vi.fn(async () => false) })
    const s = await runSalesforceBulkheadCheck(d)
    expect(s.paged).toBe(0)
    expect(marker(kv)).toBeUndefined()
  })

  it('says nobody could be told when the organization list cannot be read, never reading it as quiet', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { d, sendAlert } = deps({ limit: 24, orgsToTell: async () => null })
    const s = await runSalesforceBulkheadCheck(d)
    expect(s).toMatchObject({ verdict: 'differs', paged: 0, toldNobody: true })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(error.mock.calls.flat().join(' ')).toMatch(/salesforce-bulkhead-check.*24.*nobody could be told/)
    error.mockRestore()
  })

  it('one organization whose page throws does not stop the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sendAlert = vi.fn(async (orgId: string) => {
      if (orgId === 'org-one') throw new Error('slack is down')
      return true
    })
    const { d, kv } = deps({ limit: 24, sendAlert })
    const s = await runSalesforceBulkheadCheck(d)
    expect(s.paged).toBe(1)
    expect(marker(kv)).toBeDefined()
    error.mockRestore()
  })

  it('sends the all clear once the limit is back to 20, and closes the incident', async () => {
    const first = deps({ limit: 24 })
    await runSalesforceBulkheadCheck(first.d)
    const next = deps({ limit: 20, kv: first.kv, now: () => NOW + DAY })
    const s = await runSalesforceBulkheadCheck(next.d)
    expect(s).toMatchObject({ verdict: 'matches', allClear: true })
    expect(next.sendRecovery).toHaveBeenCalledTimes(2)
    expect(marker(first.kv)).toBeUndefined()
  })

  it('keeps the incident open when the all clear reaches nobody', async () => {
    const first = deps({ limit: 24 })
    await runSalesforceBulkheadCheck(first.d)
    const next = deps({ limit: 20, kv: first.kv, now: () => NOW + DAY, sendRecovery: vi.fn(async () => false) })
    const s = await runSalesforceBulkheadCheck(next.d)
    expect(s.allClear).toBe(false)
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
  })
})

describe('the page', () => {
  it('says what changed and what to do, in plain sentences with no dashes', () => {
    const m = salesforceBulkheadLimitMessage({ limit: 24, sizedFor: 20, firstReportedAt: null })
    expect(m.title).toBe('The Salesforce bulkhead limit has changed')
    const text = m.sections.join('\n')
    expect(text).toContain('24')
    expect(text).toContain('20')
    expect(text).toContain('SALESFORCE_BULKHEAD_LIMIT')
    expect(text).toContain('OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT')
    expect(text).not.toMatch(DASH_PUNCTUATION)
    expect(text).not.toMatch(/First reported/)
  })

  it('names when it was first reported on a repeat', () => {
    const m = salesforceBulkheadLimitMessage({ limit: 24, sizedFor: 20, firstReportedAt: new Date(NOW).toISOString() })
    expect(m.sections.join('\n')).toMatch(/First reported/)
  })
})
