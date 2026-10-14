/**
 * The incident drain (#2100): moves the incident outbox's KV events into the
 * alert_incidents table, and closes as lapsed an open incident whose marker has
 * gone without an end.
 *
 * Everything is injected: the KV, the database, the clock and the Slack send,
 * so no test waits or reaches a network (L524).
 */
import { describe, expect, it } from 'vitest'
import {
  INCIDENT_DRAIN_ALERT_KEY,
  INCIDENT_OUTBOX_REFUSED_PREFIX,
  MAX_EVENTS_PER_RUN,
  OUTBOX_WAIT_ALERT_MS,
  runIncidentDrain,
  type IncidentDrainDeps,
} from '../incident-drain'
import { writeIncidentEvent, INCIDENT_OUTBOX_PREFIX, type IncidentContext } from '../incident-outbox'
import { recoveryKey } from '../alert-recovery'
import { readCondition } from '../alert-backoff'

const MIN = 60_000
const T0 = Date.parse('2026-10-14T12:00:00.000Z')
const ORG_ID = '11111111-1111-4111-8111-111111111111'
const ORG: IncidentContext = { scope: { kind: 'org', organizationId: ORG_ID }, subjectLabel: 'Main Flow' }

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  const kv = {
    store,
    failList: false,
    /** Keys a list does not show yet: KV lists late. */
    unlisted: new Set<string>(),
    /** Keys a list shows but a get no longer finds: drained by another run. */
    vanished: new Set<string>(),
    async get(k: string) {
      if (kv.vanished.has(k)) return null
      return live(k)?.value ?? null
    },
    async put(k: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    async delete(k: string) { store.delete(k) },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      if (kv.failList) throw new Error('KV list failed: 503')
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && live(k) && !kv.unlisted.has(k)).sort().map((name) => ({ name }))
      return { keys, list_complete: true as const, cacheStatus: null }
    },
  }
  return kv
}

type Call = { fn: string; args: Record<string, unknown> }

/** A database that answers each rpc from `answer`, and the open incidents from `open`. */
function fakeDb(opts: {
  answer?: (call: Call) => { data: unknown; error: { message: string; code?: string } | null }
  open?: Array<{ id: string; signal: string; subject: string; started_at: string }>
  openError?: string
} = {}) {
  const calls: Call[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const call = { fn, args }
      calls.push(call)
      if (opts.answer) return opts.answer(call)
      if (fn === 'record_alert_incident_marker_check') return { data: 'open', error: null }
      return { data: '99999999-9999-4999-8999-999999999999', error: null }
    },
    from: (table: string) => {
      const result = opts.openError
        ? { data: null, error: { message: opts.openError } }
        : { data: table === 'alert_incidents' ? opts.open ?? [] : [], error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'is', 'order', 'limit']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    },
  }
  return { calls, client }
}

function harness(db = fakeDb()) {
  const clock = { now: T0 }
  const kv = fakeKv(clock)
  const posted: Array<{ title: string; errors: string[]; repeat?: string }> = []
  const held = new Set<string>()
  const deps = (): IncidentDrainDeps => ({
    kv,
    supabase: db.client as unknown as IncidentDrainDeps['supabase'],
    now: () => clock.now,
    claims: {
      claim: async (k) => { if (held.has(k)) return false; held.add(k); return true },
      release: async (k) => { held.delete(k) },
    },
    resolveSlack: async () => [{ bot_token: 'xoxb-test', default_channel: '#ops' }],
    send: async (_s, message) => { posted.push(message); return true },
    log: () => {},
  })
  return { clock, kv, db, posted, deps }
}

const outboxKeys = (kv: ReturnType<typeof fakeKv>) => [...kv.store.keys()].filter((k) => k.startsWith(INCIDENT_OUTBOX_PREFIX))

async function seedIncident(kv: ReturnType<typeof fakeKv>, clock: { now: number }) {
  const startedAt = new Date(clock.now).toISOString()
  await writeIncidentEvent(kv, { type: 'opened', signal: 'volume-cliff', subject: 'wf-1', startedAt }, ORG, clock.now)
  await writeIncidentEvent(kv, { type: 'paged', signal: 'volume-cliff', subject: 'wf-1', startedAt }, ORG, clock.now + 1)
  await writeIncidentEvent(kv, { type: 'ended', signal: 'volume-cliff', subject: 'wf-1', startedAt, endedAt: new Date(clock.now + 30 * MIN).toISOString(), reason: 'all_clear' }, ORG, clock.now + 2)
  return startedAt
}

