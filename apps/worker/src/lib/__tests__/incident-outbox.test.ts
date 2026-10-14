import { describe, expect, it, vi } from 'vitest'
import {
  announceRecovery,
  keepAlerted,
  markAlerted,
  markSpikeSeen,
  recordPaged,
  recoveryKey,
  refreshAlerted,
  settleRecovery,
} from '../alert-recovery'
import {
  INCIDENT_OUTBOX_PREFIX,
  outboxKeyTime,
  parseIncidentEvent,
  writeIncidentEvent,
  type IncidentContext,
  type IncidentEvent,
} from '../incident-outbox'

// The marker functions take the caller's clock, never a default (one reading per
// pass keeps an incident's records in the order they happened).
const NOW_MS = Date.parse('2026-10-14T12:00:00.000Z')

/**
 * The incident outbox (#2099). Every transition of an alert's incident (it
 * opened, a page about it reached Slack, it ended) is written to KV as one
 * event, and a drain moves the events into the database later. KV, not the
 * database, because three of the signals (the database unreachable, its memory
 * short, leads served from stored copies) happen exactly while the database is
 * failing, and a record written to it then would lose the incidents that matter
 * most.
 *
 * Recorded on TRANSITIONS only, never per sighting: keepAlerted runs on every
 * sighting of a partner block, hundreds of times an hour during one.
 */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: vi.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve() }),
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
  }
}

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const ORG: IncidentContext = { scope: { kind: 'org', organizationId: ORG_ID }, subjectLabel: 'Main Flow' }
const PLATFORM: IncidentContext = { scope: { kind: 'platform' }, subjectLabel: 'api.partner.test' }

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

describe('opened: the marker going from absent to present', () => {
  it('markAlerted records one opened event, with the start it pinned', async () => {
    const kv = fakeKv()
    await markAlerted(kv, 'volume-cliff', 'wf-1', ORG, Date.parse('2026-10-14T10:00:00.000Z'))
    const [e, ...rest] = events(kv)
    expect(rest).toEqual([])
    expect(e).toMatchObject({
      type: 'opened',
      signal: 'volume-cliff',
      subject: 'wf-1',
      subjectLabel: 'Main Flow',
      scope: 'org',
      organizationId: ORG_ID,
      startedAt: '2026-10-14T10:00:00.000Z',
      windowMinutes: 4,
    })
  })

  it('records nothing when the marker already stood, so a repeat page is not a new incident', async () => {
    const kv = fakeKv({ [recoveryKey('volume-cliff', 'wf-1')]: '2026-10-14T09:00:00.000Z' })
    await markAlerted(kv, 'volume-cliff', 'wf-1', ORG, Date.parse('2026-10-14T10:00:00.000Z'))
    expect(events(kv)).toEqual([])
  })

  it('keepAlerted records once however many sightings follow', async () => {
    const kv = fakeKv()
    for (let i = 0; i < 100; i++) await keepAlerted(kv, 'partner-reachability', 'api.partner.test', '2026-10-14T10:00:00.000Z', PLATFORM, NOW_MS)
    expect(events(kv).map((e) => e.type)).toEqual(['opened'])
    expect(events(kv)[0]).toMatchObject({ scope: 'platform', organizationId: null, startedAt: '2026-10-14T10:00:00.000Z' })
  })

  it('keepAlerted moving the start earlier records the move, naming the start it replaces', async () => {
    const kv = fakeKv({ [recoveryKey('partner-reachability', 'h')]: '2026-10-14T10:00:00.000Z' })
    await keepAlerted(kv, 'partner-reachability', 'h', '2026-10-14T09:30:00.000Z', PLATFORM, NOW_MS)
    const [e] = events(kv)
    expect(e).toMatchObject({ type: 'opened', startedAt: '2026-10-14T09:30:00.000Z', previousStartedAt: '2026-10-14T10:00:00.000Z' })
    // A later start never moves it, so records nothing.
    kv.store.clear()
    kv.store.set(recoveryKey('partner-reachability', 'h'), '2026-10-14T09:30:00.000Z')
    await keepAlerted(kv, 'partner-reachability', 'h', '2026-10-14T11:00:00.000Z', PLATFORM, NOW_MS)
    expect(events(kv)).toEqual([])
  })

  it('refreshAlerted keeps an open marker alive and never opens one', async () => {
    const kv = fakeKv()
    await refreshAlerted(kv, 'field-presence-drought', 'wf-1 f')
    expect(kv.store.size).toBe(0)
    kv.store.set(recoveryKey('field-presence-drought', 'wf-1 f'), '2026-10-14T10:00:00.000Z')
    await refreshAlerted(kv, 'field-presence-drought', 'wf-1 f')
    expect(kv.store.get(recoveryKey('field-presence-drought', 'wf-1 f'))).toBe('2026-10-14T10:00:00.000Z')
    expect(events(kv)).toEqual([])
  })

  it('markSpikeSeen, called on every failing tick, records nothing', async () => {
    const kv = fakeKv()
    await markSpikeSeen(kv, 'volume-cliff', 'wf-1', NOW_MS)
    expect(events(kv)).toEqual([])
  })
})

