import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BACKLOG_STATE_KEY,
  WRITEBACK_BACKLOG_JOB,
  WRITEBACK_BACKLOG_MAX_AGE_MS,
  WRITEBACK_BACKLOG_READ_DEADLINE_MS,
  WRITEBACK_BACKLOG_READ_LIMIT,
  WRITEBACK_BACKLOG_SIGNAL,
  judgeBacklog,
  readWritebackBacklog,
  runWritebackBacklogCheck,
  type BacklogDeps,
  type BacklogReading,
  type OrgBacklog,
} from '../writeback-backlog'
import { recoveryKey } from '../alert-recovery'
import { cronJob, evaluateHeartbeat } from '../cron-heartbeat'
import { incidentSignal } from '../incident-signals'
import { WRITEBACK_BACKLOG_RECOVERY_SUBJECT } from '../slack'
import { outboxEvents, transitions } from './_incident-events'

/**
 * The backlog alert on outcome_writeback_deadletters (#468 step 2). The table
 * has never held a row in production (0 inserts at 2026-10-16), so every
 * behaviour here is proven on readings the test builds, never on a real row.
 */

const NOW = Date.parse('2026-10-15T18:00:00.000Z')
const MIN = 60_000
const ORG_A = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const ORG_B = '7e2f9c10-3b6d-4f55-8c2a-5a9e0d3b6c22'
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

const org = (count: number, oldestAgeMs: number, objects: Record<string, number> = { Prospect__c: count }): OrgBacklog => ({
  count,
  oldestAt: iso(NOW - oldestAgeMs),
  objects,
})

const reading = (byOrg: Record<string, OrgBacklog>, partial = false): BacklogReading => ({ ok: true, partial, byOrg: new Map(Object.entries(byOrg)) })

function harness(kv = fakeKv()) {
  const sendAlert = vi.fn(async () => true)
  const sendRecovery = vi.fn(async () => true)
  const notifyReadFailure = vi.fn(async () => {})
  const notifyReadRecovered = vi.fn(async () => {})
  const run = (r: BacklogReading, at = NOW) => {
    const deps: BacklogDeps = { kv, read: async () => r, sendAlert, sendRecovery, notifyReadFailure, notifyReadRecovered, now: () => at }
    return runWritebackBacklogCheck(deps)
  }
  return { kv, sendAlert, sendRecovery, notifyReadFailure, notifyReadRecovered, run }
}

describe('judgeBacklog: the age and growth predicates', () => {
  it('calls a backlog aged once its oldest row is older than the threshold, and not at it', () => {
    expect(judgeBacklog(org(1, WRITEBACK_BACKLOG_MAX_AGE_MS + 1), null, NOW).aged).toBe(true)
    expect(judgeBacklog(org(1, WRITEBACK_BACKLOG_MAX_AGE_MS), null, NOW).aged).toBe(false)
    expect(judgeBacklog(org(1, 2 * MIN), null, NOW).aged).toBe(false)
  })

  it('pages on an oldest time it cannot read, rather than calling it young (L50)', () => {
    expect(judgeBacklog({ count: 1, oldestAt: 'not a time' }, null, NOW)).toMatchObject({ aged: true, ageMs: null })
  })

  it('calls a backlog growing only when it stood at the last check and is larger now', () => {
    expect(judgeBacklog(org(3, MIN), 2, NOW).growing).toBe(true)
    expect(judgeBacklog(org(2, MIN), 2, NOW).growing).toBe(false)
    expect(judgeBacklog(org(1, MIN), 2, NOW).growing).toBe(false)
    // A first arrival is not growth: the next check is.
    expect(judgeBacklog(org(5, MIN), 0, NOW).growing).toBe(false)
    // No previous reading is no baseline, so nothing is claimed about growth.
    expect(judgeBacklog(org(5, MIN), null, NOW).growing).toBe(false)
  })

  it('takes its threshold from when a row could first be acted on, which is at once', () => {
    expect(WRITEBACK_BACKLOG_MAX_AGE_MS).toBe(30 * MIN)
  })
})

