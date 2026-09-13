import { describe, it, expect, vi } from 'vitest'
import {
  BACKOFF_STEPS_SECONDS,
  CONDITION_TTL_SECONDS,
  intervalSecondsFor,
  readCondition,
  recordAlert,
  clearCondition,
  describeRepeat,
} from '../alert-backoff'

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const H = 3_600_000

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

describe('intervalSecondsFor', () => {
  it('walks the schedule as a condition keeps standing', () => {
    // The whole point: the second reminder is not as soon as the first.
    expect(intervalSecondsFor(0)).toBe(BACKOFF_STEPS_SECONDS[0])
    expect(intervalSecondsFor(1)).toBe(BACKOFF_STEPS_SECONDS[1])
    expect(intervalSecondsFor(2)).toBe(BACKOFF_STEPS_SECONDS[2])
  })

  it('holds at the last step rather than going silent, so a standing outage is still reported', () => {
    const last = BACKOFF_STEPS_SECONDS[BACKOFF_STEPS_SECONDS.length - 1]
    expect(intervalSecondsFor(3)).toBe(last)
    expect(intervalSecondsFor(50)).toBe(last)
    expect(intervalSecondsFor(5000)).toBe(last)
  })

  it('escalates strictly, and caps at a day so nothing waits longer than that', () => {
    for (let i = 1; i < BACKOFF_STEPS_SECONDS.length; i++) {
      expect(BACKOFF_STEPS_SECONDS[i]).toBeGreaterThan(BACKOFF_STEPS_SECONDS[i - 1])
    }
    expect(BACKOFF_STEPS_SECONDS[BACKOFF_STEPS_SECONDS.length - 1]).toBeLessThanOrEqual(24 * 60 * 60)
  })

  it('treats a negative or fractional count as the first alert rather than throwing', () => {
    expect(intervalSecondsFor(-1)).toBe(BACKOFF_STEPS_SECONDS[0])
    expect(intervalSecondsFor(1.5)).toBe(BACKOFF_STEPS_SECONDS[1])
  })
})

describe('readCondition', () => {
  it('reports no standing condition when nothing is stored', async () => {
    const kv = fakeKv()
    expect(await readCondition(kv, 'k')).toBeNull()
  })

  it('reads back what recordAlert wrote', async () => {
    const kv = fakeKv()
    await recordAlert(kv, 'k', null, NOW)
    const c = await readCondition(kv, 'k')
    expect(c).toEqual({ since: new Date(NOW).toISOString(), alerts: 1 })
  })

  it('treats an unreadable record as no condition rather than throwing', async () => {
    // A corrupt record must not be able to stop the check that reads it.
    const kv = fakeKv({ 'k:condition': 'not json' })
    expect(await readCondition(kv, 'k')).toBeNull()
  })

  it('treats a record missing its fields as no condition', async () => {
    const kv = fakeKv({ 'k:condition': '{"alerts":"three"}' })
    expect(await readCondition(kv, 'k')).toBeNull()
  })
})

describe('recordAlert', () => {
  it('keeps the ORIGINAL first-detected time across reminders, so the age is of the condition', async () => {
    const kv = fakeKv()
    const first = await recordAlert(kv, 'k', null, NOW)
    const second = await recordAlert(kv, 'k', first, NOW + 6 * H)

    expect(second.since).toBe(first.since)
    expect(second.alerts).toBe(2)
  })

  it('sets each reminder cooldown from the number already sent, so the gap grows', async () => {
    const kv = fakeKv()
    const first = await recordAlert(kv, 'k', null, NOW)
    expect(kv.ttls.get('k:cooldown')).toBe(BACKOFF_STEPS_SECONDS[0])

    await recordAlert(kv, 'k', first, NOW + 6 * H)
    expect(kv.ttls.get('k:cooldown')).toBe(BACKOFF_STEPS_SECONDS[1])
  })

  it('gives the condition record a long but finite life, so an orphan expires', async () => {
    const kv = fakeKv()
    await recordAlert(kv, 'k', null, NOW)
    expect(kv.ttls.get('k:condition')).toBe(CONDITION_TTL_SECONDS)
    expect(CONDITION_TTL_SECONDS).toBeGreaterThan(BACKOFF_STEPS_SECONDS[BACKOFF_STEPS_SECONDS.length - 1])
  })
})

describe('clearCondition', () => {
  it('removes both the condition and the cooldown, so a recovery resets the schedule', async () => {
    const kv = fakeKv()
    await recordAlert(kv, 'k', null, NOW)
    await recordAlert(kv, 'k', await readCondition(kv, 'k'), NOW + H)

    await clearCondition(kv, 'k')

    expect(await readCondition(kv, 'k')).toBeNull()
    expect(kv.store.has('k:cooldown')).toBe(false)
    // And the next occurrence starts again at the shortest interval.
    await recordAlert(kv, 'k', null, NOW + 2 * H)
    expect(kv.ttls.get('k:cooldown')).toBe(BACKOFF_STEPS_SECONDS[0])
  })

  it('is safe to call when there was never a condition', async () => {
    const kv = fakeKv()
    await expect(clearCondition(kv, 'k')).resolves.toBeUndefined()
  })
})

describe('describeRepeat', () => {
  it('says nothing for a first report, which is not a repeat', () => {
    expect(describeRepeat(null, NOW)).toBeNull()
  })

  it('names which reminder this is, how long the condition has stood, and when the next one is due', () => {
    const standing = { since: new Date(NOW - 26 * H).toISOString(), alerts: 2 }
    const text = describeRepeat(standing, NOW)

    expect(text).toContain('reminder 3')
    expect(text).toContain('26h')
    // Stated so a reader can tell silence from recovery.
    expect(text).toContain('24h')
  })

  it('does not claim an age it could not compute', () => {
    const text = describeRepeat({ since: 'not a date', alerts: 1 }, NOW)
    expect(text).not.toMatch(/NaN/)
  })
})