describe('moving events into the record', () => {
  it('writes each event through its transition function, in the order written, and removes it once the row came back', async () => {
    const h = harness()
    const startedAt = await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(h.db.calls.map((c) => c.fn)).toEqual(['record_alert_incident_opened', 'record_alert_incident_paged', 'record_alert_incident_ended'])
    expect(h.db.calls[0].args).toEqual({
      p_signal: 'volume-cliff', p_subject: 'wf-1', p_subject_label: 'Main Flow', p_scope: 'org', p_organization_id: ORG_ID,
      p_started_at: startedAt, p_previous_started_at: null, p_window_minutes: 4,
    })
    expect(h.db.calls[1].args).toMatchObject({ p_paged_at: new Date(T0 + 1).toISOString(), p_event_id: expect.any(String) })
    expect(h.db.calls[2].args).toMatchObject({ p_ended_at: new Date(T0 + 30 * MIN).toISOString(), p_reason: 'all_clear', p_successor: null })
    expect(outboxKeys(h.kv)).toEqual([])
    expect(s).toMatchObject({ applied: 3, failed: 0, refused: 0, waiting: 0 })
  })

  it('keeps an event whose write reported no error but returned no row, since that is not a write that landed', async () => {
    const h = harness(fakeDb({ answer: () => ({ data: null, error: null }) }))
    await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(outboxKeys(h.kv)).toHaveLength(3)
    expect(s.applied).toBe(0)
    expect(s.failed).toBe(3)
    expect(s.errors.some((e) => e.includes('no row'))).toBe(true)
  })

  it('keeps going past an event the database could not take, and keeps that one for the next run', async () => {
    const h = harness(fakeDb({
      answer: (c) => c.fn === 'record_alert_incident_paged'
        ? { data: null, error: { message: 'upstream connect error', code: '' } }
        : { data: '99999999-9999-4999-8999-999999999999', error: null },
    }))
    await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(h.db.calls.map((c) => c.fn)).toContain('record_alert_incident_ended')
    expect(outboxKeys(h.kv)).toHaveLength(1)
    expect(s).toMatchObject({ applied: 2, failed: 1, waiting: 1 })
  })

  it('keeps an event whose write threw', async () => {
    const db = fakeDb()
    db.client.rpc = async () => { throw new Error('fetch failed') }
    const h = harness(db)
    await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(outboxKeys(h.kv)).toHaveLength(3)
    expect(s.failed).toBe(3)
  })

  it('sets aside an event the database refuses outright, copying it before it is removed, so one bad event cannot hold the drain for ever', async () => {
    const h = harness(fakeDb({
      answer: (c) => c.fn === 'record_alert_incident_opened'
        ? { data: null, error: { message: 'violates check constraint', code: '23514' } }
        : { data: '99999999-9999-4999-8999-999999999999', error: null },
    }))
    await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(outboxKeys(h.kv)).toEqual([])
    const refused = [...h.kv.store.keys()].filter((k) => k.startsWith(INCIDENT_OUTBOX_REFUSED_PREFIX))
    expect(refused).toHaveLength(1)
    expect(JSON.parse(h.kv.store.get(refused[0])!.value)).toMatchObject({ reason: expect.stringContaining('check constraint') })
    expect(s.refused).toBe(1)
  })

  it('sets aside a value it cannot read as an event', async () => {
    const h = harness()
    await h.kv.put(`${INCIDENT_OUTBOX_PREFIX}000001760443200000:000001:x`, 'not json')
    const s = await runIncidentDrain(h.deps())
    expect(h.db.calls).toEqual([])
    expect(s.refused).toBe(1)
    expect(outboxKeys(h.kv)).toEqual([])
  })

  it('skips a listed key a direct read no longer finds, since another run already drained it', async () => {
    const h = harness()
    await seedIncident(h.kv, h.clock)
    const [first] = outboxKeys(h.kv)
    h.kv.vanished.add(first)
    const s = await runIncidentDrain(h.deps())
    expect(h.db.calls.map((c) => c.fn)).toEqual(['record_alert_incident_paged', 'record_alert_incident_ended'])
    expect(s.failed).toBe(0)
  })

  it('writes at most a bounded number of events per run, oldest first, and leaves the rest waiting for the next', async () => {
    const h = harness()
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 5; i++) {
      await writeIncidentEvent(h.kv, { type: 'opened', signal: 'volume-cliff', subject: `wf-${i}`, startedAt: new Date(T0).toISOString() }, ORG, T0 + i)
    }
    const s = await runIncidentDrain(h.deps())
    expect(h.db.calls.filter((c) => c.fn === 'record_alert_incident_opened')).toHaveLength(MAX_EVENTS_PER_RUN)
    expect(h.db.calls[0].args.p_subject).toBe('wf-0')
    expect(outboxKeys(h.kv)).toHaveLength(5)
    expect(s).toMatchObject({ applied: MAX_EVENTS_PER_RUN, deferred: 5, waiting: 5 })
  })

  it('reports a list KV refused as a failed run, and judges no open incident on it', async () => {
    const h = harness(fakeDb({ open: [{ id: 'i1', signal: 'volume-cliff', subject: 'wf-1', started_at: '2026-10-14T10:00:00+00:00' }] }))
    h.kv.failList = true
    const s = await runIncidentDrain(h.deps())
    expect(s.errors.some((e) => e.includes('KV list failed'))).toBe(true)
    expect(h.db.calls).toEqual([])
  })
})

