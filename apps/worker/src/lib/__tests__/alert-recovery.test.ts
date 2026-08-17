import { describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_REARM_MINUTES,
  RECOVERY_TTL_SECONDS,
  announceRecovery,
  markAlerted,
  markSpikeSeen,
  recoveryKey,
} from '../alert-recovery'

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
    await markAlerted(kv, 'volume-cliff', 'wf-1')
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBeTruthy()
  })

  it('stores the time the alert fired, so the all-clear can say how long it lasted', async () => {
    const kv = fakeKv()
    await markAlerted(kv, 'volume-cliff', 'wf-1', 1_700_000_000_000)
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('does not overwrite an existing marker, so the all-clear reports the FIRST alert', async () => {
    // A long outage re-alerts after each cooldown lapse. Overwriting would reset
    // the clock and report a minutes-long blip after hours of downtime.
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    await markAlerted(kv, 'volume-cliff', 'wf-1', Date.parse('2026-08-14T13:00:00.000Z'))
    expect(kv.store.get('volume-cliff-recovery:wf-1')).toBe('2026-08-14T10:00:00.000Z')
  })

  it('outlives the 30 minute cooldown by a wide margin', () => {
    expect(RECOVERY_TTL_SECONDS).toBeGreaterThan(30 * 60)
  })
})

describe('announceRecovery', () => {
  it('says nothing when we never alerted', async () => {
    const kv = fakeKv()
    const send = vi.fn().mockResolvedValue(true)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the all-clear when a previously alerted signal is healthy again', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)).toBe(true)
    expect(send).toHaveBeenCalledWith('2026-08-14T10:00:00.000Z', null)
  })

  it('clears the cooldown too, so the next genuine spike pages immediately', async () => {
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z',
      'volume-cliff-cooldown:wf-1': '1',
    })
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', vi.fn().mockResolvedValue(true))
    expect(kv.store.has('volume-cliff-cooldown:wf-1')).toBe(false)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(false)
  })

  it('announces only once, because the marker is gone on the next healthy check', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(true)
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('KEEPS the marker when the all-clear failed to deliver, so it retries', async () => {
    // The mirror of "only start the cooldown once the alert delivered": a kicked
    // bot or a Slack outage during recovery must not swallow the all-clear
    // silently and leave the last word being the page.
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockResolvedValue(false)
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)).toBe(false)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  it('does not clear the cooldown when the all-clear failed to deliver', async () => {
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z',
      'volume-cliff-cooldown:wf-1': '1',
    })
    await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', vi.fn().mockResolvedValue(false))
    expect(kv.store.has('volume-cliff-cooldown:wf-1')).toBe(true)
  })

  it('survives a send that throws, without losing the marker', async () => {
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': '2026-08-14T10:00:00.000Z' })
    const send = vi.fn().mockRejectedValue(new Error('slack exploded'))
    expect(await announceRecovery(kv, 'volume-cliff', 'wf-1', 'volume-cliff-cooldown:wf-1', send)).toBe(false)
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
    announceRecovery(kv, 'failure-rate', 'wf-1:ACRO', 'failure-rate-cooldown:wf-1:ACRO', send, {
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
    expect(send).toHaveBeenCalledWith(START, LAST_FAIL)
  })

  it('reports the end as the last observed failure, not the announcement time', async () => {
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    await call(kv, send, '2026-08-15T05:00:00.000Z') // announced hours later
    expect(send).toHaveBeenCalledWith(START, LAST_FAIL)
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
    // One incident: 9:32 PM to 11:04 PM, not a five minute blip.
    expect(send).toHaveBeenCalledWith(START, relapse)
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
    expect(send).toHaveBeenCalledWith(START, null)
  })

  it('announces with a null end when the running-end is unparseable', async () => {
    const kv = fakeKv({
      'failure-rate-recovery:wf-1:ACRO': START,
      'failure-rate-active:wf-1:ACRO': 'not-a-date',
    })
    const send = vi.fn().mockResolvedValue(true)
    expect(await call(kv, send, '2026-08-15T02:45:00.000Z')).toBe(true)
    expect(send).toHaveBeenCalledWith(START, null)
  })

  it('honours a caller-supplied re-arm window', async () => {
    // failure-rate signals carry their own cooldown; the incident must not be
    // declared over while a repeat page for it is still suppressed.
    const kv = seeded()
    const send = vi.fn().mockResolvedValue(true)
    const at = (now: string, rearmMinutes: number) =>
      announceRecovery(kv, 'failure-rate', 'wf-1:ACRO', 'failure-rate-cooldown:wf-1:ACRO', send, {
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
