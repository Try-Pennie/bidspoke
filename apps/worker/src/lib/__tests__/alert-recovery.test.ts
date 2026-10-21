import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_REARM_MINUTES,
  RECOVERY_TTL_SECONDS,
  announceRecovery,
  healthyKey,
  keepAlerted,
  markAlerted,
  markSpikeSeen,
  recoveryKey,
  recoveryDue,
  settleRecovery,
} from '../alert-recovery'
import type { IncidentContext } from '../incident-outbox'

// The marker functions take the caller's clock, never a default (one reading per
// pass keeps an incident's records in the order they happened).
const NOW_MS = Date.parse('2026-10-14T12:00:00.000Z')

// The incident record's context (#2099), the same for every call here: these tests are
// about the markers, and incident-outbox.test.ts covers what is recorded.
const ORG: IncidentContext = { scope: { kind: 'org', organizationId: '11111111-1111-4111-8111-111111111111' }, subjectLabel: 'Main Flow' }
const PLATFORM: IncidentContext = { scope: { kind: 'platform' }, subjectLabel: 'host' }

/**
 * Issue #253. The three rate-aggregated alerts page when a rate STARTS spiking
 * and say nothing when it recovers, so after an outage nobody can tell from Slack
 * whether it is still going. Silence means both "still broken, suppressed by the
 * cooldown" and "fine again", which are the two things a reader most needs to
 * tell apart.
 *
 * The marker that we OWE an all-clear is deliberately separate from the cooldown
 * key (LESSONS L53: two independent facts must not share one field). The cooldown
 * is 30 minutes; an outage lasting longer than that expires it, so a design that
 * reads "did we alert" off the cooldown would go quiet on exactly the long
 * outages where the all-clear matters most.
 */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
  }
}

describe('recoveryKey', () => {
  it('namespaces by signal so two checks cannot clear each other', () => {
    expect(recoveryKey('volume-cliff', 'wf-1')).toBe('volume-cliff-recovery:wf-1')
    expect(recoveryKey('failure-rate', 'wf-1:timeout')).toBe('failure-rate-recovery:wf-1:timeout')
  })
})

