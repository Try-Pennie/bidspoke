/**
 * UUIDv7 execution ids, minted identically by the Worker and by the browser
 * (#869, Phase A1 of the never delete without a backup milestone; plan in
 * discussion #867).
 *
 * WHY the id shape matters. The execution archive keeps one gzipped bundle per
 * execution in Snowflake, and the hardest constraint on it is the point lookup:
 * opening one execution's page must not scan a table that grows forever. A
 * time ordered id solves that for free, because the UTC day is derivable from
 * the id in the URL, so the query prunes to one day of micro-partitions without
 * paying for Search Optimization Service or clustering on a random key.
 *
 * WHY it is shared rather than copied. Two sources mint execution ids: the
 * engine for live runs, and the canvas test runner in the browser, which needs
 * the id BEFORE the run so it can open its realtime channel filter. A copy per
 * app is two chances to diverge, and a divergence here surfaces as an unpruned
 * lookup rather than as an error, so nothing would report it.
 *
 * Hand rolled over `crypto.getRandomValues` rather than taken from a dependency:
 * it is twenty lines, it must run unchanged in a Workers isolate and in a
 * browser, and both have Web Crypto.
 *
 * WHAT THIS IS NOT. The day derived here is a read path optimisation and never
 * the archive's day of record. That is `archive_day`, derived from `started_at`
 * (phases A2 and A3), because a day taken from an id would be a second
 * definition of the same fact and the deletion guarantee rests on one (L26, L39).
 * So a stray non v7 id costs one unpruned lookup on the rare occasion someone
 * opens it, and can never block a day's verification or authorise a deletion.
 *
 * Layout, per RFC 9562 section 5.7:
 *
 *   unix_ts_ms  48 bits   big endian milliseconds since the epoch
 *   ver          4 bits   literal 7
 *   rand_a      12 bits
 *   var          2 bits   literal binary 10
 *   rand_b      62 bits
 *
 * which is 74 random bits, all of them from `crypto.getRandomValues`.
 */

/** Milliseconds that fit in the 48 bit timestamp field. */
const MAX_TIMESTAMP_MS = 0xffffffffffff

/**
 * The earliest minting time this accepts when reading an id back. Ids are only
 * ever minted by a running process, so a timestamp at or near zero is not an
 * early execution, it is the signature of a zeroed or hand written id. Reading a
 * day out of one anyway would file those rows under 1970-01-01, a day the
 * archive gate will never verify, where they would read as a count shortfall
 * rather than as a bad id (L11).
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1)

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Lowercase hex, left padded to `width` characters. */
const hex = (value: number, width: number): string =>
  value.toString(16).padStart(width, '0')

/**
 * A time ordered UUIDv7. `now` is milliseconds since the epoch and defaults to
 * the current clock; pass it explicitly only in tests, so an assertion is about
 * the encoding rather than about when it happened to run.
 */
export function uuidv7(now: number = Date.now()): string {
  const ms = Math.floor(now)
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
    // Refused rather than truncated. A wrapped timestamp still produces a well
    // formed id, so a silent truncation here would mint ids that sort into the
    // wrong day forever with nothing reporting it.
    throw new RangeError(`uuidv7: ${now} is not a millisecond timestamp that fits in 48 bits`)
  }

  // Eleven bytes, which is exactly the 74 random bits the format has room for:
  // rand_a takes 12, the variant nibble keeps 2, one low nibble gives 4, and the
  // remaining seven whole bytes give 56.
  const random = new Uint8Array(11)
  crypto.getRandomValues(random)

  // 48 bit timestamp, split the way the hyphens fall. Built from the number
  // rather than from a byte array so the arithmetic is visible: JavaScript
  // integers are exact well past 2^48, so this needs no BigInt.
  const timeHigh = Math.floor(ms / 0x10000) // top 32 bits
  const timeLow = ms % 0x10000 // bottom 16 bits

  // rand_a is 12 bits, so the version nibble is written as a literal 7 rather
  // than masked in, leaving no way for a random byte to reach it.
  const randA = ((random[0] << 8) | random[1]) & 0x0fff

  // rand_b's first nibble carries the 2 bit variant in its high bits, so it is
  // forced to binary 10 and the remaining 2 bits stay random.
  const variantNibble = 0x8 | (random[2] & 0x3)

  // Sixteen hex characters, filling both of the last two groups.
  const tail =
    hex(variantNibble, 1) +
    hex(random[3] & 0x0f, 1) +
    hex(random[4], 2) +
    hex(random[5], 2) +
    hex(random[6], 2) +
    hex(random[7], 2) +
    hex(random[8], 2) +
    hex(random[9], 2) +
    hex(random[10], 2)

  const timeHex = hex(timeHigh, 8) + hex(timeLow, 4)

  return (
    timeHex.slice(0, 8) +
    '-' +
    timeHex.slice(8, 12) +
    '-' +
    '7' +
    hex(randA, 3) +
    '-' +
    tail.slice(0, 4) +
    '-' +
    tail.slice(4, 16)
  )
}

/**
 * The UTC day, as `YYYY-MM-DD`, that a UUIDv7 was minted on, or `null` when the
 * id cannot answer.
 *
 * It REFUSES rather than guessing, and the refusing case is the common one: every
 * execution id minted before #869 is a v4, whose leading 48 bits are pure random
 * noise. Reading them anyway would return a real looking day from noise, and the
 * caller cannot tell a derived day from an invented one. A refusal costs an
 * unpruned lookup, which is slow; a wrong day sends the lookup to the wrong
 * partitions and finds nothing, which reads as a missing archive (L11).
 */
export function utcDayFromUuidV7(id: string): string | null {
  const ms = mintedMsFromUuidV7(id)
  // `toISOString` is UTC by definition, so this cannot pick up the host's
  // timezone the way a getFullYear and getMonth computation would (L39).
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10)
}

/**
 * The millisecond a UUIDv7 was minted at, or `null` when the id cannot answer,
 * refusing exactly what utcDayFromUuidV7 refuses. Two runs are ordered by it
 * (#2485): an execution id is minted when its run starts.
 */
export function mintedMsFromUuidV7(id: string): number | null {
  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) return null
  if (id[14] !== '7') return null
  // The variant, binary 10, is the other half of the format. Checking only the
  // version would accept ids no conforming generator produces, and this pair has
  // to accept exactly what its own generator mints and nothing wider (L150).
  if (!'89ab'.includes(id[19])) return null

  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
  if (!Number.isFinite(ms) || ms < EARLIEST_PLAUSIBLE_MS) return null
  return ms
}

/** Whether `id` is a UUIDv7 this module would read a day out of. */
export function isUuidV7(id: string): boolean {
  return utcDayFromUuidV7(id) !== null
}
