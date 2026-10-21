/**
 * The cron heartbeat's incidents in the incident record (#2103, under #818).
 *
 * The heartbeat pages a job that went dark or never finished and, for the never
 * finished case, sends an all-clear (#2057). Neither goes through alert-recovery,
 * so until #2103 none of it reached the record. These tests hold the heartbeat
 * to the record's rules: an event on each real transition only (the first
 * delivered page, each delivered page round, the stand down), every event
 * stamped from the pass's one clock reading, and a recorder that fails never
 * standing in the way of a page or an all-clear.
 *
 * Slack is mocked; the KV is an in-memory map; the clock is the explicit `now`
 * each pass is given, far from the real time, so a second read of the real
 * clock shows as a mismatch (L524, #2115).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
  sendCronHeartbeatRecoveryAlert: vi.fn(async () => true),
  sendCronHeartbeatGroupAlert: vi.fn(async () => true),
  sendCronHeartbeatGroupRecoveryAlert: vi.fn(async () => true),
}))

import { sendCronHeartbeatAlert, sendCronHeartbeatRecoveryAlert } from '../slack'
import {
  runHeartbeatChecks,
  heartbeatKey,
  completedKey,
  completedWatchKey,
  alertedStatusKey,
  backoffKey,
  CRON_JOBS,
  cronJob,
  ALL_CLEAR_MAX_ATTEMPTS,
} from '../cron-heartbeat'
import { INCIDENT_OUTBOX_PREFIX } from '../incident-outbox'
import { incidentMarkerStart } from '../incident-signals'
import { outboxEvents, transitions } from './_incident-events'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

const NOW = Date.parse('2026-06-26T13:00:00.000Z')
const MIN = 60_000
const H = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const kv = {
    store,
    /** The job under test; every other job is kept fresh by run(). */
    subject: '',
    /** Make every incident outbox write fail, as a KV outage on that key would. */
    failOutbox: false,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      if (kv.failOutbox && k.startsWith(INCIDENT_OUTBOX_PREFIX)) throw new Error('KV put failed: 503')
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
  return kv as typeof kv & KVNamespace
}

function fakeSupabase(orgIds: string[]): SupabaseClient {
  const runs = {
    select: () => runs,
    eq: () => runs,
    not: () => runs,
    order: () => runs,
    limit: () => Promise.resolve({ data: [], error: null }),
  }
  return {
    from: (table: string) =>
      table === 'job_runs'
        ? runs
        : { select: () => alertRowListAnswer({ data: orgIds.map((organization_id) => ({ organization_id })), error: null }) },
  } as unknown as SupabaseClient
}

function allFresh(nowMs: number): Record<string, string> {
  return Object.fromEntries(CRON_JOBS.map((j) => [heartbeatKey(j.id), iso(nowMs - 1)]))
}

const archive = () => cronJob('execution-archive')
const daily = () => cronJob('daily-1300')

/** The archive started a run past its allowance and never finished it: the never finished page. */
function vanishedKv() {
  const started = NOW - archive().maxRunMs - 5 * MIN
  const kv = fakeKv({
    ...allFresh(NOW),
    [heartbeatKey(archive().id)]: iso(started),
    [completedWatchKey(archive().id)]: iso(NOW - 24 * H),
  })
  kv.subject = archive().id
  return { kv, started }
}

/** The daily batch's stamp is a day and a half old: the dark page. */
function staleKv() {
  const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey(daily().id)]: iso(NOW - 36 * H) })
  kv.subject = daily().id
  return kv
}

/** Every job but the one under test started and finished a moment ago, so only that one can page. */
function othersFresh(kv: ReturnType<typeof fakeKv>, now: number) {
  for (const j of CRON_JOBS) {
    if (j.id === kv.subject) continue
    kv.store.set(heartbeatKey(j.id), iso(now - 2))
    kv.store.set(completedKey(j.id), iso(now - 1))
  }
}

const eventsFor = (kv: ReturnType<typeof fakeKv>, subject: string) => outboxEvents(kv.store).filter((e) => e.subject === subject)
const run = (kv: ReturnType<typeof fakeKv>, now: number, orgs = ['org-1']) => {
  othersFresh(kv, now)
  return runHeartbeatChecks(fakeSupabase(orgs), kv, now)
}

beforeEach(() => {
  vi.mocked(sendCronHeartbeatAlert).mockReset().mockResolvedValue(true)
  vi.mocked(sendCronHeartbeatRecoveryAlert).mockReset().mockResolvedValue(true)
})

