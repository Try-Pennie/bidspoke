import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({
  getSlackConnection: vi.fn(),
  postMessage: vi.fn().mockResolvedValue('ts-1'),
}))

import {
  isUnrecoverableOutcomeLoss,
  recordDeadLetterVolume,
  evaluateBuildNow,
  runDeadLetterBuildTriggerCheck,
  BUILD_NOW_DAILY_VOLUME,
  BUILD_NOW_VOLUME_DAYS,
  utcDay,
} from '../deadletter-volume'
import { getSlackConnection, postMessage } from '../slack'
import { alertRowListAnswer } from '../../__tests__/helpers/slack-alert-read'

const NOW = Date.parse('2026-10-11T13:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v)
      ttls.set(k, opts?.expirationTtl)
    }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

// A supabase double that reports one Slack org.
const fakeSupabase = {
  from: () => ({ select: () => alertRowListAnswer({ data: [{ organization_id: 'org-1' }], error: null }) }),
} as never

const slackOn = { bot_token: 't', default_channel: '#alerts', config_alerts_enabled: true }

describe('isUnrecoverableOutcomeLoss (#355)', () => {
  it('counts the must-not-lose row inserts the drains cannot rebuild', () => {
    expect(isUnrecoverableOutcomeLoss('lead_sightings.insert')).toBe(true)
    expect(isUnrecoverableOutcomeLoss('lead_sighting_bids.insert')).toBe(true)
  })

  it('does not count the finalize losses the drains reconstruct, nor the tier-3 writeback', () => {
    expect(isUnrecoverableOutcomeLoss('execution_finalize')).toBe(false)
    expect(isUnrecoverableOutcomeLoss('lead_sightings.finalize')).toBe(false)
    expect(isUnrecoverableOutcomeLoss('sf_writeback')).toBe(false)
    expect(isUnrecoverableOutcomeLoss('continuation_unfinished')).toBe(false)
  })
})

