/**
 * The drain's lapse check finds every signal's marker where its check keeps it
 * (#2103, under #818).
 *
 * The drain closes an open incident as lapsed once its KV marker has been absent
 * on two drains. The cron heartbeat keeps its open incident in its paged status
 * record, not under alert-recovery's `<signal>-recovery:<id>`, so a drain that
 * looked only there would close every ongoing heartbeat incident as lapsed ten
 * minutes in, while the job was still dark and still being paged about.
 *
 * Each case here writes its state through the real check (Slack mocked), drains
 * it through the real drain, and judges the lapse with a database that applies
 * record_alert_incident_marker_check's rule, so what is proved is that the drain
 * reads what the check writes, not what a test wrote for it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
  sendCronHeartbeatRecoveryAlert: vi.fn(async () => true),
  sendExportFailureAlert: vi.fn(async () => true),
}))

import { runIncidentDrain, type IncidentDrainDeps } from '../incident-drain'
import { alertedStatusKey, completedKey, completedWatchKey, CRON_JOBS, cronJob, heartbeatKey, runHeartbeatChecks } from '../cron-heartbeat'
import { notifyExportFailure } from '../export-alerts'
import { recoveryKey } from '../alert-recovery'

const MIN = 60_000
const H = 60 * MIN
const T0 = Date.parse('2026-10-14T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  return {
    store,
    async get(k: string) { return live(k)?.value ?? null },
    async put(k: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    async delete(k: string) { store.delete(k) },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && live(k)).sort().map((name) => ({ name }))
      return { keys, list_complete: true as const, cacheStatus: null }
    },
  }
}

interface Row { id: string; signal: string; subject: string; started_at: string; ended_reason: string | null; marker_missing_at: number | null }

/** alert_incidents, with each transition function and the lapse rule, as far as this proof needs them. */
function incidentTable() {
  const rows = new Map<string, Row>()
  const keyOf = (a: Record<string, unknown>) => `${String(a.p_signal)}|${String(a.p_subject)}|${Date.parse(String(a.p_started_at))}`
  const upsert = (a: Record<string, unknown>): Row => {
    const k = keyOf(a)
    let row = rows.get(k)
    if (!row) {
      row = { id: `row-${rows.size + 1}`, signal: String(a.p_signal), subject: String(a.p_subject), started_at: String(a.p_started_at), ended_reason: null, marker_missing_at: null }
      rows.set(k, row)
    }
    return row
  }
  const client = {
    rpc: async (fn: string, a: Record<string, unknown>) => {
      if (fn === 'record_alert_incident_opened' || fn === 'record_alert_incident_paged') return { data: upsert(a).id, error: null }
      if (fn === 'record_alert_incident_ended') {
        const row = upsert(a)
        if (row.ended_reason === null || row.ended_reason === 'lapsed') { row.ended_reason = String(a.p_reason); row.marker_missing_at = null }
        return { data: row.id, error: null }
      }
      if (fn === 'record_alert_incident_marker_check') {
        const row = [...rows.values()].find((r) => r.id === a.p_id)
        if (!row) return { data: 'missing', error: null }
        if (row.ended_reason !== null) return { data: 'closed', error: null }
        const now = Date.parse(String(a.p_now))
        if (a.p_marker_present) { row.marker_missing_at = null; return { data: 'open', error: null } }
        if (row.marker_missing_at === null || row.marker_missing_at > now - 4 * MIN) {
          row.marker_missing_at = row.marker_missing_at ?? now
          return { data: 'suspect', error: null }
        }
        row.ended_reason = 'lapsed'
        return { data: 'lapsed', error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'is', 'order', 'limit']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [...rows.values()].filter((r) => r.ended_reason === null).map(({ id, signal, subject, started_at }) => ({ id, signal, subject, started_at })), error: null }).then(resolve)
      return chain
    },
  }
  return { rows, client }
}

/** The org list and an empty job_runs, which is what the heartbeat and the export alerter read. */
function checkDb(): SupabaseClient {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'in', 'is']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }).then(resolve)
  const runs: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'not', 'order']) runs[m] = () => runs
  runs.limit = () => Promise.resolve({ data: [], error: null })
  return { from: (t: string) => (t === 'job_runs' ? runs : chain) } as unknown as SupabaseClient
}