describe('lapsed incidents', () => {
  const OPEN = { id: 'i1', signal: 'volume-cliff', subject: 'wf-1', started_at: '2026-10-14T10:00:00+00:00' }
  const check = (h: ReturnType<typeof harness>) => h.db.calls.filter((c) => c.fn === 'record_alert_incident_marker_check').map((c) => c.args)

  it('reports a marker it read directly as present when it holds this incident\'s start', async () => {
    const h = harness(fakeDb({ open: [OPEN] }))
    await h.kv.put(recoveryKey('volume-cliff', 'wf-1'), '2026-10-14T10:00:00.000Z')
    await runIncidentDrain(h.deps())
    expect(check(h)).toEqual([{ p_id: 'i1', p_marker_present: true, p_now: new Date(T0).toISOString() }])
  })

  it('reports it absent when the marker is gone, or now belongs to a later incident', async () => {
    const h = harness(fakeDb({ open: [OPEN] }))
    await runIncidentDrain(h.deps())
    await h.kv.put(recoveryKey('volume-cliff', 'wf-1'), '2026-10-14T11:30:00.000Z')
    await runIncidentDrain(h.deps())
    expect(check(h).map((a) => a.p_marker_present)).toEqual([false, false])
  })

  it('counts what the database decided', async () => {
    const h = harness(fakeDb({
      open: [OPEN, { ...OPEN, id: 'i2', subject: 'wf-2' }],
      answer: (c) => ({ data: c.args.p_id === 'i1' ? 'lapsed' : 'suspect', error: null }),
    }))
    const s = await runIncidentDrain(h.deps())
    expect(s).toMatchObject({ lapsed: 1, suspect: 1 })
  })

  it('skips a row whose signal the registry does not know, rather than reading a marker it cannot name', async () => {
    const h = harness(fakeDb({ open: [{ ...OPEN, signal: 'retired-signal' }] }))
    const s = await runIncidentDrain(h.deps())
    expect(check(h)).toEqual([])
    expect(s.errors.some((e) => e.includes('retired-signal'))).toBe(true)
  })

  it('judges no lapse while events still wait, since the incident\'s own end may be one of them', async () => {
    const h = harness(fakeDb({
      open: [OPEN],
      answer: (c) => c.fn === 'record_alert_incident_ended'
        ? { data: null, error: { message: 'upstream connect error' } }
        : c.fn === 'record_alert_incident_marker_check' ? { data: 'suspect', error: null } : { data: '99999999-9999-4999-8999-999999999999', error: null },
    }))
    await seedIncident(h.kv, h.clock)
    const s = await runIncidentDrain(h.deps())
    expect(s.waiting).toBe(1)
    expect(check(h)).toEqual([])
  })

  it('reports an open incident read that failed', async () => {
    const h = harness(fakeDb({ openError: 'canceling statement due to statement timeout' }))
    const s = await runIncidentDrain(h.deps())
    expect(s.errors.some((e) => e.includes('statement timeout'))).toBe(true)
  })
})