describe('runWritebackBacklogCheck', () => {
  it('pages the organization whose oldest pending write is past the threshold, and opens its incident', async () => {
    const h = harness()
    const s = await h.run(reading({ [ORG_A]: org(2, 45 * MIN, { Prospect__c: 1, Lead: 1 }) }))
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    const [orgId, alert] = h.sendAlert.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(orgId).toBe(ORG_A)
    expect(alert).toMatchObject({ count: 2, aged: true, growing: null, partial: false, oldestAt: iso(NOW - 45 * MIN) })
    expect(alert.objects).toEqual([{ object: 'Lead', count: 1 }, { object: 'Prospect__c', count: 1 }])
    expect(s.paged).toEqual([ORG_A])
    expect(transitions(h.kv.store)).toEqual([`opened ${ORG_A}`, `paged ${ORG_A}`])
    // The record names the subject in the all-clear's own words, for that organization.
    expect(outboxEvents(h.kv.store).map((e) => [e.subjectLabel, e.organizationId])).toEqual([
      [WRITEBACK_BACKLOG_RECOVERY_SUBJECT, ORG_A],
      [WRITEBACK_BACKLOG_RECOVERY_SUBJECT, ORG_A],
    ])
    expect(h.kv.store.get(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(iso(NOW))
  })

  it('pages an organization whose pending count grew since the last check, though every row is young', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(2, 6 * MIN) }), NOW - 5 * MIN)
    expect(h.sendAlert).not.toHaveBeenCalled()
    await h.run(reading({ [ORG_A]: org(3, 11 * MIN) }))
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    const [, alert] = h.sendAlert.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(alert).toMatchObject({ count: 3, aged: false, growing: { from: 2, lastCheckAt: iso(NOW - 5 * MIN) } })
  })

  it('says nothing about a young backlog that is new or shrinking', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(4, 3 * MIN) }), NOW - 5 * MIN)
    await h.run(reading({ [ORG_A]: org(2, 8 * MIN) }))
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(transitions(h.kv.store)).toEqual([])
  })

  it('pages only the organization in trouble, never another one', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN), [ORG_B]: org(1, 2 * MIN) }))
    expect(h.sendAlert.mock.calls.map((c) => (c as unknown[])[0])).toEqual([ORG_A])
  })

  it('does not page again while the reminder interval runs, and keeps the incident open', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    await h.run(reading({ [ORG_A]: org(1, 45 * MIN) }), NOW + 5 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.store.get(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(iso(NOW))
  })

  it('pages at once when an aged backlog starts growing too, since that is a new fact', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    await h.run(reading({ [ORG_A]: org(2, 45 * MIN) }), NOW + 5 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    expect(transitions(h.kv.store)).toEqual([`opened ${ORG_A}`, `paged ${ORG_A}`, `paged ${ORG_A}`])
  })

  it('arms nothing when the page did not reach Slack, so the next check tries again', async () => {
    const h = harness()
    h.sendAlert.mockResolvedValueOnce(false)
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(false)
    await h.run(reading({ [ORG_A]: org(1, 45 * MIN) }), NOW + 5 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('sends the all-clear once the backlog is gone, and ends the incident', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    const s = await h.run(reading({}), NOW + 5 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
    expect(h.sendRecovery.mock.calls[0]).toEqual([ORG_A, { alertedAt: iso(NOW), endedAt: iso(NOW) }])
    expect(s.allClear).toEqual([ORG_A])
    expect(transitions(h.kv.store)).toEqual([`opened ${ORG_A}`, `paged ${ORG_A}`, `ended ${ORG_A} all_clear`])
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(false)
    // The next backlog pages at once rather than waiting out the old reminder.
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }), NOW + 10 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('holds the all-clear while any write is still waiting, even a young one', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    await h.run(reading({ [ORG_A]: org(1, 2 * MIN) }), NOW + 5 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(true)
  })

  it('tries an all-clear that did not deliver again on the next check', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    h.sendRecovery.mockResolvedValueOnce(false)
    await h.run(reading({}), NOW + 5 * MIN)
    await h.run(reading({}), NOW + 10 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(2)
    expect(transitions(h.kv.store).at(-1)).toBe(`ended ${ORG_A} all_clear`)
  })

  it('pages a failed read as a failed read, never as all clear, and keeps every open incident', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    const stateBefore = h.kv.store.get(BACKLOG_STATE_KEY)
    const s = await h.run({ ok: false, error: 'connection reset' }, NOW + 5 * MIN)
    expect(s.read).toBe('failed')
    expect(h.notifyReadFailure).toHaveBeenCalledTimes(1)
    const [errors] = h.notifyReadFailure.mock.calls[0] as unknown as [string[]]
    expect(errors).toEqual(['The waiting Salesforce writes could not be read: connection reset.'])
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.notifyReadRecovered).toHaveBeenCalledTimes(1)
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(true)
    // The baseline for growth is the last reading that happened, not the failure.
    expect(h.kv.store.get(BACKLOG_STATE_KEY)).toBe(stateBefore)
  })

  it('stands the failed read alert down on the next clean read', async () => {
    const h = harness()
    await h.run({ ok: false, error: 'timeout' })
    await h.run(reading({}), NOW + 5 * MIN)
    expect(h.notifyReadRecovered).toHaveBeenCalledTimes(1)
  })

  it('treats a read that throws as a failed read', async () => {
    const h = harness()
    const deps: BacklogDeps = {
      kv: h.kv,
      read: async () => { throw new Error('boom') },
      sendAlert: h.sendAlert,
      sendRecovery: h.sendRecovery,
      notifyReadFailure: h.notifyReadFailure,
      notifyReadRecovered: h.notifyReadRecovered,
      now: () => NOW,
    }
    const s = await runWritebackBacklogCheck(deps)
    expect(s.read).toBe('failed')
    expect(h.notifyReadFailure).toHaveBeenCalledTimes(1)
  })

  it('never all-clears an organization a partial reading did not reach, since its rows may lie past the limit', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN), [ORG_B]: org(1, 2 * MIN) }))
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(true)
    // Another organization's older rows fill the whole read.
    await h.run(reading({ [ORG_B]: org(1000, 60 * MIN) }, true), NOW + 5 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.kv.store.has(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, ORG_A))).toBe(true)
    // Once a complete reading shows it empty, the all-clear goes.
    await h.run(reading({ [ORG_B]: org(3, 60 * MIN) }), NOW + 10 * MIN)
    expect(h.sendRecovery.mock.calls.map((c) => (c as unknown[])[0])).toEqual([ORG_A])
  })

  it('remembers an organization whose all-clear is still owed, so a later check can send it', async () => {
    const h = harness()
    await h.run(reading({ [ORG_A]: org(1, 40 * MIN) }))
    h.sendRecovery.mockResolvedValueOnce(false)
    await h.run(reading({}), NOW + 5 * MIN)
    await h.run(reading({}), NOW + 10 * MIN)
    await h.run(reading({}), NOW + 15 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(2)
  })
})

