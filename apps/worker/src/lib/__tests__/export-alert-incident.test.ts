/**
 * The export alerter's incidents in the incident record (#2103, under #818).
 *
 * notifyExportFailure pages every Slack organization when an export job or a
 * scheduled check reports a problem, and a clean run clears its standing
 * condition without any all-clear message. Its own state cannot carry the
 * incident: the standing condition restarts its start whenever a different
 * problem is posted, and is cleared outright when a check wants a new problem
 * to post as new (click-path-checks), and the grace marker outlives the
 * failure on purpose (#1445). So the incident is kept the way every
 * alert-recovery check keeps one, under its own marker, opened on the first
 * delivered page and settled on the clean run.
 *
 * Slack is mocked; the KV is an in-memory map; every call is given its clock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({ sendExportFailureAlert: vi.fn() }))

import { notifyExportFailure, notifyExportRecovery, EXPORT_ALERT_SIGNAL } from '../export-alerts'
import { sendExportFailureAlert } from '../slack'
import { activeKey, recoveryKey } from '../alert-recovery'
import { clearCondition } from '../alert-backoff'
import { INCIDENT_OUTBOX_PREFIX } from '../incident-outbox'
import { outboxEvents, transitions } from './_incident-events'

const T0 = Date.parse('2026-06-26T13:00:00.000Z')
const MIN = 60_000
const H = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()
const JOB = 'Archive identity check'
const MARKER = `export-alert-recovery:${JOB}`
const PERMANENT = ['Snowflake 401 unauthorized']

function makeSupabase(orgIds: string[]) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then')
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: orgIds.map((organization_id) => ({ organization_id })), error: null }).then(resolve)
      return () => chain
    },
  })
  return { from: () => chain } as never
}

function makeKv() {
  const store = new Map<string, string>()
  const kv = {
    store,
    failOutbox: false,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: { expirationTtl?: number }) => {
      if (kv.failOutbox && k.startsWith(INCIDENT_OUTBOX_PREFIX)) throw new Error('KV put failed: 503')
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
  return kv
}

const fail = (kv: ReturnType<typeof makeKv>, now: number, errors = PERMANENT, orgs = ['org-1']) =>
  notifyExportFailure(makeSupabase(orgs), JOB, errors, kv, 'export-job', now)

beforeEach(() => {
  vi.mocked(sendExportFailureAlert).mockReset().mockResolvedValue(true)
})

describe('opening and paging', () => {
  it('names the alert-recovery marker the drain reads', () => {
    expect(recoveryKey(EXPORT_ALERT_SIGNAL, JOB)).toBe(MARKER)
  })

  it('opens the incident on the first delivered page and records one page, both from the call\'s clock', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`])
    const [opened, paged] = outboxEvents(kv.store)
    expect(opened).toMatchObject({ signal: 'export-alert', scope: 'platform', organizationId: null, subjectLabel: JOB, startedAt: iso(T0), at: iso(T0), windowMinutes: null })
    expect(paged).toMatchObject({ startedAt: iso(T0), at: iso(T0) })
    expect(kv.store.get(MARKER)).toBe(iso(T0))
  })

  it('records nothing for a first transient failure held back, since nothing was paged', async () => {
    const kv = makeKv()
    await fail(kv, T0, ['Snowflake 524: error code: 524'])
    expect(sendExportFailureAlert).not.toHaveBeenCalled()
    expect(transitions(kv.store)).toEqual([])
    expect(kv.store.has(MARKER)).toBe(false)
  })

  it('records nothing on a failing run the cooldown holds quiet, and keeps the running end for the record', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await fail(kv, T0 + H)
    await fail(kv, T0 + 2 * H)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`])
    expect(kv.store.get(activeKey(EXPORT_ALERT_SIGNAL, JOB))).toBe(iso(T0 + 2 * H))
  })

  it('records one page per delivered round however many organizations it reached', async () => {
    const kv = makeKv()
    await fail(kv, T0, PERMANENT, ['org-1', 'org-2', 'org-3'])
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(3)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`])
  })

  it('records nothing for a page Slack refused, since nobody was paged', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(false)
    const kv = makeKv()
    await fail(kv, T0, PERMANENT, ['org-1', 'org-2'])
    expect(transitions(kv.store)).toEqual([])
    expect(kv.store.has(MARKER)).toBe(false)
  })

  it('records a different problem posted while the first stands as another page of the same incident', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await fail(kv, T0 + H, ['permission denied for table lead_sightings'])
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(2)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`, `paged ${JOB}`])
    expect(outboxEvents(kv.store)[2]).toMatchObject({ startedAt: iso(T0), at: iso(T0 + H) })
  })

  it('keeps the incident open when a check clears the reminder schedule so its next problem posts as new', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await clearCondition(kv, `export-alert:${JOB}`)
    await fail(kv, T0 + H)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`, `paged ${JOB}`])
    expect(kv.store.get(MARKER)).toBe(iso(T0))
  })
})

describe('ending', () => {
  it('ends on the clean run as stood down by design, since the alerter sends no all-clear, with the last failing run as its end', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await fail(kv, T0 + H)
    await notifyExportFailure(makeSupabase(['org-1']), JOB, [], kv, 'export-job', T0 + 2 * H)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`, `ended ${JOB} stood_down_by_design`])
    expect(outboxEvents(kv.store)[2]).toMatchObject({ startedAt: iso(T0), at: iso(T0 + 2 * H), endedAt: iso(T0 + H) })
    expect(kv.store.has(MARKER)).toBe(false)
    expect(kv.store.has(activeKey(EXPORT_ALERT_SIGNAL, JOB))).toBe(false)
  })

  it('ends the same way through notifyExportRecovery, which the archive calls on its own', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await notifyExportRecovery(kv, JOB, T0 + H)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`, `ended ${JOB} stood_down_by_design`])
    expect(outboxEvents(kv.store)[2].at).toBe(iso(T0 + H))
  })

  it('records nothing, and writes nothing, for the clean run of a job with no incident', async () => {
    const kv = makeKv()
    await notifyExportRecovery(kv, JOB, T0)
    expect(transitions(kv.store)).toEqual([])
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('opens a fresh incident for a failure after the clean run', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    await notifyExportRecovery(kv, JOB, T0 + H)
    await fail(kv, T0 + 3 * H)
    expect(transitions(kv.store)).toEqual([`opened ${JOB}`, `paged ${JOB}`, `ended ${JOB} stood_down_by_design`, `opened ${JOB}`, `paged ${JOB}`])
    expect(kv.store.get(MARKER)).toBe(iso(T0 + 3 * H))
  })
})

describe('a recorder that fails', () => {
  it('does not stop the page or its cooldown', async () => {
    const kv = makeKv()
    kv.failOutbox = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await fail(kv, T0)
    const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n')
    errors.mockRestore()
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has(`export-alert:${JOB}:cooldown`)).toBe(true)
    expect(logged).toContain('event=incident_record_failed')
  })

  it('does not stop the page when the marker itself cannot be written', async () => {
    const kv = makeKv()
    kv.put.mockImplementation(async (k: string, v: string) => {
      if (k === MARKER) throw new Error('KV put failed: 503')
      kv.store.set(k, v)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await fail(kv, T0)
    errors.mockRestore()
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has(`export-alert:${JOB}:cooldown`)).toBe(true)
  })

  it('does not stop the clean run clearing the condition and stamping the grace marker', async () => {
    const kv = makeKv()
    await fail(kv, T0)
    kv.store.set(`export-alert-pending:${JOB}`, JSON.stringify({ since: iso(T0), recovered: false }))
    kv.failOutbox = true
    kv.delete.mockImplementation(async (k: string) => {
      if (k === MARKER) throw new Error('KV delete failed: 503')
      kv.store.delete(k)
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await notifyExportRecovery(kv, JOB, T0 + H)
    errors.mockRestore()
    expect(kv.store.has(`export-alert:${JOB}:condition`)).toBe(false)
    expect(JSON.parse(kv.store.get(`export-alert-pending:${JOB}`)!)).toMatchObject({ recovered: true })
  })
})
