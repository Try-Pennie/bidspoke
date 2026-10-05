import { describe, it, expect, vi } from 'vitest'
import {
  BACKOFF_STEPS_SECONDS,
  CONDITION_TTL_SECONDS,
  intervalSecondsFor,
  readCondition,
  recordAlert,
  clearCondition,
  describeRepeat,
  touchCondition,
  backoffCooldownKey,
  fingerprintAlert,
  meaningOf,
  nextFingerprint,
  recurrenceOf,
  MAX_REMEMBERED_KEYS,
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

describe('the schedule has one home (#1761)', () => {
  it('is read from alert-backoff-schedule.json, which Deploy Drift also reads, so the two cannot drift apart', async () => {
    // Deploy Drift backs off on GitHub's side (it cannot depend on this worker,
    // whose death it reports, L71) and reads the same file with jq (L41).
    const schedule = (await import('../alert-backoff-schedule.json')).default as { stepsSeconds: number[] }
    expect(BACKOFF_STEPS_SECONDS).toEqual(schedule.stepsSeconds)
    expect(schedule.stepsSeconds).toEqual([6 * 3600, 12 * 3600, 24 * 3600])
  })
})

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
    expect(describeRepeat(null, NOW, true)).toBeNull()
  })

  it('names which reminder this is, how long the condition has stood, and when the next one is due', () => {
    const standing = { since: new Date(NOW - 26 * H).toISOString(), alerts: 2 }
    const text = describeRepeat(standing, NOW, true)

    expect(text).toContain('reminder 3')
    expect(text).toContain('26h')
    // Stated so a reader can tell silence from recovery.
    expect(text).toContain('24h')
  })

  it('does not claim an age it could not compute', () => {
    const text = describeRepeat({ since: 'not a date', alerts: 1 }, NOW, true)
    expect(text).not.toMatch(/NaN/)
  })

  it('says nothing has changed only when the caller measured that it has not (#1768, L641)', () => {
    const standing = { since: new Date(NOW - 26 * H).toISOString(), alerts: 2 }
    expect(describeRepeat(standing, NOW, true)).toContain('nothing about it has changed')

    const changed = describeRepeat(standing, NOW, false)
    expect(changed).not.toContain('nothing about it has changed')
    expect(changed).toContain('same problem')
    expect(changed).toContain('reminder 3')
    expect(changed).toContain('26h')
  })
})