describe('paged: a page that reached Slack', () => {
  it('records the page against the open incident', async () => {
    const kv = fakeKv({ [recoveryKey('slow-spike', 'wf-1')]: '2026-10-14T10:00:00.000Z' })
    await recordPaged(kv, 'slow-spike', 'wf-1', ORG, Date.parse('2026-10-14T10:30:00.000Z'))
    const [e] = events(kv)
    expect(e).toMatchObject({ type: 'paged', startedAt: '2026-10-14T10:00:00.000Z', at: '2026-10-14T10:30:00.000Z' })
    expect(typeof e.id).toBe('string')
  })

  it('reports rather than guesses when no incident is open to page about', async () => {
    const kv = fakeKv()
    const onRecordError = vi.fn()
    await recordPaged(kv, 'slow-spike', 'wf-1', { ...ORG, onRecordError }, NOW_MS)
    expect(events(kv)).toEqual([])
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('no open incident'))
  })
})

describe('ended: settleRecovery', () => {
  it('writes the ended event, carrying the start and end, BEFORE deleting the markers', async () => {
    const kv = fakeKv({
      [recoveryKey('failure-rate', 'wf-1:ACRO')]: '2026-10-14T10:00:00.000Z',
      'failure-rate-active:wf-1:ACRO': '2026-10-14T11:00:00.000Z',
      'failure-rate-cooldown:wf-1:ACRO': '1',
    })
    const order: string[] = []
    const del = kv.delete
    kv.delete = (k: string) => { order.push(`delete ${k}`); return del(k) }
    kv.put.mockImplementation((k: string, v: string) => { order.push(`put ${k.startsWith(INCIDENT_OUTBOX_PREFIX) ? 'outbox' : k}`); kv.store.set(k, v); return Promise.resolve() })

    await settleRecovery(kv, 'failure-rate', 'wf-1:ACRO', 'failure-rate-cooldown:wf-1:ACRO', { ...ORG, windowMinutes: 15, reason: 'all_clear' })

    expect(order[0]).toBe('put outbox')
    const [e] = events(kv)
    expect(e).toMatchObject({
      type: 'ended',
      reason: 'all_clear',
      startedAt: '2026-10-14T10:00:00.000Z',
      endedAt: '2026-10-14T11:00:00.000Z',
      windowMinutes: 15,
    })
    expect(kv.store.has(recoveryKey('failure-rate', 'wf-1:ACRO'))).toBe(false)
  })

  it('records an unknown end as null rather than inventing one', async () => {
    const kv = fakeKv({ [recoveryKey('pg-cron-watch', 'job')]: '2026-10-14T10:00:00.000Z' })
    await settleRecovery(kv, 'pg-cron-watch', 'job', null, { scope: { kind: 'platform' }, subjectLabel: 'job', reason: 'all_clear' })
    expect(events(kv)[0]).toMatchObject({ type: 'ended', endedAt: null })
  })

  it('names the signal an incident was handed over to', async () => {
    const kv = fakeKv({ [recoveryKey('field-presence-dead', 'wf-1 f')]: '2026-10-14T10:00:00.000Z' })
    await settleRecovery(kv, 'field-presence-dead', 'wf-1 f', null, { ...ORG, reason: 'handed_over', successor: 'field-presence-wrong-path' })
    expect(events(kv)[0]).toMatchObject({ reason: 'handed_over', successor: 'field-presence-wrong-path' })
  })

  it('still settles when the outbox refuses, so a recorder fault never holds an all-clear back', async () => {
    const kv = fakeKv({ [recoveryKey('volume-cliff', 'wf-1')]: '2026-10-14T10:00:00.000Z' })
    kv.put.mockRejectedValue(new Error('KV down'))
    const onRecordError = vi.fn()
    await settleRecovery(kv, 'volume-cliff', 'wf-1', null, { ...ORG, reason: 'all_clear', onRecordError })
    expect(kv.store.has(recoveryKey('volume-cliff', 'wf-1'))).toBe(false)
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('KV down'))
  })

  it('records nothing when there was no incident to end', async () => {
    const kv = fakeKv()
    await settleRecovery(kv, 'volume-cliff', 'wf-1', null, { ...ORG, reason: 'all_clear' })
    expect(events(kv)).toEqual([])
  })

  it('announceRecovery ends the incident as an all-clear once the message delivered, and not before', async () => {
    const kv = fakeKv({ [recoveryKey('volume-cliff', 'wf-1')]: '2026-10-14T10:00:00.000Z' })
    await announceRecovery(kv, 'volume-cliff', 'wf-1', null, ORG, vi.fn().mockResolvedValue(false))
    expect(events(kv)).toEqual([])
    await announceRecovery(kv, 'volume-cliff', 'wf-1', null, ORG, vi.fn().mockResolvedValue(true))
    expect(events(kv).map((e) => [e.type, e.type === 'ended' ? e.reason : null])).toEqual([['ended', 'all_clear']])
  })
})