describe('markAlerted', () => {
  it('records that we owe an all-clear', async () => {
    const kv = fakeKv()
    await markAlerted(kv, 'volume-cliff', 'wf-1', ORG, NOW_MS)
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBeTruthy()
  })

  it('stores the time the alert fired, so the all-clear can say how long it lasted', async () => {
    const kv = fakeKv()
    await markAlerted(kv, 'volume-cliff', 'wf-1', ORG, 1_700_000_000_000)
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('does not overwrite an existing marker, so the all-clear reports the FIRST alert', async () => {
    // A long outage re-alerts after each cooldown lapse. Overwriting would reset
    // the clock and report a minutes-long blip after hours of downtime.
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    await markAlerted(kv, 'volume-cliff', 'wf-1', ORG, Date.parse('2026-08-14T13:00:00.000Z'))
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBe('2026-08-14T10:00:00.000Z')
  })

  it('outlives the 30 minute cooldown by a wide margin', () => {
    expect(RECOVERY_TTL_SECONDS).toBeGreaterThan(30 * 60)
  })

  it('stays above the longest check cadence, so a daily check cannot race its expiry (#1343)', () => {
    // The longest cadence of any check that writes this marker is the daily
    // dead-field tier at 24h. The TTL must stay comfortably above that, or the
    // race this fixed returns. Catches an accidental lowering; a check scheduled
    // LESS often than daily would still need this lifted (noted at the constant).
    const ONE_DAY = 24 * 60 * 60
    expect(RECOVERY_TTL_SECONDS).toBeGreaterThanOrEqual(2 * ONE_DAY)
  })

  // A KV double that honours expirationTtl against an injectable clock, so a test
  // can drive a page and a recovery one full check interval apart (#1343) rather
  // than asserting the TTL constant.
  function expiringKv(clock: { now: number }) {
    const store = new Map<string, { value: string; expiresMs: number }>()
    return {
      store,
      get: (k: string) => {
        const e = store.get(k)
        if (!e) return Promise.resolve(null)
        if (clock.now > e.expiresMs) {
          store.delete(k)
          return Promise.resolve(null)
        }
        return Promise.resolve(e.value)
      },
      put: (k: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(k, { value, expiresMs: clock.now + (opts?.expirationTtl ?? Infinity) * 1000 })
        return Promise.resolve()
      },
      delete: (k: string) => {
        store.delete(k)
        return Promise.resolve()
      },
    }
  }

  const DAY_MS = 24 * 60 * 60 * 1000
  const PREFIX = 'field-presence-dead'
  const ID = 'wf-1:ping.data'

  it('keeps the recovery marker alive across a full daily interval, so a daily all-clear does not race its expiry (#1343)', async () => {
    // The daily dead-field tier runs on a 24h cron; a marker whose TTL equalled
    // the cadence expired at almost exactly the moment the next run read it.
    const clock = { now: Date.parse('2026-10-01T13:00:00.000Z') }
    const kv = expiringKv(clock)
    await markAlerted(kv, PREFIX, ID, ORG, clock.now)
    // The next daily run, a little over one interval later, must still see it.
    clock.now += DAY_MS + 60_000
    expect(await kv.get(recoveryKey(PREFIX, ID))).not.toBeNull()
  })

  it('refreshes the TTL on each page so a multi-day outage keeps its original start (#1343)', async () => {
    const clock = { now: Date.parse('2026-10-01T13:00:00.000Z') }
    const kv = expiringKv(clock)
    const firstStart = new Date(clock.now).toISOString()
    await markAlerted(kv, PREFIX, ID, ORG, clock.now)
    // Still failing a day later, and the day after: each page refreshes the TTL
    // while keeping the first-alert time.
    clock.now += DAY_MS + 60_000
    await markAlerted(kv, PREFIX, ID, ORG, clock.now)
    clock.now += DAY_MS + 60_000
    await markAlerted(kv, PREFIX, ID, ORG, clock.now)
    // The recovery run another interval on still finds the marker, with the
    // original start, not a reset one.
    clock.now += DAY_MS + 60_000
    expect(await kv.get(recoveryKey(PREFIX, ID))).toBe(firstStart)
  })
})

describe('announceRecovery', () => {
  afterEach(() => vi.restoreAllMocks())

  it('says nothing when we never alerted', async () => {
    const kv = fakeKv()
    const send = vi.fn().mockResolvedValue(true)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the all-clear when a previously alerted signal is healthy again', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('2026-08-14T10:00:00.000Z', null, null)
  })

  it('deletes no cooldown when the check has none to clear (#851)', async () => {
    // A check whose cooldown is not per id (the schedule watch's is keyed on a
    // whole signature) passes null rather than inventing a key to "delete".
    const kv = fakeKv({ 'workflow-schedule-recovery:a.yml': '2026-08-14T10:00:00.000Z' })
    const del = vi.spyOn(kv, 'delete')
    expect(await announceRecovery(kv, 'workflow-schedule', 'a.yml', null, PLATFORM, vi.fn().mockResolvedValue(true))).toBe(true)
    expect(kv.store.has('workflow-schedule-recovery:a.yml')).toBe(false)
    expect(del.mock.calls.map((c) => c[0])).toEqual(['workflow-schedule-recovery:a.yml', 'workflow-schedule-active:a.yml', 'workflow-schedule-healthy:a.yml'])
  })

  it('clears the cooldown too, so the next genuine spike pages immediately', async () => {
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z',
      'volume-cliff-cooldown:wf-1': '1',
    })
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, vi.fn().mockResolvedValue(true))
    expect(kv.store.has('volume-cliff-cooldown:wf-1')).toBe(false)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(false)
  })

  it('announces only once, because the marker is gone on the next healthy check', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('KEEPS the marker when the all-clear failed to deliver, so it retries', async () => {
    // The mirror of "only start the cooldown once the alert delivered": a kicked
    // bot or a Slack outage during recovery must not swallow the all-clear
    // silently and leave the last word being the page.
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(false)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)).toBe(false)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  it('does not clear the cooldown when the all-clear failed to deliver', async () => {
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z',
      'volume-cliff-cooldown:wf-1': '1',
    })
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, vi.fn().mockResolvedValue(false))
    expect(kv.store.has('volume-cliff-cooldown:wf-1')).toBe(true)
  })

  it('survives a send that throws, without losing the marker', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockRejectedValue(new Error('slack exploded'))
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send)).toBe(false)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  // #817: a check that recovers by the ABSENCE of its condition cannot tell a
  // genuine recovery from a workflow that simply stopped receiving traffic, so
  // it supplies evidence that the pipe is alive. Without that evidence the
  // all-clear is HELD, not sent, so a dead pipe never reads "back to normal".
  it('HOLDS the all-clear when there is no evidence of recovery', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    const held = await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send, {
      hasEvidence: () => false,
    })
    expect(held).toBe(false)
    expect(send).not.toHaveBeenCalled()
    // Marker kept, so the all-clear fires once real evidence appears.
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  it('sends the all-clear when evidence of recovery is present', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    expect(
      await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send, {
        hasEvidence: () => true,
      }),
    ).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it('HOLDS the all-clear when the evidence check throws, erring toward still-alarmed', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi.fn().mockResolvedValue(true)
    const held = await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', ORG, send, {
      hasEvidence: () => {
        throw new Error('count query failed')
      },
    })
    expect(held).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })
})