// The Lead status check posted three different problems on Oct 3, 4 and 5, and
// the second and third were labelled "(still)" and "nothing about it has
// changed", because the standing condition was keyed on the job alone (#1768).
describe('fingerprintAlert and recurrenceOf (#1768)', () => {
  const TITLE = "Some sales aren't showing on their Salesforce Lead"
  const OCT_3 = ['2 Tripoint sales from Sep 25 to Sep 27 are marked Completed on their Submission, but their Lead still says Fail.']
  const OCT_4 = ['1 Tripoint sale from Sep 30 is marked Completed on its Submission, but its Lead still says Fail.']

  const standingFor = async (title: string, findings: string[], keys?: string[]) => ({
    since: new Date(NOW - 24 * H).toISOString(),
    alerts: 1,
    fingerprint: await fingerprintAlert({ title, findings, keys }),
  })

  it('ignores the order and repeats of the findings', async () => {
    const a = await fingerprintAlert({ title: TITLE, findings: ['x', 'y'] })
    const b = await fingerprintAlert({ title: TITLE, findings: ['y', 'x', 'y'] })
    expect(a).toEqual(b)
  })

  it('reads nothing standing as a new condition', async () => {
    expect(recurrenceOf(null, await fingerprintAlert({ title: TITLE, findings: OCT_3 }))).toEqual({ kind: 'new' })
  })

  it('reads the same title and findings as a reminder about an unchanged condition', async () => {
    const standing = await standingFor(TITLE, OCT_3)
    expect(recurrenceOf(standing, await fingerprintAlert({ title: TITLE, findings: OCT_3 }))).toEqual({ kind: 'reminder', standing, unchanged: true })
  })

  it('reads a different finding as a new condition, as Oct 4 should have been', async () => {
    const standing = await standingFor(TITLE, OCT_3)
    expect(recurrenceOf(standing, await fingerprintAlert({ title: TITLE, findings: OCT_4 })).kind).toBe('new')
  })

  it('reads a different title as a new condition, as Oct 5 should have been', async () => {
    const standing = await standingFor(TITLE, OCT_3)
    const oct5 = await fingerprintAlert({ title: "The Lead status check couldn't check everything", findings: OCT_3 })
    expect(recurrenceOf(standing, oct5).kind).toBe('new')
  })

  it('reads findings that are all ones already posted as a reminder, never claiming nothing changed', async () => {
    // One of the two cleared: nothing new to report, so the reminder schedule holds.
    const standing = await standingFor(TITLE, ['a', 'b'])
    expect(recurrenceOf(standing, await fingerprintAlert({ title: TITLE, findings: ['a'] }))).toEqual({ kind: 'reminder', standing, unchanged: false })
  })

  it('matches on the keys a caller gives, and still tells whether the words changed', async () => {
    // The judged day moves every run while the problem stays the same.
    const standing = await standingFor(TITLE, ['Liberty1 had no sales on Oct 5.'], ['zero:Liberty1'])
    const nextDay = await fingerprintAlert({ title: TITLE, findings: ['Liberty1 had no sales on Oct 6.'], keys: ['zero:Liberty1'] })
    expect(recurrenceOf(standing, nextDay)).toEqual({ kind: 'reminder', standing, unchanged: false })
  })

  it('reads a record written before fingerprints as unknown, never as a reminder (L50)', async () => {
    const legacy = { since: new Date(NOW - 24 * H).toISOString(), alerts: 2 }
    expect(recurrenceOf(legacy, await fingerprintAlert({ title: TITLE, findings: OCT_3 }))).toEqual({ kind: 'unknown', standing: legacy })
  })

  it('stores the fingerprint with the condition and reads it back', async () => {
    const kv = fakeKv()
    const fingerprint = await fingerprintAlert({ title: TITLE, findings: OCT_3 })
    await recordAlert(kv, 'k', null, NOW, { fingerprint })
    expect(await readCondition(kv, 'k')).toEqual({ since: new Date(NOW).toISOString(), alerts: 1, fingerprint })
  })

  it('reads a legacy record, and one whose fingerprint is damaged, with no fingerprint', async () => {
    const legacy = fakeKv({ 'k:condition': JSON.stringify({ since: new Date(NOW).toISOString(), alerts: 3 }) })
    expect(await readCondition(legacy, 'k')).toEqual({ since: new Date(NOW).toISOString(), alerts: 3 })

    const damaged = fakeKv({ 'k:condition': JSON.stringify({ since: new Date(NOW).toISOString(), alerts: 3, fingerprint: { text: 7, keys: 'x' } }) })
    expect(await readCondition(damaged, 'k')).toEqual({ since: new Date(NOW).toISOString(), alerts: 3 })
  })

  it('reads numbers, uuids and hex ids as one placeholder by default, so a ticking count is the same problem', async () => {
    // Measured shapes: the buyer sale drain's age at minute resolution, a click
    // check's counts and percent, a Snowflake statement handle in an error.
    expect(meaningOf('3 sales waiting, the oldest 61 minutes old.')).toBe(meaningOf('4 sales waiting, the oldest 62 minutes old.'))
    expect(meaningOf('Only 1,033 of 1,035 reached their Lead (99.8%).')).toBe(meaningOf('Only 7 of 63 reached their Lead (11%).'))
    expect(meaningOf('statement 01b7c2a1-0003-0b38-0000-0001234ab5c6 failed')).toBe(meaningOf('statement 01b7c2f9-0003-0c11-0000-00019988aa01 failed'))
    expect(meaningOf('request 8c1f2a3b4c5d6e7f timed out')).toBe(meaningOf('request 9d00e1f2a3b4c5d6 timed out'))
    const standing = await standingFor(TITLE, ['3 sales waiting, the oldest 61 minutes old.'])
    const later = await fingerprintAlert({ title: TITLE, findings: ['4 sales waiting, the oldest 62 minutes old.'] })
    expect(recurrenceOf(standing, later)).toEqual({ kind: 'reminder', standing, unchanged: false })
  })

  it('reads a duration in any of its phrasings as one, so an age that grows is the same problem', () => {
    // describeDuration's forms, as the buyer sale drain words its oldest entry,
    // and the compact forms other checks use.
    const age = (d: string) => meaningOf(`liberty1: 3 entries not yet copied to buyer_sales, oldest ${d} old`)
    const forms = ['under a minute', '1 minute', '59 minutes', '1 hour', '2 hours', '1 hour 1 minute', '3 hours 12 minutes', '26h', '45m']
    expect(new Set(forms.map(age)).size).toBe(1)
  })

  it('reads a count with its noun in the singular or the plural as one', () => {
    expect(meaningOf('1 sale waiting')).toBe(meaningOf('2 sales waiting'))
    expect(meaningOf('1 row set aside')).toBe(meaningOf('40 rows set aside'))
  })

  it('keeps the words, so findings about two partners stay two problems', () => {
    expect(meaningOf('Liberty1 had no sales.')).not.toBe(meaningOf('Dot818 had no sales.'))
    expect(meaningOf('Tripoint had no sales.')).not.toBe(meaningOf('AmOne had no sales.'))
  })

  it('remembers every problem posted while the condition stood, so a finding that comes back is not new again', async () => {
    const first = await fingerprintAlert({ title: TITLE, findings: ['a'] })
    const second = await fingerprintAlert({ title: TITLE, findings: ['b'] })
    // b was new; posting it keeps a too.
    const standing = { since: new Date(NOW).toISOString(), alerts: 1, fingerprint: nextFingerprint({ since: '', alerts: 1, fingerprint: first }, second) }
    expect(recurrenceOf(standing, first).kind).toBe('reminder')
    expect(recurrenceOf(standing, second).kind).toBe('reminder')
    expect(recurrenceOf(standing, await fingerprintAlert({ title: TITLE, findings: ['c'] })).kind).toBe('new')
  })

  it('always keeps the current post whole, however many older problems it remembers', async () => {
    const many = await fingerprintAlert({ title: TITLE, findings: Array.from({ length: MAX_REMEMBERED_KEYS + 50 }, (_, i) => `finding ${'x'.repeat(i + 1)}`) })
    const older = await fingerprintAlert({ title: TITLE, findings: Array.from({ length: MAX_REMEMBERED_KEYS + 50 }, (_, i) => `older ${'y'.repeat(i + 1)}`) })
    const next = nextFingerprint({ since: '', alerts: 1, fingerprint: older }, many)
    expect(next.keys.slice(0, many.keys.length)).toEqual(many.keys)
    expect(next.keys.length).toBe(many.keys.length + MAX_REMEMBERED_KEYS)
  })
})

describe('touchCondition (#1274)', () => {
  it('re-arms the record\'s expiry without changing what it says', async () => {
    const kv = fakeKv()
    const standing = await recordAlert(kv, 'k', null, NOW, { conditionTtlSeconds: 3600 })
    await touchCondition(kv, 'k', standing, 7200)
    expect(await readCondition(kv, 'k')).toEqual(standing)
    expect(kv.ttls.get('k:condition')).toBe(7200)
  })

  it('does not touch the cooldown, which belongs to the reminder schedule', async () => {
    const kv = fakeKv()
    const standing = await recordAlert(kv, 'k', null, NOW)
    const before = kv.ttls.get(backoffCooldownKey('k'))
    await touchCondition(kv, 'k', standing, 7200)
    expect(kv.ttls.get(backoffCooldownKey('k'))).toBe(before)
  })
})
