/**
 * What a delivery site records about a page it tried to send (#3056).
 *
 * Before this, a site recorded only a page that reached Slack (recordPaged,
 * called inside its `if (sent)`), so a page that was due but refused left
 * nothing behind: no row in alert_incidents, and a job run still recorded ok.
 * Four Lead Economy shifts went unpaged that way while Slack refused every
 * Worker alert (2026-10-23 and 26, #2808), and nothing recorded that they were
 * missed. Now every site hands the send's answer to recordPageOutcome, which
 * records either the page or that it did not reach Slack.
 *
 * Every test drives the KV directly and passes its own clock (L524).
 */
import { describe, expect, it, vi } from 'vitest'
import { dueKey, markAlerted, recordPageOutcome, recordPageOutcomeOn, recoveryKey, RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { INCIDENT_OUTBOX_PREFIX, parseIncidentEvent, type IncidentContext, type IncidentEvent } from '../incident-outbox'

const MIN = 60_000
const T0 = Date.parse('2026-10-23T15:00:00.000Z')
const ORG_ID = '11111111-1111-4111-8111-111111111111'
const ORG: IncidentContext = { scope: { kind: 'org', organizationId: ORG_ID }, subjectLabel: 'Lead Economy' }
const SIGNAL = 'lead-validation-rejection-rate' as const
const WF = '89b1a6af-7e0f-43de-bc66-1e888184551f'

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    put: vi.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve() }),
    delete: vi.fn((k: string) => { store.delete(k); return Promise.resolve() }),
  }
}

function events(kv: ReturnType<typeof fakeKv>): IncidentEvent[] {
  return [...kv.store.entries()]
    .filter(([k]) => k.startsWith(INCIDENT_OUTBOX_PREFIX))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => {
      const parsed = parseIncidentEvent(v)
      if ('error' in parsed) throw new Error(parsed.error)
      return parsed
    })
}

const iso = (ms: number) => new Date(ms).toISOString()

describe('recordPageOutcome: a page that reached Slack', () => {
  it('records the page against the open incident, as before', async () => {
    const kv = fakeKv({ [recoveryKey(SIGNAL, WF)]: iso(T0) })
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0 + MIN, true)
    expect(events(kv)).toEqual([expect.objectContaining({ type: 'paged', subject: WF, startedAt: iso(T0), at: iso(T0 + MIN) })])
  })

  it('reports rather than guesses when no incident is open to page about', async () => {
    const kv = fakeKv()
    const onRecordError = vi.fn()
    await recordPageOutcome(kv, SIGNAL, WF, { ...ORG, onRecordError }, T0, true)
    expect(events(kv)).toEqual([])
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('no open incident'))
  })

  it('ends the stretch of pages nobody received, so a later refusal starts a new one', async () => {
    const kv = fakeKv()
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0, false)
    expect(kv.store.has(dueKey(SIGNAL, WF))).toBe(true)
    await markAlerted(kv, SIGNAL, WF, ORG, T0 + 60 * MIN)
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0 + 60 * MIN, true)
    expect(kv.store.has(dueKey(SIGNAL, WF))).toBe(false)
  })
})