/**
 * Issue #814. The all-clear reported the ALERT EPISODE, not the outage. The
 * marker was cleared on the FIRST healthy tick, so a relapse minutes later
 * started a brand new incident from zero.
 *
 * On Fri 2026-08-14 an Equifax ACRO_GATEWAY outage ran 9:25 to 11:04 PM over
 * 1,326 failed runs, went quiet for 23 minutes in the middle, and was announced
 * to the team as an incident lasting 5 minutes. Both messages were correct about
 * their own episode and neither described the outage (LESSONS L160).
 *
 * So the condition is over only once it has stayed healthy for a re-arm window,
 * and the duration is measured to the LAST OBSERVED FAILURE rather than to the
 * moment the all-clear is sent.
 */
describe('markSpikeSeen (#814)', () => {
  it('records the tick on which the condition was last true', async () => {
    const kv = fakeKv()
    await markSpikeSeen(kv, 'failure-rate', 'wf-1:ACRO', Date.parse('2026-08-14T22:33:00.000Z'))
    expect(kv.store.get('failure-rate-active:wf-1:ACRO')).toBe('2026-08-14T22:33:00.000Z')
  })

  it('DOES overwrite, unlike the alert marker, because it tracks the latest failure', async () => {
    // markAlerted pins the START of the incident; this pins its running END.
    // Two facts, two keys (LESSONS L53).
    const kv = fakeKv({ 'failure-rate-active:wf-1:ACRO': '2026-08-14T22:33:00.000Z' })
    await markSpikeSeen(kv, 'failure-rate', 'wf-1:ACRO', Date.parse('2026-08-15T03:04:00.000Z'))
    expect(kv.store.get('failure-rate-active:wf-1:ACRO')).toBe('2026-08-15T03:04:00.000Z')
  })

  it('does not disturb the alert marker', async () => {
    const kv = fakeKv({ 'failure-rate-recovery:wf-1:ACRO': '2026-08-14T21:32:00.000Z' })
    await markSpikeSeen(kv, 'failure-rate', 'wf-1:ACRO', Date.parse('2026-08-14T22:33:00.000Z'))
    expect(kv.store.get('failure-rate-recovery:wf-1:ACRO')).toBe('2026-08-14T21:32:00.000Z')
  })
})