describe('readWritebackBacklog: the read through the Supabase client', () => {
  function fakeSupabase(answer: unknown) {
    const calls: Record<string, unknown[]> = {}
    const chain = {
      select: (...a: unknown[]) => { calls.select = a; return chain },
      eq: (...a: unknown[]) => { calls.eq = a; return chain },
      order: (...a: unknown[]) => { calls.order = a; return chain },
      limit: (...a: unknown[]) => { calls.limit = a; return typeof answer === 'function' ? (answer as () => unknown)() : Promise.resolve(answer) },
    }
    const client = { from: (t: string) => { calls.from = [t]; return chain } }
    return { client: client as unknown as SupabaseClient, calls }
  }

  it('reads only the organization, object and time of pending rows, oldest first, with an exact count', async () => {
    const { client, calls } = fakeSupabase({ data: [], error: null, count: 0 })
    await readWritebackBacklog(client)
    expect(calls.from).toEqual(['outcome_writeback_deadletters'])
    expect(calls.select).toEqual(['organization_id, sf_object, created_at', { count: 'exact' }])
    expect(calls.eq).toEqual(['status', 'pending'])
    expect(calls.order).toEqual(['created_at', { ascending: true }])
    expect(calls.limit).toEqual([WRITEBACK_BACKLOG_READ_LIMIT])
  })

  it('groups the rows per organization, keeping each one\'s oldest time and its objects', async () => {
    const { client } = fakeSupabase({
      data: [
        { organization_id: ORG_A, sf_object: 'Prospect__c', created_at: iso(NOW - 50 * MIN) },
        { organization_id: ORG_B, sf_object: 'Lead', created_at: iso(NOW - 40 * MIN) },
        { organization_id: ORG_A, sf_object: 'Lead', created_at: iso(NOW - 30 * MIN) },
        { organization_id: ORG_A, sf_object: 'Prospect__c', created_at: iso(NOW - 20 * MIN) },
      ],
      error: null,
      count: 4,
    })
    const r = await readWritebackBacklog(client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.partial).toBe(false)
    expect(r.byOrg.get(ORG_A)).toEqual({ count: 3, oldestAt: iso(NOW - 50 * MIN), objects: { Prospect__c: 2, Lead: 1 } })
    expect(r.byOrg.get(ORG_B)).toEqual({ count: 1, oldestAt: iso(NOW - 40 * MIN), objects: { Lead: 1 } })
  })

  it('calls the reading partial when there are more pending rows than it took', async () => {
    const { client } = fakeSupabase({ data: [{ organization_id: ORG_A, sf_object: 'Lead', created_at: iso(NOW) }], error: null, count: 1500 })
    const r = await readWritebackBacklog(client)
    expect(r.ok && r.partial).toBe(true)
  })

  it('returns a failed reading, never an empty one, for an error, a missing count, a throw or no answer', async () => {
    expect(await readWritebackBacklog(fakeSupabase({ data: null, error: { message: 'permission denied' }, count: null }).client)).toMatchObject({ ok: false })
    expect(await readWritebackBacklog(fakeSupabase({ data: [], error: null, count: null }).client)).toMatchObject({ ok: false })
    expect(await readWritebackBacklog(fakeSupabase(() => Promise.reject(new Error('reset'))).client)).toMatchObject({ ok: false, error: expect.stringContaining('reset') })
    vi.useFakeTimers()
    try {
      const pending = readWritebackBacklog(fakeSupabase(() => new Promise(() => {})).client)
      await vi.advanceTimersByTimeAsync(WRITEBACK_BACKLOG_READ_DEADLINE_MS)
      expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('did not answer') })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the backlog check is itself watched (L13, L71)', () => {
  it('is registered with the cron heartbeat on its own five minute schedule', () => {
    const job = cronJob(WRITEBACK_BACKLOG_JOB)
    expect(job.triggerCron).toBe('*/5 * * * *')
    expect(job.staleMs).toBe(15 * MIN)
  })

  it('is called dark by the heartbeat check once it has not run for longer than that', () => {
    const job = cronJob(WRITEBACK_BACKLOG_JOB)
    const lastRan = iso(NOW - 16 * MIN)
    expect(evaluateHeartbeat(lastRan, null, NOW, job.staleMs, lastRan, job.maxRunMs, iso(NOW - 60 * MIN)).status).toBe('stale')
    const recent = iso(NOW - 4 * MIN)
    expect(evaluateHeartbeat(recent, null, NOW, job.staleMs, recent, job.maxRunMs, iso(NOW - 60 * MIN)).status).toBe('healthy')
  })

  it('records its incidents as an organization signal labelled with its all-clear words', () => {
    const entry = incidentSignal(WRITEBACK_BACKLOG_SIGNAL)
    expect(entry).toMatchObject({ scope: 'org', subject: 'organization', windowMinutes: null })
    expect(entry.label).toBe(WRITEBACK_BACKLOG_RECOVERY_SUBJECT)
  })
})