describe('recordDeadLetterVolume (#355)', () => {
  it('tallies total and unrecoverable into the loss UTC day', async () => {
    const kv = fakeKv()
    await recordDeadLetterVolume(kv, 'lead_sightings.insert', NOW)
    await recordDeadLetterVolume(kv, 'execution_finalize', NOW)
    const raw = kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)
    expect(JSON.parse(raw!)).toEqual({ total: 2, unrecoverable: 1, labels: { 'lead_sightings.insert': 1, execution_finalize: 1 } })
  })

  it('keeps separate tallies per day and gives them a finite, multi-day life', async () => {
    const kv = fakeKv()
    await recordDeadLetterVolume(kv, 'execution_finalize', NOW)
    await recordDeadLetterVolume(kv, 'execution_finalize', NOW - DAY)
    expect(JSON.parse(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)!).total).toBe(1)
    expect(JSON.parse(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW - DAY)}`)!).total).toBe(1)
    expect(kv.ttls.get(`outcome-deadletter-daily:${utcDay(NOW)}`)).toBeGreaterThan(BUILD_NOW_VOLUME_DAYS * DAY / 1000)
  })
})

describe('evaluateBuildNow (#355)', () => {
  it('does not trip on a quiet history', async () => {
    const kv = fakeKv()
    const v = await evaluateBuildNow(kv, NOW)
    expect(v.tripped).toBe(false)
    expect(v.reasons).toEqual([])
  })

  it('trips on a single unrecoverable loss in the recent window', async () => {
    const kv = fakeKv({ [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }) })
    const v = await evaluateBuildNow(kv, NOW)
    expect(v.tripped).toBe(true)
    expect(v.reasons).toContain('unrecoverable-loss')
  })

  it('trips on sustained volume across every COMPLETED day, judging yesterday back, not today', async () => {
    const seed: Record<string, string> = {}
    // The completed days (yesterday .. -3) all clear the bar; today is left empty
    // to prove it is not required for the volume half.
    for (let i = 1; i <= BUILD_NOW_VOLUME_DAYS; i++) {
      seed[`outcome-deadletter-daily:${utcDay(NOW - i * DAY)}`] = JSON.stringify({ total: BUILD_NOW_DAILY_VOLUME, unrecoverable: 0 })
    }
    const v = await evaluateBuildNow(kv_(seed), NOW)
    expect(v.tripped).toBe(true)
    expect(v.reasons).toContain('sustained-volume')
    expect(v.reasons).not.toContain('unrecoverable-loss')
  })

  it('does NOT trip on volume when a completed day is below the bar, and does NOT count today', async () => {
    const seed: Record<string, string> = {}
    // Today is high, but the third completed day back is below the bar, so the
    // volume half must not trip: today is excluded and the short completed day counts.
    seed[`outcome-deadletter-daily:${utcDay(NOW)}`] = JSON.stringify({ total: BUILD_NOW_DAILY_VOLUME + 10, unrecoverable: 0 })
    seed[`outcome-deadletter-daily:${utcDay(NOW - 1 * DAY)}`] = JSON.stringify({ total: BUILD_NOW_DAILY_VOLUME, unrecoverable: 0 })
    seed[`outcome-deadletter-daily:${utcDay(NOW - 2 * DAY)}`] = JSON.stringify({ total: BUILD_NOW_DAILY_VOLUME, unrecoverable: 0 })
    seed[`outcome-deadletter-daily:${utcDay(NOW - 3 * DAY)}`] = JSON.stringify({ total: BUILD_NOW_DAILY_VOLUME - 1, unrecoverable: 0 })
    const v = await evaluateBuildNow(kv_(seed), NOW)
    expect(v.tripped).toBe(false)
  })
})

function kv_(seed: Record<string, string>) { return fakeKv(seed) }

describe('runDeadLetterBuildTriggerCheck (#355)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(slackOn as never)
    vi.mocked(postMessage).mockResolvedValue('ts-1')
  })

  it('stays silent when the condition has not been met', async () => {
    const kv = fakeKv()
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('posts a build-now alert when an unrecoverable loss is on record', async () => {
    const kv = fakeKv({ [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }) })
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const text = JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])
    expect(text).toMatch(/durable outcome store|build-now|build the/i)
  })

  // #835: the fix line told the reader to move finalizeSighting out of waitUntil
  // "or the 09:00 export", whatever had been counted. The tally counts every
  // confirmed database loss (the finalize kinds the drains rebuild included;
  // failed Salesforce updates are not counted since #2087), and the sightings
  // export runs every two hours. The alert now
  // says which kinds were counted, and the fix starts from them.
  // Review of #2082: the fix line pointed at "the kinds counted above" even when
  // no kinds line was printed, on a standing reminder whose tallies had aged out
  // and on tallies written before the per-kind count existed.
  it.each([
    ['a standing reminder whose tallies aged out', { 'outcome-deadletter-buildnow-tripped': '2026-10-01T13:00:00.000Z' }],
    ['a tally written before kinds were counted', { [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }) }],
  ])('does not point at a kinds line it did not print: %s', async (_case, seed) => {
    const kv = fakeKv(seed as Record<string, string>)
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(true)
    const text = JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])
    expect(text).not.toContain('Counted by kind')
    expect(text).not.toContain('counted above')
    expect(text).toContain('Upgrade path')
  })

  it('names the kinds of dead letter that were counted, and no stale schedule', async () => {
    const kv = fakeKv()
    await recordDeadLetterVolume(kv, 'lead_sightings.insert', NOW)
    await recordDeadLetterVolume(kv, 'lead_sightings.finalize', NOW)
    await recordDeadLetterVolume(kv, 'lead_sightings.finalize', NOW)
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(true)
    const text = JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])
    expect(text).toContain('lead_sightings.insert 1')
    expect(text).toContain('lead_sightings.finalize 2')
    expect(text).not.toContain('09:00')
    expect(text).not.toContain('finalizeSighting out of waitUntil')
  })

  it('suppresses a repeat while the cooldown is set', async () => {
    const kv = fakeKv({
      [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }),
      'outcome-deadletter-buildnow-cooldown': '1',
    })
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  // #355: a one-off unrecoverable loss ages out of the day tallies in a few days,
  // but the build-now reminder must not be forgotten after a single alert.
  it('keeps reminding after the condition ages out, via the durable trip mark', async () => {
    const kv = fakeKv({ [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }) })
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(true)
    expect(kv.store.has('outcome-deadletter-buildnow-tripped')).toBe(true)

    // The day tally ages out and the weekly cooldown lapses; the live condition is
    // gone, but the durable mark holds, so the reminder still fires.
    kv.store.delete(`outcome-deadletter-daily:${utcDay(NOW)}`)
    kv.store.delete('outcome-deadletter-buildnow-cooldown')
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW + 8 * DAY)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('stays silent and clears the trip mark once the durable store is built', async () => {
    const kv = fakeKv({
      [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }),
      'outcome-deadletter-buildnow-tripped': '2026-10-01T00:00:00.000Z',
    })
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW, true)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
    expect(kv.store.has('outcome-deadletter-buildnow-tripped')).toBe(false)
  })

  it('logs, rather than swallows, a failed clear of the trip mark once the store is built', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const kv = fakeKv({ 'outcome-deadletter-buildnow-tripped': '2026-10-01T00:00:00.000Z' })
      kv.delete = vi.fn(async () => { throw new Error('kv down') })
      expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW, true)).toBe(false)
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('clearing the trip mark failed'))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('does not set the cooldown when the Slack post fails, so the next run retries', async () => {
    vi.mocked(postMessage).mockResolvedValue(null)
    const kv = fakeKv({ [`outcome-deadletter-daily:${utcDay(NOW)}`]: JSON.stringify({ total: 1, unrecoverable: 1 }) })
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(false)
    expect(kv.store.has('outcome-deadletter-buildnow-cooldown')).toBe(false)
  })

  it('does not count an unfinished continuation toward the volume bar, since it is not a loss', async () => {
    const kv = fakeKv()
    await recordDeadLetterVolume(kv, 'continuation_unfinished', NOW)
    expect(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)).toBeUndefined()
    await recordDeadLetterVolume(kv, 'lead_sightings.finalize', NOW)
    expect(JSON.parse(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)!)).toEqual({ total: 1, unrecoverable: 0, labels: { 'lead_sightings.finalize': 1 } })
  })

  // #2087 (Dan, 2026-10-14): a failed Salesforce update has its own alerts and
  // the replay tool, and this alarm's fix is about our own database, so it does
  // not count toward the volume bar. A failure to save into our replay store is
  // a database write and still counts.
  // A day tally written before #2087 still holds Salesforce updates for up to
  // 6 days; it is corrected where it is read, so it cannot trip the bar.
  it('discounts Salesforce updates already in a stored day tally', async () => {
    const days = [1, 2, 3, 4, 5, 6].map((n) => utcDay(NOW - n * 86_400_000))
    const kv = fakeKv(Object.fromEntries(days.map((d) => [
      `outcome-deadletter-daily:${d}`,
      JSON.stringify({ total: 100, unrecoverable: 0, labels: { sf_writeback: 100 } }),
    ])))
    expect(await runDeadLetterBuildTriggerCheck(kv, fakeSupabase, 'https://app.test', NOW)).toBe(false)
  })

  it('does not count a failed Salesforce update toward the volume bar', async () => {
    const kv = fakeKv()
    await recordDeadLetterVolume(kv, 'sf_writeback', NOW)
    await recordDeadLetterVolume(kv, 'outcome_writeback_deadletters.uncapturable', NOW)
    // A held update (#2163) is a Salesforce update with an unknown outcome, not a database loss.
    await recordDeadLetterVolume(kv, 'sf_writeback.held', NOW)
    expect(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)).toBeUndefined()
    await recordDeadLetterVolume(kv, 'outcome_writeback_deadletters.insert', NOW)
    expect(JSON.parse(kv.store.get(`outcome-deadletter-daily:${utcDay(NOW)}`)!)).toEqual({ total: 1, unrecoverable: 0, labels: { 'outcome_writeback_deadletters.insert': 1 } })
  })
})
