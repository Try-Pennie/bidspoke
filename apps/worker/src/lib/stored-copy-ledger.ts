/**
 * The stored copy ledger (#1848): a count of every stored outage copy served or
 * refused, per copy, per minute, which the per minute check reads to say when
 * leads are being served from copies.
 *
 * Before this the only trace of a copy being served was a log line, and Workers
 * logs no longer leave Cloudflare (the Logpush field list was narrowed, #1007),
 * so an outage being absorbed was invisible to everyone.
 *
 * The count must cost a lead nothing. Noting a copy (`noteStoredCopy`, called by
 * the shared serve and refusal functions in stored-copy-age.ts) only adds to
 * this isolate's memory. The write to KV happens after the response, from the
 * worker's own entry points (`flushStoredCopyLedger`, handed to waitUntil), and
 * is skipped outright when nothing was noted, so a healthy day writes nothing.
 * KV is used rather than the database because the database is what is failing
 * when a copy is served.
 *
 * Each isolate writes its own key per minute (`stored-copy-ledger:<minute>:<isolate>`)
 * with the running totals for that minute in the key's metadata, so the check
 * reads every count with list calls alone, two isolates never write the same
 * key, and one isolate writes its key at most once per LEDGER_FLUSH_INTERVAL_MS,
 * well inside KV's one write a second per key. A flush that comes sooner waits
 * out the interval inside the waitUntil rather than dropping what was noted.
 *
 * What it can miss: counts noted by an isolate that is evicted before its next
 * flush, and serves made after a response by work the flush did not wait for
 * (they are written by that isolate's next flush). So the counts are a floor,
 * and the alert words them that way.
 *
 * Module state (an isolate's memory, by design): `pending`, `isolateId`,
 * `lastFlushAt` and `flushing`. `forgetStoredCopyLedger` clears all four.
 */
// stored-copy-age imports this module too, so its lists are read where they are
// used, never captured when this module loads, before they exist.
import { STORED_COPY_KINDS, STORED_COPY_REFUSALS, type StoredCopyKind, type StoredCopyRefusal } from './stored-copy-age'
import { formatErr } from './format-error'

export const STORED_COPY_LEDGER_PREFIX = 'stored-copy-ledger:'

/**
 * The shortest gap between two writes of one isolate's ledger. Five times KV's
 * limit of one write a second per key, and short enough that a count reaches KV
 * well inside the minute the check reads it in.
 */
export const LEDGER_FLUSH_INTERVAL_MS = 5_000

/**
 * How long one flush keeps writing while new counts keep arriving. Under the 30
 * seconds Cloudflare allows work after a response, so a flush is never cut off
 * mid write; whatever arrives after it is written by the next request's flush.
 */
export const LEDGER_FLUSH_BUDGET_MS = 20_000

/**
 * How long a ledger key lives. Longer than any window the check reads (five
 * minutes) plus KV's own delay before a write is listed everywhere (up to a
 * minute), so a minute inside the window is never missing because it expired.
 */
export const LEDGER_KEY_TTL_SECONDS = 15 * 60

const MINUTE_MS = 60_000

export type StoredCopyOutcome = 'served' | StoredCopyRefusal


/** One copy's counts in one minute, as held in KV metadata: short names, since metadata is capped at 1024 bytes. */
interface StoredTally {
  /** Served. */
  s: number
  /**
   * Refused, by reason, positionally in STORED_COPY_REFUSALS order: a list
   * rather than named keys keeps a minute with every copy refused for every
   * reason well inside the metadata limit.
   */
  r: number[]
  /** The oldest copy served, in ms, or null when none was served. */
  a: number | null
}

interface LedgerEntry {
  /** The minute, as whole minutes since the epoch. */
  m: number
  k: Partial<Record<StoredCopyKind, StoredTally>>
}

export interface KindTally {
  served: number
  refused: Record<StoredCopyRefusal, number>
  /** The oldest copy served in the window, or null when none was. */
  oldestServedAgeMs: number | null
}

export interface LedgerReading {
  /** Minutes in the window with at least one copy served or refused. */
  activeMinutes: number
  /**
   * The last moment of the newest minute in the window with a copy served or
   * refused, or null when none was. A minute is the ledger's grain, so this is
   * the latest a use can have happened, never later than it could have.
   */
  lastActiveMs: number | null
  kinds: Partial<Record<StoredCopyKind, KindTally>>
  /** Entries that could not be read and were left out. */
  unreadable: number
}

/** The KV surface the ledger needs. */
export type LedgerKv = Pick<KVNamespace, 'put' | 'list'>

export interface LedgerClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: LedgerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

const pending = new Map<number, { entry: LedgerEntry; dirty: boolean }>()
// Made on the first flush: Workers refuse random values at module scope.
let isolateId: string | null = null
let lastFlushAt: number | null = null
let flushing: Promise<void> | null = null

