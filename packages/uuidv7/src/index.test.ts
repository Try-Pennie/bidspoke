import { describe, expect, it } from 'vitest'
import { utcDayFromUuidV7, uuidv7 } from './index'

/**
 * Time ordered execution ids (#869, Phase A1 of the never delete without a
 * backup milestone, plan in discussion #867).
 *
 * The archive's read path wants a UTC day it can derive from the id in the URL,
 * so a point lookup prunes to one day of Snowflake micro-partitions instead of
 * scanning a table that grows forever. That only works if EVERY new execution id
 * carries its timestamp, which means one implementation shared by the Worker
 * that mints ids for live runs and the browser that mints them for canvas test
 * runs. Two copies of this would be two chances to diverge, and a divergence
 * shows up as an unprunable lookup rather than as an error.
 *
 * `utcDayFromUuidV7` REFUSES rather than guesses. Every historical id is v4 and
 * carries no time at all, so a helper that returned a plausible day for one
 * would hand the read path a confident wrong answer, which is worse than no
 * answer (L11, a message may claim only what its check actually measured). The
 * day is a read path optimisation and never the archive's day of record, so a
 * refusal costs one unpruned lookup and never blocks a day's verification.
 */

/** Pinned so the assertions are about the encoding rather than about the clock. */
const PINNED_MS = 1_755_000_000_000 // 2025-08-12T12:40:00.000Z

describe('uuidv7: the bits the format requires', () => {
  it('is shaped like a UUID', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('sets the version nibble to 7', () => {
    // Character 14 is the version. A v4 here is the whole defect this phase
    // exists to remove, and it is invisible to anything that only checks shape.
    expect(uuidv7()[14]).toBe('7')
  })

  it('sets the variant bits to binary 10', () => {
    // The two high bits of character 19, so it must be one of 8, 9, a or b.
    // Without this the id is still shaped like a UUID and still parses, so
    // nothing downstream would report it.
    expect('89ab').toContain(uuidv7()[19])
  })
})

describe('uuidv7: the timestamp it carries', () => {
  it('round-trips a pinned epoch to the exact millisecond', () => {
    const id = uuidv7(PINNED_MS)
    const hex = id.slice(0, 8) + id.slice(9, 13)
    expect(parseInt(hex, 16)).toBe(PINNED_MS)
  })

  it('orders ids by the time they were minted', () => {
    // The entire reason for the change: string order has to be time order, or
    // the day cannot be derived and nothing prunes.
    const early = uuidv7(PINNED_MS)
    const later = uuidv7(PINNED_MS + 1)
    expect(early < later).toBe(true)
  })

  it('mints distinct ids within one millisecond', () => {
    // 74 random bits below the timestamp. Two runs starting in the same
    // millisecond is ordinary here, and a collision would silently merge two
    // executions into one archive row.
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(PINNED_MS)))
    expect(ids.size).toBe(1000)
  })

  it('defaults to the current clock', () => {
    const before = Date.now()
    const id = uuidv7()
    const after = Date.now()
    const hex = id.slice(0, 8) + id.slice(9, 13)
    const stamped = parseInt(hex, 16)
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
  })
})

describe('utcDayFromUuidV7: the day the read path prunes on', () => {
  it('reads the day back for an id minted at that day\'s last millisecond', () => {
    const endOfDay = Date.parse('2026-03-14T23:59:59.999Z')
    expect(utcDayFromUuidV7(uuidv7(endOfDay))).toBe('2026-03-14')
  })

  it('reads the next day for an id minted one millisecond later', () => {
    // The boundary is the whole risk. An off-by-one here sends a lookup to the
    // wrong day's partitions, and the two failing days cancel in any test that
    // does not pin both sides of midnight (L130).
    const startOfNextDay = Date.parse('2026-03-15T00:00:00.000Z')
    expect(utcDayFromUuidV7(uuidv7(startOfNextDay))).toBe('2026-03-15')
  })

  it('is not affected by the host timezone', () => {
    // A day computed through a local-time Date disagrees with the database's
    // `AT TIME ZONE 'UTC'` for one hour a day in most zones (L39, one timezone
    // and one date helper). This asserts the UTC day for a moment that falls on
    // the previous day in every timezone west of UTC.
    const justAfterMidnightUtc = Date.parse('2026-03-15T00:30:00.000Z')
    expect(utcDayFromUuidV7(uuidv7(justAfterMidnightUtc))).toBe('2026-03-15')
  })

  it('pads single digit months and days', () => {
    const early = Date.parse('2026-01-05T08:00:00.000Z')
    expect(utcDayFromUuidV7(uuidv7(early))).toBe('2026-01-05')
  })
})

describe('utcDayFromUuidV7: refuses rather than guessing', () => {
  it('refuses a v4 id, which every historical execution carries', () => {
    // A v4's first 48 bits are random, so a helper that read them anyway would
    // return a real looking day from pure noise. Every execution before this
    // phase is a v4, so this is the common case, not the edge case.
    expect(utcDayFromUuidV7('9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b')).toBeNull()
  })

  it('refuses an id whose variant bits are wrong', () => {
    // Version 7 alone is not the format. Accepting this would mean accepting
    // something no conforming generator produced.
    expect(utcDayFromUuidV7('0198f0a0-1c00-7000-0000-000000000000')).toBeNull()
  })

  it('refuses an empty string', () => {
    expect(utcDayFromUuidV7('')).toBeNull()
  })

  it('refuses a malformed string', () => {
    expect(utcDayFromUuidV7('not-a-uuid')).toBeNull()
    expect(utcDayFromUuidV7('0198f0a0-1c00-7000-8000-00000000000')).toBeNull()
    expect(utcDayFromUuidV7('0198f0a01c0070008000000000000000')).toBeNull()
  })

  it('refuses an id it cannot place in a sane range, rather than reporting a day', () => {
    // A timestamp of zero is not a real minting time, it is the signature of a
    // hand written or zeroed id. Reporting 1970-01-01 for it would put those
    // rows in a day the gate will never verify, where they would read as a
    // count shortfall rather than as a bad id.
    expect(utcDayFromUuidV7('00000000-0000-7000-8000-000000000000')).toBeNull()
  })

  it('accepts every id its own generator produces', () => {
    // The pair has to be closed under itself, or the writer can mint something
    // the reader refuses and the invariant is unenforceable (L150).
    for (let i = 0; i < 500; i++) {
      expect(utcDayFromUuidV7(uuidv7())).not.toBeNull()
    }
  })
})