describe('announceRecovery re-arm window (#814)', () => {
  const START = '2026-08-15T01:32:00.000Z' // 9:32 PM EDT, first page
  const LAST_FAIL = '2026-08-15T02:40:00.000Z' // 10:40 PM EDT, failures stop
  const seeded = () =>
    fakeKv({
      'failure-rate-recovery:wf-1:ACRO': START,
      'failure-rate-active:wf-1:ACRO': LAST_FAIL,
      'failure-rate-cooldown:wf-1:ACRO': '1',
    })
  const call = (kv: ReturnType<typeof fakeKv>, send: (a: string, e: string | null) => Promise<boolean>, now: string) =>
    announceRecovery(kv, 'failure-rate', 'wf-1:ACRO', 'failure-rate-cooldown:wf-1:ACRO', ORG, send, {
      now: Date.parse(now),
    })

  it('HOLDS the all-clear while inside the re-arm window', async () => {
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    // 10:45 PM EDT: five minutes of quiet is not an ended outage.
    expect(await call(kv, send, '2026-08-15T02:45:00.000Z')).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO')).toBe(true)
  })

  it('does NOT clear the cooldown while holding, so a relapse stays deduped', async () => {
    const kv = seeded()
    await call(kv, vi.fn().mockResolvedValue(true), '2026-08-15T02:45:00.000Z')
    expect(kv.store.has('failure-rate-cooldown:wf-1:ACRO')).toBe(true)
  })

  it('announces once the re-arm window has elapsed with no relapse', async () => {
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    expect(await call(kv, send, '2026-08-15T03:11:00.000Z')).toBe(true)
    // No healthy tick asked before this one, so this is the first healthy check (#2580).
    expect(send).toHaveBeenCalledWith(START, LAST_FAIL, '2026-08-15T03:11:00.000Z')
  })

  it('reports the end as the last observed failure, not the announcement time', async () => {
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    await call(kv, send, '2026-08-15T02:45:00.000Z') // the first healthy tick, held
    await call(kv, send, '2026-08-15T05:00:00.000Z') // announced hours later
    expect(send).toHaveBeenCalledWith(START, LAST_FAIL, '2026-08-15T02:45:00.000Z')
  })

  it('a relapse inside the window continues the SAME incident', async () => {
    // The Aug 14 sequence: quiet at 10:40, relapse at 11:04, quiet after.
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    await call(kv, send, '2026-08-15T02:50:00.000Z')
    expect(send).not.toHaveBeenCalled()

    const relapse = '2026-08-15T03:04:00.000Z'
    await markSpikeSeen(kv, 'failure-rate', 'wf-1:ACRO', Date.parse(relapse))
    await call(kv, send, '2026-08-15T03:20:00.000Z') // still inside the window
    expect(send).not.toHaveBeenCalled()

    expect(await call(kv, send, '2026-08-15T03:35:00.000Z')).toBe(true)
    // One incident: 9:32 PM to 11:04 PM, not a five minute blip, first seen clear
    // by the 11:20 tick, the first healthy one after the relapse.
    expect(send).toHaveBeenCalledWith(START, relapse, '2026-08-15T03:20:00.000Z')
  })

  it('clears the running-end key with the rest once announced', async () => {
    const kv = seeded()
    await call(kv, vi.fn().mockResolvedValue(true), '2026-08-15T03:11:00.000Z')
    expect(kv.store.has('failure-rate-active:wf-1:ACRO')).toBe(false)
  })

  it('keeps the running-end key when the all-clear failed to deliver', async () => {
    const kv = seeded()
    await call(kv, vi.fn().mockResolvedValue(false), '2026-08-15T03:11:00.000Z')
    expect(kv.store.get('failure-rate-active:wf-1:ACRO')).toBe(LAST_FAIL)
  })

  it('announces with a null end when no running-end was ever recorded', async () => {
    // A marker written by the previous deploy has no companion key. It must not
    // hold silently forever; say nothing about the end rather than invent one.
    const kv = fakeKv({ 'failure-rate-recovery:wf-1:ACRO': START })
    const send = vi.fn().mockResolvedValue(true)
    expect(await call(kv, send, '2026-08-15T02:45:00.000Z')).toBe(true)
    expect(send).toHaveBeenCalledWith(START, null, null)
  })

  it('announces with a null end when the running-end is unparseable', async () => {
    const kv = fakeKv({
      'failure-rate-recovery:wf-1:ACRO': START,
      'failure-rate-active:wf-1:ACRO': 'not-a-date',
    })
    const send = vi.fn().mockResolvedValue(true)
    expect(await call(kv, send, '2026-08-15T02:45:00.000Z')).toBe(true)
    expect(send).toHaveBeenCalledWith(START, null, null)
  })

  it('honours a caller-supplied re-arm window', async () => {
    // failure-rate signals carry their own cooldown; the incident must not be
    // declared over while a repeat page for it is still suppressed.
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    const at = (now: string, rearmMinutes: number) =>
      announceRecovery(kv, 'failure-rate', 'wf-1:ACRO', 'failure-rate-cooldown:wf-1:ACRO', ORG, send, {
        now: Date.parse(now),
        rearmMinutes,
      })
    expect(await at('2026-08-15T03:20:00.000Z', 60)).toBe(false)
    expect(await at('2026-08-15T03:45:00.000Z', 60)).toBe(true)
  })

  it('defaults the window to at least the alert cooldown', () => {
    expect(RECOVERY_REARM_MINUTES).toBeGreaterThanOrEqual(30)
  })
})

/**
 * #1267. A check that sends ONE all-clear for several ids needs the decision
 * ("is this id's recovery due, and what does it say") apart from the settlement
 * ("that message delivered, close these incidents"). Both halves are the same
 * rules `announceRecovery` applies for a single id, so they are its parts rather
 * than a second copy of them.
 */