describe('opening and paging', () => {
  it('records the first delivered page as the incident opening, then one page, both from the pass\'s clock', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    expect(transitions(kv.store)).toEqual([`opened ${daily().id}`, `paged ${daily().id}`])
    const [opened, paged] = outboxEvents(kv.store)
    expect(opened).toMatchObject({ signal: 'cron-heartbeat', scope: 'platform', organizationId: null, subjectLabel: daily().label, startedAt: iso(NOW), at: iso(NOW), windowMinutes: null })
    expect(paged).toMatchObject({ startedAt: iso(NOW), at: iso(NOW) })
  })

  it('keeps the incident start in the paged status record, where the drain looks for it', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    const raw = kv.store.get(alertedStatusKey(daily().id))!
    expect(JSON.parse(raw)).toMatchObject({ incidentStartedAt: iso(NOW) })
    expect(incidentMarkerStart('cron-heartbeat', raw)).toBe(iso(NOW))
  })

  it('records nothing on a run the cooldown holds quiet, since a sighting is not a transition', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    const before = transitions(kv.store)
    await run(kv, NOW + MIN)
    await run(kv, NOW + 2 * MIN)
    expect(transitions(kv.store)).toEqual(before)
  })

  it('records one page per delivered round however many organizations it reached', async () => {
    const kv = staleKv()
    await run(kv, NOW, ['org-1', 'org-2', 'org-3'])
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(3)
    expect(transitions(kv.store)).toEqual([`opened ${daily().id}`, `paged ${daily().id}`])
  })

  it('records a reminder as another page of the same incident, never a second opening', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    // The cooldown has run out; the job is still dark.
    kv.store.delete(`${backoffKey(daily().id)}:cooldown`)
    await run(kv, NOW + 7 * H)
    expect(transitions(kv.store)).toEqual([`opened ${daily().id}`, `paged ${daily().id}`, `paged ${daily().id}`])
    expect(eventsFor(kv, daily().id).map((e) => e.startedAt)).toEqual([iso(NOW), iso(NOW), iso(NOW)])
    expect(eventsFor(kv, daily().id)[2].at).toBe(iso(NOW + 7 * H))
  })

  it('keeps the start when the status changes while the condition stands, and records the new page against it', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    // job_runs now vouches for the job: the same dark job is reported as unstamped, a new status, posted at once.
    const supabase = fakeSupabase(['org-1']) as unknown as { from: (t: string) => unknown }
    const runs = { select: () => runs, eq: () => runs, not: () => runs, order: () => runs, limit: () => Promise.resolve({ data: [{ finished_at: iso(NOW + 20 * MIN) }], error: null }) }
    const orgs = supabase.from('organizations')
    const vouching = { from: (t: string) => (t === 'job_runs' ? runs : orgs) } as unknown as SupabaseClient
    othersFresh(kv, NOW + 30 * MIN)
    await runHeartbeatChecks(vouching, kv, NOW + 30 * MIN)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(2)
    expect(transitions(kv.store)).toEqual([`opened ${daily().id}`, `paged ${daily().id}`, `paged ${daily().id}`])
    expect(JSON.parse(kv.store.get(alertedStatusKey(daily().id))!)).toMatchObject({ status: 'unstamped', at: iso(NOW + 30 * MIN), incidentStartedAt: iso(NOW) })
    expect(eventsFor(kv, daily().id)[2]).toMatchObject({ startedAt: iso(NOW), at: iso(NOW + 30 * MIN) })
  })

  it('records nothing for a page Slack refused, since nobody was paged', async () => {
    vi.mocked(sendCronHeartbeatAlert).mockResolvedValue(false)
    const kv = staleKv()
    await run(kv, NOW, ['org-1', 'org-2'])
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(2)
    expect(transitions(kv.store)).toEqual([])
    expect(kv.store.has(alertedStatusKey(daily().id))).toBe(false)
  })
})

