import { describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_TTL_SECONDS,
  announceRecovery,
  markAlerted,
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
    expect(send).toHaveBeenCalledWith('2026-08-14T10:00:00.000Z')
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