describe('recoveryDue and settleRecovery (#1267)', () => {
  const START = '2026-09-10T10:01:15.000Z'
  const seeded = () =>
    fakeKv({
      'field-presence-drought-recovery:wf-1 f': START,
      'field-presence-drought-active:wf-1 f': START,
      'field-presence-drought-cooldown:wf-1 f': '1',
    })

  it('answers null when nothing was ever paged', async () => {
    expect(await recoveryDue(fakeKv(), 'field-presence-drought', 'wf-1 f')).toBeNull()
  })

  it('HOLDS inside the re-arm window, like announceRecovery', async () => {
    const due = await recoveryDue(seeded(), 'field-presence-drought', 'wf-1 f', {
      now: Date.parse('2026-09-10T10:20:00.000Z'),
    })
    expect(due).toBeNull()
  })

  it('answers the first page and the last observed failure once the window has elapsed', async () => {
    const due = await recoveryDue(seeded(), 'field-presence-drought', 'wf-1 f', {
      now: Date.parse('2026-09-10T11:00:05.000Z'),
    })
    expect(due).toEqual({ alertedAt: START, endedAt: START, firstHealthyAt: '2026-09-10T11:00:05.000Z' })
  })

  it('settles nothing on its own, because nothing has been delivered yet: it only records the first healthy check (#2580)', async () => {
    const kv = seeded()
    await recoveryDue(kv, 'field-presence-drought', 'wf-1 f', { now: Date.parse('2026-09-10T11:00:05.000Z') })
    expect(kv.store.size).toBe(4)
    expect(kv.store.get('field-presence-drought-recovery:wf-1 f')).toBe(START)
    expect(kv.store.get('field-presence-drought-active:wf-1 f')).toBe(START)
    expect(kv.store.get('field-presence-drought-cooldown:wf-1 f')).toBe('1')
    expect(kv.store.has(healthyKey('field-presence-drought', 'wf-1 f'))).toBe(true)
  })

  it('settleRecovery clears the marker, the running end and the cooldown', async () => {
    const kv = seeded()
    await settleRecovery(kv, 'field-presence-drought', 'wf-1 f', 'field-presence-drought-cooldown:wf-1 f', { ...ORG, reason: 'all_clear' }, NOW_MS)
    // Only the incident record's ended event is left (#2099), for the drain to take.
    expect([...kv.store.keys()].map((k) => k.split(':')[0])).toEqual(['incident-outbox'])
  })
})

describe('keepAlerted (#1274)', () => {
  // markAlerted pins the start and is called only on a page. keepAlerted takes the
  // start the caller already knows and re-writes the SAME start time on every
  // sighting, whether or not it paged, so a block re-observed between pages still
  // refreshes the marker without moving the start.
  it('writes the given start time with the recovery TTL, and again on the next call', async () => {
    const kv = fakeKv()
    const put = vi.spyOn(kv, 'put')
    await keepAlerted(kv, 'partner-reachability', 'host', '2026-09-05T06:00:00.000Z', PLATFORM, NOW_MS)
    await keepAlerted(kv, 'partner-reachability', 'host', '2026-09-05T06:00:00.000Z', PLATFORM, NOW_MS)
    expect(kv.store.get(recoveryKey('partner-reachability', 'host'))).toBe('2026-09-05T06:00:00.000Z')
    // The marker is written on both calls; the first also records the incident opening.
    expect(put.mock.calls.filter(([k]) => k === recoveryKey('partner-reachability', 'host'))).toHaveLength(2)
    expect(put).toHaveBeenLastCalledWith(recoveryKey('partner-reachability', 'host'), '2026-09-05T06:00:00.000Z', { expirationTtl: RECOVERY_TTL_SECONDS })
  })

  it('does not move an existing earlier start forward', async () => {
    const kv = fakeKv({ [recoveryKey('partner-reachability', 'host')]: '2026-09-05T06:00:00.000Z' })
    await keepAlerted(kv, 'partner-reachability', 'host', '2026-09-06T06:00:00.000Z', PLATFORM, NOW_MS)
    expect(kv.store.get(recoveryKey('partner-reachability', 'host'))).toBe('2026-09-05T06:00:00.000Z')
  })
})

/**
 * #2580. The all-clear named the LAST FAILURE as the moment the condition cleared.
 * The partners page live updates check runs every five minutes: on 2026-10-21 its
 * only failed run paged at 08:01 UTC, the next run (08:05:34) received its notice,
 * and the all-clear at 08:35 said the alert lasted under a minute, "clearing at"
 * 4:01 AM, which is the moment it fired. Nothing was observed clear at 4:01.
 *
 * What the check DID observe is the first healthy run after the last failure, so
 * that run is recorded the first time a healthy run asks whether an all-clear is
 * owed, and handed to the all-clear with the rest.
 */