describe('the drain\'s own alert', () => {
  it('says nothing while events have waited under an hour', async () => {
    const h = harness(fakeDb({ answer: () => ({ data: null, error: { message: 'upstream connect error' } }) }))
    await seedIncident(h.kv, h.clock)
    h.clock.now += OUTBOX_WAIT_ALERT_MS - MIN
    const s = await runIncidentDrain(h.deps())
    expect(s.oldestWaitingMs).toBe(OUTBOX_WAIT_ALERT_MS - MIN)
    // One failed run is not yet two.
    expect(h.posted).toEqual([])
  })

  it('alerts once events have waited over an hour, and not again inside the reminder gap', async () => {
    const h = harness(fakeDb({ answer: () => ({ data: null, error: { message: 'upstream connect error' } }) }))
    await seedIncident(h.kv, h.clock)
    h.clock.now += OUTBOX_WAIT_ALERT_MS + MIN
    await runIncidentDrain(h.deps())
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].title).toBe('Incident record behind')
    expect(h.posted[0].errors.join(' ')).toContain('3 incident events have waited')
  })

  it('alerts when two drains in a row failed, but not after one', async () => {
    const h = harness(fakeDb({ answer: () => ({ data: null, error: { message: 'upstream connect error' } }) }))
    await seedIncident(h.kv, h.clock)
    await runIncidentDrain(h.deps())
    expect(h.posted).toEqual([])
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].errors.join(' ')).toContain('upstream connect error')
  })

  it('alerts at once for an event it had to set aside', async () => {
    const h = harness()
    await h.kv.put(`${INCIDENT_OUTBOX_PREFIX}000001760443200000:000001:x`, 'not json')
    await runIncidentDrain(h.deps())
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].errors.join(' ')).toContain('set aside')
  })

  it('says the record has caught up once it has, and stands the alert down', async () => {
    let down = true
    const h = harness(fakeDb({ answer: () => (down ? { data: null, error: { message: 'upstream connect error' } } : { data: '99999999-9999-4999-8999-999999999999', error: null }) }))
    await seedIncident(h.kv, h.clock)
    await runIncidentDrain(h.deps())
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted).toHaveLength(1)
    down = false
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted.map((p) => p.title)).toEqual(['Incident record behind', 'Incident record caught up'])
    expect(await readCondition(h.kv, INCIDENT_DRAIN_ALERT_KEY)).toBeNull()
  })

  it('does not say the record caught up on a run that itself failed, or while events still wait', async () => {
    let down = true
    const h = harness(fakeDb({ answer: () => (down ? { data: null, error: { message: 'upstream connect error' } } : { data: '99999999-9999-4999-8999-999999999999', error: null }) }))
    await seedIncident(h.kv, h.clock)
    await runIncidentDrain(h.deps())
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted).toHaveLength(1)
    // Fifteen minutes later the failure stamp has gone, so this failed run is alone:
    // not two in a row, and not over an hour, yet it is no recovery either.
    h.clock.now += 15 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted.map((p) => p.title)).toEqual(['Incident record behind'])
    expect(await readCondition(h.kv, INCIDENT_DRAIN_ALERT_KEY)).not.toBeNull()
    down = false
    h.clock.now += 5 * MIN
    await runIncidentDrain(h.deps())
    expect(h.posted.map((p) => p.title)).toEqual(['Incident record behind', 'Incident record caught up'])
  })

  it('says nothing at all on a healthy run', async () => {
    const h = harness()
    await seedIncident(h.kv, h.clock)
    await runIncidentDrain(h.deps())
    await runIncidentDrain(h.deps())
    expect(h.posted).toEqual([])
  })
})