describe('scope', () => {
  it('refuses an org scope on a platform signal and the reverse, recording nothing', async () => {
    const onRecordError = vi.fn()
    const kv = fakeKv()
    await markAlerted(kv, 'pg-cron-watch', 'job', { ...ORG, onRecordError }, NOW_MS)
    await markAlerted(kv, 'volume-cliff', 'wf-1', { ...PLATFORM, onRecordError }, NOW_MS)
    expect(events(kv)).toEqual([])
    expect(onRecordError).toHaveBeenCalledTimes(2)
    // The markers themselves are untouched by a recorder refusal: the all-clear still works.
    expect(kv.store.has(recoveryKey('pg-cron-watch', 'job'))).toBe(true)
  })

  it('refuses an organization that is not an id, such as the probe\'s literal "probe"', async () => {
    const onRecordError = vi.fn()
    const kv = fakeKv()
    await markAlerted(kv, 'volume-cliff', 'wf-1', { scope: { kind: 'org', organizationId: 'probe' }, subjectLabel: null, onRecordError }, NOW_MS)
    expect(events(kv)).toEqual([])
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('probe'))
  })
})

describe('the outbox itself', () => {
  it('orders keys by the time they were written', async () => {
    const kv = fakeKv()
    const base = { signal: 'volume-cliff' as const, subject: 'wf-1', startedAt: '2026-10-14T10:00:00.000Z' }
    await writeIncidentEvent(kv, { ...base, type: 'opened' }, ORG, Date.parse('2026-10-14T10:00:02.000Z'))
    await writeIncidentEvent(kv, { ...base, type: 'paged' }, ORG, Date.parse('2026-10-14T10:00:01.000Z'))
    const keys = [...kv.store.keys()].sort()
    expect(keys.map(outboxKeyTime)).toEqual([Date.parse('2026-10-14T10:00:01.000Z'), Date.parse('2026-10-14T10:00:02.000Z')])
  })

  it('never throws: a KV fault is reported and the caller carries on', async () => {
    const kv = fakeKv()
    kv.put.mockRejectedValue(new Error('429 too many writes'))
    const onRecordError = vi.fn()
    const ok = await writeIncidentEvent(kv, { type: 'opened', signal: 'volume-cliff', subject: 'wf-1', startedAt: '2026-10-14T10:00:00.000Z' }, { ...ORG, onRecordError })
    expect(ok).toBe(false)
    expect(onRecordError).toHaveBeenCalledWith(expect.stringContaining('429'))
  })

  it('parses only events it can trust', () => {
    expect(parseIncidentEvent('not json')).toHaveProperty('error')
    expect(parseIncidentEvent(JSON.stringify({ v: 1, type: 'opened', signal: 'nope' }))).toHaveProperty('error')
    expect(parseIncidentEvent(JSON.stringify({
      v: 1, id: 'e1', type: 'opened', signal: 'volume-cliff', subject: 'wf-1', subjectLabel: null,
      scope: 'org', organizationId: null, startedAt: '2026-10-14T10:00:00.000Z', at: '2026-10-14T10:00:00.000Z', windowMinutes: 4,
    }))).toHaveProperty('error')
  })
})