describe('recordPageOutcome: a page that did not reach Slack', () => {
  it('counts it against the open incident when one was already paged', async () => {
    const kv = fakeKv({ [recoveryKey(SIGNAL, WF)]: iso(T0) })
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0 + 3 * 60 * MIN, false)
    expect(events(kv)).toEqual([expect.objectContaining({ type: 'undelivered', startedAt: iso(T0), at: iso(T0 + 3 * 60 * MIN), unannounced: false })])
    expect(kv.store.has(dueKey(SIGNAL, WF))).toBe(false)
  })

  it('keeps the incident that was due when no page about it reached anyone, without opening the marker an all-clear is owed for', async () => {
    const kv = fakeKv()
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0, false)
    expect(events(kv)).toEqual([expect.objectContaining({ type: 'undelivered', signal: SIGNAL, subject: WF, startedAt: iso(T0), at: iso(T0), unannounced: true, organizationId: ORG_ID, subjectLabel: 'Lead Economy' })])
    // The marker means somebody was told: page wording and the all-clear read it.
    expect(kv.store.has(recoveryKey(SIGNAL, WF))).toBe(false)
  })

  it('holds the hourly refusals of one shift as one incident, as the 2026-10-23 Lead Economy pages were', async () => {
    const kv = fakeKv()
    for (const h of [0, 1, 2]) await recordPageOutcome(kv, SIGNAL, WF, ORG, T0 + h * 60 * MIN, false, { sameIncidentWithinMinutes: 120 })
    const all = events(kv)
    expect(all.map((e) => e.type)).toEqual(['undelivered', 'undelivered', 'undelivered'])
    expect(new Set(all.map((e) => e.startedAt))).toEqual(new Set([iso(T0)]))
    expect(all.map((e) => e.at)).toEqual([iso(T0), iso(T0 + 60 * MIN), iso(T0 + 120 * MIN)])
  })

  it('records a check paged from every lead at most once a minute while Slack refuses it', async () => {
    const kv = fakeKv()
    for (let s = 0; s < 90; s += 5) await recordPageOutcome(kv, 'lead-validation-config', `${WF}:validate`, ORG, T0 + s * 1000, false)
    expect(events(kv).map((e) => e.at)).toEqual([iso(T0), iso(T0 + 60_000)])
    expect(new Set(events(kv).map((e) => e.startedAt))).toEqual(new Set([iso(T0)]))
  })

  it('starts a new incident once the last refused page is further back than the re-arm window', async () => {
    const kv = fakeKv()
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0, false)
    await recordPageOutcome(kv, SIGNAL, WF, ORG, T0 + (RECOVERY_REARM_MINUTES + 1) * MIN, false)
    expect(events(kv).map((e) => e.startedAt)).toEqual([iso(T0), iso(T0 + (RECOVERY_REARM_MINUTES + 1) * MIN)])
  })

  it('still records the refusal, from now, when the record of earlier refusals cannot be read', async () => {
    const kv = fakeKv()
    kv.get.mockImplementation((k: string) => (k === dueKey(SIGNAL, WF) ? Promise.reject(new Error('KV 503')) : Promise.resolve(kv.store.get(k) ?? null)))
    const onRecordError = vi.fn()
    await recordPageOutcome(kv, SIGNAL, WF, { ...ORG, onRecordError }, T0, false)
    expect(events(kv)).toEqual([expect.objectContaining({ type: 'undelivered', startedAt: iso(T0), unannounced: true })])
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('KV 503'))
  })

  it('never throws when KV refuses every write, and says so', async () => {
    const kv = fakeKv()
    kv.put.mockRejectedValue(new Error('KV write refused'))
    const onRecordError = vi.fn()
    await expect(recordPageOutcome(kv, SIGNAL, WF, { ...ORG, onRecordError }, T0, false)).resolves.toBeUndefined()
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('KV write refused'))
  })

  it('records nothing it cannot place when the marker cannot be read', async () => {
    const kv = fakeKv()
    kv.get.mockRejectedValue(new Error('KV 503'))
    const onRecordError = vi.fn()
    await recordPageOutcome(kv, SIGNAL, WF, { ...ORG, onRecordError }, T0, false)
    expect(events(kv)).toEqual([])
    expect(onRecordError).toHaveBeenCalledWith(expect.stringMatching(/undelivered .* not recorded: the marker could not be read: KV 503/))
  })
})

describe('recordPageOutcomeOn: a check that keeps its incident in its own state', () => {
  it('takes the open incident\'s start from the caller', async () => {
    const kv = fakeKv()
    await recordPageOutcomeOn(kv, 'cron-heartbeat', 'archive', iso(T0), { scope: { kind: 'platform' }, subjectLabel: 'archive' }, T0 + MIN, false)
    expect(events(kv)).toEqual([expect.objectContaining({ type: 'undelivered', signal: 'cron-heartbeat', startedAt: iso(T0), unannounced: false })])
    await recordPageOutcomeOn(kv, 'cron-heartbeat', 'archive', iso(T0), { scope: { kind: 'platform' }, subjectLabel: 'archive' }, T0 + 2 * MIN, true)
    expect(events(kv).map((e) => e.type)).toEqual(['undelivered', 'paged'])
  })
})

describe('parseIncidentEvent: the undelivered event', () => {
  it('refuses an undelivered event that does not say whether an incident was open', () => {
    const raw = JSON.stringify({ v: 1, id: 'e1', type: 'undelivered', signal: SIGNAL, subject: WF, subjectLabel: null, scope: 'org', organizationId: ORG_ID, startedAt: iso(T0), at: iso(T0), windowMinutes: 120 })
    expect(parseIncidentEvent(raw)).toEqual({ error: 'an undelivered page must say whether an incident was open' })
    expect(parseIncidentEvent(JSON.stringify({ ...JSON.parse(raw), unannounced: true }))).toMatchObject({ type: 'undelivered', unannounced: true })
  })
})