describe('the first healthy observation after the last sighting (#2580)', () => {
  const PAGED = '2026-10-21T08:01:08.000Z' // the failed run's page, 4:01 AM EDT
  const FIRST_RECEIVED = '2026-10-21T08:05:34.000Z' // the next run, which received its notice
  const ANNOUNCED = '2026-10-21T08:35:40.000Z' // the re-arm window over
  const seeded = () =>
    fakeKv({
      'partner-page-live-recovery:channel': PAGED,
      'partner-page-live-active:channel': PAGED,
    })
  const due = (kv: ReturnType<typeof fakeKv>, now: string) =>
    recoveryDue(kv, 'partner-page-live', 'channel', { now: Date.parse(now) })

  it('records the first healthy run inside the re-arm window and hands it to the all-clear', async () => {
    const kv = seeded()
    expect(await due(kv, FIRST_RECEIVED)).toBeNull()
    expect(await due(kv, '2026-10-21T08:10:31.000Z')).toBeNull() // a later healthy run does not move it
    expect(await due(kv, ANNOUNCED)).toEqual({ alertedAt: PAGED, endedAt: PAGED, firstHealthyAt: FIRST_RECEIVED })
  })

  it('belongs to the LAST sighting: a relapse after it is followed by a new first healthy run', async () => {
    const kv = seeded()
    await due(kv, FIRST_RECEIVED)
    const relapse = '2026-10-21T08:10:40.000Z'
    await markSpikeSeen(kv, 'partner-page-live', 'channel', Date.parse(relapse))
    await due(kv, '2026-10-21T08:15:33.000Z')
    expect(await due(kv, '2026-10-21T08:46:00.000Z')).toEqual({
      alertedAt: PAGED,
      endedAt: relapse,
      firstHealthyAt: '2026-10-21T08:15:33.000Z',
    })
  })

  it('records nothing on a call at or before the last sighting, which is no healthy observation', async () => {
    const kv = seeded()
    expect(await due(kv, PAGED)).toBeNull()
    expect(kv.store.has(healthyKey('partner-page-live', 'channel'))).toBe(false)
  })

  it('names no first healthy run when no running end was recorded, since there is nothing it came after', async () => {
    const kv = fakeKv({ 'partner-page-live-recovery:channel': PAGED })
    expect(await due(kv, ANNOUNCED)).toEqual({ alertedAt: PAGED, endedAt: null, firstHealthyAt: null })
  })

  it('reads an unparseable record as absent and records this run instead', async () => {
    const kv = seeded()
    kv.store.set(healthyKey('partner-page-live', 'channel'), 'not json')
    await due(kv, FIRST_RECEIVED)
    expect((await due(kv, ANNOUNCED))?.firstHealthyAt).toBe(FIRST_RECEIVED)
  })

  it('never holds the all-clear when the record cannot be read: it names no first healthy run instead', async () => {
    const kv = seeded()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = kv.get
    kv.get = (k: string) => (k === healthyKey('partner-page-live', 'channel') ? Promise.reject(new Error('KV read refused')) : get(k))
    expect(await due(kv, ANNOUNCED)).toEqual({ alertedAt: PAGED, endedAt: PAGED, firstHealthyAt: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('never holds the all-clear when the record cannot be written either', async () => {
    const kv = seeded()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    kv.put = () => Promise.reject(new Error('KV write refused'))
    expect(await due(kv, ANNOUNCED)).toEqual({ alertedAt: PAGED, endedAt: PAGED, firstHealthyAt: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('announceRecovery passes it to the sender as the third argument', async () => {
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    const call = (now: string) => announceRecovery(kv, 'partner-page-live', 'channel', null, PLATFORM, send, { now: Date.parse(now) })
    expect(await call(FIRST_RECEIVED)).toBe(false)
    expect(await call(ANNOUNCED)).toBe(true)
    expect(send).toHaveBeenCalledWith(PAGED, PAGED, FIRST_RECEIVED)
  })

  it('settleRecovery removes it with the other markers', async () => {
    const kv = seeded()
    await due(kv, FIRST_RECEIVED)
    await settleRecovery(kv, 'partner-page-live', 'channel', null, { ...PLATFORM, reason: 'all_clear' }, Date.parse(ANNOUNCED))
    expect(kv.store.has(healthyKey('partner-page-live', 'channel'))).toBe(false)
  })
})
