/**
 * The one age rule every stored outage copy is served under (#1847).
 *
 * A stored copy (a last-good copy kept in KV and read only when the database
 * read fails) is served for at most STORED_COPY_MAX_AGE_MS after it was last
 * CONFIRMED against the database. Past that it is refused with its own reason,
 * and a copy whose confirmation time cannot be read is refused too (L42, L50).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STORED_COPY_MAX_AGE_MS,
  STORED_COPY_RECONFIRM_AFTER_MS,
  StoredCopyRefusedError,
  confirmedAt,
  isDueForReconfirm,
  judgeCopyAge,
  readConfirmedCopy,
  refuseStoredCopy,
} from '../stored-copy-age'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('the maximum age (Dan, 2026-10-07)', () => {
  it('is thirty minutes', () => {
    expect(STORED_COPY_MAX_AGE_MS).toBe(30 * 60 * 1000)
  })

  it('leaves room for at least five missed confirmations before a healthy copy ages out', () => {
    expect(STORED_COPY_RECONFIRM_AFTER_MS * 5).toBeLessThanOrEqual(STORED_COPY_MAX_AGE_MS)
  })
})

describe('judgeCopyAge', () => {
  it('serves a copy confirmed at the maximum age, and says how old it is', () => {
    expect(judgeCopyAge(iso(NOW - STORED_COPY_MAX_AGE_MS), NOW)).toEqual({ usable: true, ageMs: STORED_COPY_MAX_AGE_MS })
  })

  it('refuses a copy one millisecond past the maximum age as too old', () => {
    expect(judgeCopyAge(iso(NOW - STORED_COPY_MAX_AGE_MS - 1), NOW)).toEqual({ usable: false, reason: 'copy_too_old', ageMs: STORED_COPY_MAX_AGE_MS + 1 })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['not a string', 1_700_000_000_000],
    ['not a time', 'yesterday-ish'],
    ['empty', ''],
  ])('refuses a copy whose confirmation time is %s, never treating it as fresh', (_label, stamp) => {
    expect(judgeCopyAge(stamp, NOW)).toEqual({ usable: false, reason: 'copy_age_unknown', ageMs: null })
  })

  it('refuses a confirmation time far in the future, which is damage rather than a clock difference', () => {
    expect(judgeCopyAge(iso(NOW + 10 * 60_000), NOW)).toEqual({ usable: false, reason: 'copy_age_unknown', ageMs: -10 * 60_000 })
  })

  it('serves a confirmation time a few seconds ahead, as another isolate clock can be', () => {
    expect(judgeCopyAge(iso(NOW + 2_000), NOW)).toEqual({ usable: true, ageMs: -2_000 })
  })

  it('takes a stricter bound for a node that wants one', () => {
    expect(judgeCopyAge(iso(NOW - 16 * 60_000), NOW, 15 * 60_000)).toMatchObject({ usable: false, reason: 'copy_too_old' })
  })

  it('refuses to judge against a bound looser than the shared maximum, so no caller can serve longer', () => {
    expect(() => judgeCopyAge(iso(NOW), NOW, STORED_COPY_MAX_AGE_MS + 1)).toThrow(/looser than/)
  })
})

describe('isDueForReconfirm', () => {
  it('is not due inside the reconfirm interval', () => {
    expect(isDueForReconfirm(iso(NOW - STORED_COPY_RECONFIRM_AFTER_MS + 1), NOW)).toBe(false)
  })

  it('is due once the interval has passed', () => {
    expect(isDueForReconfirm(iso(NOW - STORED_COPY_RECONFIRM_AFTER_MS), NOW)).toBe(true)
  })

  it.each([undefined, null, 'garbage', iso(NOW + 10 * 60_000)])('is due when the stamp cannot be trusted (%s)', (stamp) => {
    expect(isDueForReconfirm(stamp, NOW)).toBe(true)
  })
})

describe('confirmedAt and readConfirmedCopy', () => {
  function metadataKv() {
    const store = new Map<string, { value: string; metadata: unknown }>()
    return {
      store,
      put: vi.fn(async (k: string, value: string, opts?: { metadata?: unknown }) => { store.set(k, { value, metadata: opts?.metadata ?? null }) }),
      getWithMetadata: vi.fn(async (k: string) => store.get(k) ?? { value: null, metadata: null }),
    }
  }

  it('stamps a put with the confirmation time, which the read hands back with the value', async () => {
    const kv = metadataKv()
    await kv.put('k', 'v', confirmedAt(NOW))
    expect(await readConfirmedCopy(kv as unknown as KVNamespace, 'k')).toEqual({ value: 'v', confirmedAt: iso(NOW) })
  })

  it('answers null when there is no copy', async () => {
    expect(await readConfirmedCopy(metadataKv() as unknown as KVNamespace, 'absent')).toBeNull()
  })

  it('hands back an undefined confirmation for a copy written before stamps existed, which the judge refuses', async () => {
    const kv = metadataKv()
    await kv.put('k', 'v')
    const read = await readConfirmedCopy(kv as unknown as KVNamespace, 'k')
    expect(read).toEqual({ value: 'v', confirmedAt: undefined })
    expect(judgeCopyAge(read!.confirmedAt, NOW)).toMatchObject({ usable: false, reason: 'copy_age_unknown' })
  })
})

describe('refuseStoredCopy', () => {
  let lines: string[]
  beforeEach(() => {
    lines = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('logs one structured line naming the copy, the subject, the reason and the age, and returns a named error', () => {
    const err = refuseStoredCopy({ copy: 'env_vars', subject: 'org-1', reason: 'copy_too_old', ageMs: 31 * 60_000, dbError: 'fetch failed' })
    expect(err).toBeInstanceOf(StoredCopyRefusedError)
    expect(err.reason).toBe('copy_too_old')
    expect(err.copy).toBe('env_vars')
    expect(err.message).toMatch(/environment variables for org-1/)
    expect(err.message).toMatch(/31 minutes/)
    expect(err.message).toMatch(/fetch failed/)
    const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(events).toEqual([{ event: 'stored_copy_refused', copy: 'env_vars', subject: 'org-1', reason: 'copy_too_old', copy_age_ms: 31 * 60_000, max_age_ms: STORED_COPY_MAX_AGE_MS, db_error: 'fetch failed' }])
  })

  it('words each reason differently, so a missing copy never reads as an old one', () => {
    const messages = (['no_copy', 'copy_too_old', 'copy_age_unknown', 'copy_unusable'] as const).map((reason) => refuseStoredCopy({ copy: 'partner_constants', subject: 'org-1', reason, ageMs: reason === 'copy_too_old' ? STORED_COPY_MAX_AGE_MS + 1 : null, dbError: 'x' }).message)
    expect(new Set(messages).size).toBe(4)
    expect(messages[0]).toMatch(/no stored copy/)
    expect(messages[2]).toMatch(/no readable confirmation time/)
    expect(messages[3]).toMatch(/could not be read or was not fit to serve/)
  })
})