/** Note one copy served or refused. Memory only, so it adds nothing to the lead's time. */
export function noteStoredCopy(event: { copy: StoredCopyKind; outcome: StoredCopyOutcome; ageMs: number | null; atMs?: number }): void {
  const minute = Math.floor((event.atMs ?? Date.now()) / MINUTE_MS)
  let held = pending.get(minute)
  if (!held) {
    held = { entry: { m: minute, k: {} }, dirty: false }
    pending.set(minute, held)
  }
  const tally = (held.entry.k[event.copy] ??= { s: 0, r: [], a: null })
  if (event.outcome === 'served') {
    tally.s += 1
    if (event.ageMs !== null && Number.isFinite(event.ageMs)) tally.a = Math.max(tally.a ?? 0, event.ageMs)
  } else {
    const at = STORED_COPY_REFUSALS.indexOf(event.outcome)
    while (tally.r.length <= at) tally.r.push(0)
    tally.r[at] += 1
  }
  held.dirty = true
}

const anyDirty = () => [...pending.values()].some((h) => h.dirty)

/**
 * Write what this isolate has noted since its last write. Never throws; a write
 * KV refuses is kept and tried again by the next flush. Hand it to waitUntil.
 */
export function flushStoredCopyLedger(kv: LedgerKv, clock: LedgerClock = realClock): Promise<void> {
  if (!anyDirty()) return Promise.resolve()
  if (flushing) return flushing
  flushing = (async () => {
    const startedAt = clock.now()
    try {
      while (anyDirty()) {
        if (lastFlushAt !== null) {
          const wait = lastFlushAt + LEDGER_FLUSH_INTERVAL_MS - clock.now()
          if (wait > 0) {
            if (clock.now() + wait - startedAt > LEDGER_FLUSH_BUDGET_MS) return
            await clock.sleep(wait)
          }
        }
        const wrote = await writeDirty(kv, clock.now())
        lastFlushAt = clock.now()
        if (!wrote) return
      }
    } finally {
      flushing = null
    }
  })()
  return flushing
}

/** Writes every minute noted since the last write; false when KV refused one. */
async function writeDirty(kv: LedgerKv, nowMs: number): Promise<boolean> {
  isolateId ??= crypto.randomUUID()
  let ok = true
  for (const [minute, held] of pending) {
    if (!held.dirty) {
      // A minute already written and past every window the check reads.
      if (minute < Math.floor(nowMs / MINUTE_MS) - LEDGER_KEY_TTL_SECONDS / 60) pending.delete(minute)
      continue
    }
    held.dirty = false
    const metadata: LedgerEntry = JSON.parse(JSON.stringify(held.entry)) as LedgerEntry
    try {
      await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:${isolateId}`, '', { metadata, expirationTtl: LEDGER_KEY_TTL_SECONDS })
    } catch (e) {
      held.dirty = true
      ok = false
      console.error(`[stored-copy-ledger] could not write the count of stored copies used in minute ${minute}, keeping it for the next flush: ${formatErr(e)}`)
    }
  }
  return ok
}

function emptyTally(): KindTally {
  return { served: 0, refused: Object.fromEntries(STORED_COPY_REFUSALS.map((r) => [r, 0])) as Record<StoredCopyRefusal, number>, oldestServedAgeMs: null }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Every isolate's counts for the `windowMinutes` minutes ending with the one
 * `nowMs` falls in. Throws when KV does, so the caller can say it could not
 * measure rather than read silence as health.
 */
export async function readStoredCopyLedger(kv: LedgerKv, nowMs: number, windowMinutes: number): Promise<LedgerReading> {
  const newest = Math.floor(nowMs / MINUTE_MS)
  const oldest = newest - windowMinutes + 1
  const reading: LedgerReading = { activeMinutes: 0, lastActiveMs: null, kinds: {}, unreadable: 0 }
  const active = new Set<number>()
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix: STORED_COPY_LEDGER_PREFIX, cursor })
    for (const key of page.keys) {
      const entry = key.metadata as Partial<LedgerEntry> | null
      if (!entry || typeof entry !== 'object' || typeof entry.m !== 'number' || !entry.k || typeof entry.k !== 'object') {
        reading.unreadable++
        continue
      }
      if (entry.m < oldest || entry.m > newest) continue
      let used = false
      for (const kind of STORED_COPY_KINDS) {
        const raw = (entry.k as Record<string, unknown>)[kind]
        if (!raw || typeof raw !== 'object') continue
        const stored = raw as Partial<StoredTally>
        const tally = (reading.kinds[kind] ??= emptyTally())
        const served = count(stored.s)
        tally.served += served
        const refused = Array.isArray(stored.r) ? stored.r : []
        STORED_COPY_REFUSALS.forEach((reason, i) => { tally.refused[reason] += count(refused[i]) })
        if (served > 0 && typeof stored.a === 'number' && Number.isFinite(stored.a)) {
          tally.oldestServedAgeMs = Math.max(tally.oldestServedAgeMs ?? 0, stored.a)
        }
        used = true
      }
      if (used) active.add(entry.m)
      else reading.unreadable++
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  reading.activeMinutes = active.size
  if (active.size > 0) reading.lastActiveMs = Math.min(nowMs, (Math.max(...active) + 1) * MINUTE_MS - 1)
  return reading
}

/** Forget everything this isolate noted. For tests and the outage drill, which reset module state between runs. */
export function forgetStoredCopyLedger(): void {
  pending.clear()
  isolateId = null
  lastFlushAt = null
  flushing = null
}