describe('ending', () => {
  it('ends a never finished incident as an all-clear once it delivers, with the completion the all-clear reported', async () => {
    const { kv, started } = vanishedKv()
    await run(kv, NOW)
    const finished = started + archive().maxRunMs + 8 * MIN
    kv.store.set(completedKey(archive().id), iso(finished))
    await run(kv, NOW + MIN)
    expect(transitions(kv.store)).toEqual([`opened ${archive().id}`, `paged ${archive().id}`, `ended ${archive().id} all_clear`])
    const ended = eventsFor(kv, archive().id)[2]
    expect(ended).toMatchObject({ startedAt: iso(NOW), at: iso(NOW + MIN), endedAt: iso(finished) })
    expect(kv.store.has(alertedStatusKey(archive().id))).toBe(false)
  })

  it('records no end while the all-clear has not delivered and is being retried', async () => {
    const { kv } = vanishedKv()
    await run(kv, NOW)
    kv.store.set(completedKey(archive().id), iso(NOW + 30_000))
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockResolvedValue(false)
    await run(kv, NOW + MIN)
    await run(kv, NOW + 2 * MIN)
    expect(transitions(kv.store)).toEqual([`opened ${archive().id}`, `paged ${archive().id}`])
    // The record the drain reads still holds the start, retries and all.
    expect(incidentMarkerStart('cron-heartbeat', kv.store.get(alertedStatusKey(archive().id))!)).toBe(iso(NOW))
  })

  it('ends as stood down by design when it gives up after its tries with no all-clear delivered anywhere', async () => {
    const { kv } = vanishedKv()
    await run(kv, NOW)
    kv.store.set(completedKey(archive().id), iso(NOW + 30_000))
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockResolvedValue(false)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 1; i <= ALL_CLEAR_MAX_ATTEMPTS + 2; i++) await run(kv, NOW + i * MIN)
    errors.mockRestore()
    expect(transitions(kv.store)).toEqual([`opened ${archive().id}`, `paged ${archive().id}`, `ended ${archive().id} stood_down_by_design`])
    expect(eventsFor(kv, archive().id)[2].at).toBe(iso(NOW + ALL_CLEAR_MAX_ATTEMPTS * MIN))
  })

  it('ends as an all-clear when it gives up on one organization after another received it, as alert-recovery counts a delivery', async () => {
    const { kv } = vanishedKv()
    await run(kv, NOW, ['org-1', 'org-2'])
    kv.store.set(completedKey(archive().id), iso(NOW + 30_000))
    vi.mocked(sendCronHeartbeatRecoveryAlert).mockImplementation(async (_s, orgId) => orgId === 'org-1')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 1; i <= ALL_CLEAR_MAX_ATTEMPTS + 2; i++) await run(kv, NOW + i * MIN, ['org-1', 'org-2'])
    errors.mockRestore()
    expect(transitions(kv.store)).toEqual([`opened ${archive().id}`, `paged ${archive().id}`, `ended ${archive().id} all_clear`])
  })

  it('ends a dark job that came back as stood down by design, with no end time, since it sends no all-clear', async () => {
    const kv = staleKv()
    await run(kv, NOW)
    kv.store.set(heartbeatKey(daily().id), iso(NOW + 2 * H))
    await run(kv, NOW + 2 * H + MIN)
    expect(transitions(kv.store)).toEqual([`opened ${daily().id}`, `paged ${daily().id}`, `ended ${daily().id} stood_down_by_design`])
    expect(eventsFor(kv, daily().id)[2]).toMatchObject({ startedAt: iso(NOW), at: iso(NOW + 2 * H + MIN), endedAt: null })
    expect(kv.store.has(alertedStatusKey(daily().id))).toBe(false)
  })

  it('records nothing for a healthy job that was never paged', async () => {
    const kv = fakeKv(allFresh(NOW))
    await run(kv, NOW)
    await run(kv, NOW + MIN)
    expect(transitions(kv.store)).toEqual([])
  })
})

describe('a recorder that fails', () => {
  it('does not stop the page, its cooldown or its status record, and is counted in the result', async () => {
    const kv = staleKv()
    kv.failOutbox = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await run(kv, NOW)
    errors.mockRestore()
    const r = results.find((x) => x.jobId === daily().id)!
    expect(r.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has(`${backoffKey(daily().id)}:cooldown`)).toBe(true)
    expect(kv.store.has(alertedStatusKey(daily().id))).toBe(true)
    expect(r.recordErrors.length).toBe(2)
    expect(r.recordErrors[0]).toContain('opened cron-heartbeat daily-1300 not recorded')
  })

  it('does not stop the all-clear or the stand down', async () => {
    const { kv } = vanishedKv()
    await run(kv, NOW)
    kv.store.set(completedKey(archive().id), iso(NOW + 30_000))
    kv.failOutbox = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await run(kv, NOW + MIN)
    errors.mockRestore()
    expect(sendCronHeartbeatRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has(alertedStatusKey(archive().id))).toBe(false)
    expect(kv.store.has(`${backoffKey(archive().id)}:condition`)).toBe(false)
    expect(results.find((x) => x.jobId === archive().id)!.recordErrors).toHaveLength(1)
  })
})