function harness() {
  const clock = { now: T0 }
  const kv = fakeKv(clock)
  const table = incidentTable()
  const deps = (): IncidentDrainDeps => ({
    kv,
    supabase: table.client as unknown as IncidentDrainDeps['supabase'],
    now: () => clock.now,
    resolveSlack: async () => [],
    send: async () => true,
    log: () => {},
  })
  const drain = async () => {
    const s = await runIncidentDrain(deps())
    expect(s.errors).toEqual([])
    return s
  }
  const stateOf = (signal: string) => [...table.rows.values()].filter((r) => r.signal === signal).map((r) => r.ended_reason ?? 'open')
  return { clock, kv, table, drain, stateOf }
}

const daily = () => cronJob('daily-1300')

/** Every other watched job started and finished a moment ago, so only the job under test can page. */
async function othersFresh(h: ReturnType<typeof harness>, except: string) {
  for (const j of CRON_JOBS) {
    if (j.id === except) continue
    await h.kv.put(heartbeatKey(j.id), iso(h.clock.now - 2))
    await h.kv.put(completedKey(j.id), iso(h.clock.now - 1))
  }
}

async function darkDailyJob(h: ReturnType<typeof harness>) {
  await othersFresh(h, daily().id)
  await h.kv.put(heartbeatKey(daily().id), iso(h.clock.now - 36 * H))
  await runHeartbeatChecks(checkDb(), h.kv as unknown as KVNamespace, h.clock.now)
}

describe('an ongoing heartbeat incident', () => {
  it('survives two drains and more while its paged status record stands, and lapses once that record has gone with no end', async () => {
    const h = harness()
    await darkDailyJob(h)
    await h.drain()
    expect(h.stateOf('cron-heartbeat')).toEqual(['open'])
    for (let i = 0; i < 3; i++) {
      h.clock.now += 5 * MIN
      await othersFresh(h, daily().id)
      await runHeartbeatChecks(checkDb(), h.kv as unknown as KVNamespace, h.clock.now)
      const s = await h.drain()
      expect(s).toMatchObject({ lapsed: 0, suspect: 0 })
    }
    expect(h.stateOf('cron-heartbeat')).toEqual(['open'])

    // Its state goes without an end being recorded (an end lost to a KV fault).
    await h.kv.delete(alertedStatusKey(daily().id))
    h.clock.now += 5 * MIN
    expect(await h.drain()).toMatchObject({ suspect: 1 })
    h.clock.now += 5 * MIN
    expect(await h.drain()).toMatchObject({ lapsed: 1 })
    expect(h.stateOf('cron-heartbeat')).toEqual(['lapsed'])
  })

  it('closes with its own end when the all-clear delivers, which no later drain reopens as a lapse', async () => {
    const h = harness()
    const archive = cronJob('execution-archive')
    await othersFresh(h, archive.id)
    const started = h.clock.now - archive.maxRunMs - 5 * MIN
    await h.kv.put(heartbeatKey(archive.id), iso(started))
    await h.kv.put(completedWatchKey(archive.id), iso(h.clock.now - 24 * H))
    await runHeartbeatChecks(checkDb(), h.kv as unknown as KVNamespace, h.clock.now)
    await h.drain()
    h.clock.now += MIN
    await othersFresh(h, archive.id)
    await h.kv.put(completedKey(archive.id), iso(h.clock.now - 30_000))
    await runHeartbeatChecks(checkDb(), h.kv as unknown as KVNamespace, h.clock.now)
    await h.drain()
    h.clock.now += 5 * MIN
    await h.drain()
    expect(h.stateOf('cron-heartbeat')).toEqual(['all_clear'])
  })
})

describe('an ongoing export incident', () => {
  const JOB = 'Archive identity check'

  it('survives two drains and more while its marker stands, and lapses once the marker has gone with no end', async () => {
    const h = harness()
    await notifyExportFailure(checkDb(), JOB, ['Snowflake 401 unauthorized'], h.kv, 'export-job', h.clock.now)
    await h.drain()
    expect(h.stateOf('export-alert')).toEqual(['open'])
    for (let i = 0; i < 3; i++) {
      h.clock.now += 5 * MIN
      await notifyExportFailure(checkDb(), JOB, ['Snowflake 401 unauthorized'], h.kv, 'export-job', h.clock.now)
      expect(await h.drain()).toMatchObject({ lapsed: 0, suspect: 0 })
    }
    expect(h.stateOf('export-alert')).toEqual(['open'])

    await h.kv.delete(recoveryKey('export-alert', JOB))
    h.clock.now += 5 * MIN
    expect(await h.drain()).toMatchObject({ suspect: 1 })
    h.clock.now += 5 * MIN
    expect(await h.drain()).toMatchObject({ lapsed: 1 })
    expect(h.stateOf('export-alert')).toEqual(['lapsed'])
  })
})
