/**
 * A queryable home for the database-memory readings (#2010).
 *
 * The check (`database-memory.ts`) logs every reading as `event=database_memory`, and its doc
 * says that exists so the 15 percent free floor and the 600/500 MB swap thresholds can be
 * checked against a full day of real readings (L172). But those logs are not reachable: the
 * Cloudflare Logpush job stopped forwarding console messages in Sep 2026, and the
 * observability tool rejects a scheduled (cron) invocation's events. So each successful run
 * also records its figures here, into a bounded ring buffer in the worker's own KV, which
 * `GET /api/admin/database-memory-readings` reads back. KV, not the database, because the
 * database is the subject of this alert and a quiet run must not add a write to it every five
 * minutes (the same reason the check does not read Supabase on a quiet run).
 *
 * The buffer is one KV value, so the reader is a single GET and the writer a single PUT. It is
 * trimmed to a window on every write and hard capped, so it cannot grow without bound however
 * the cadence changes.
 */
import { formatErr } from './format-error'

/** The KV key holding the readings ring buffer. */
export const DATABASE_MEMORY_READINGS_KEY = 'database-memory:readings'
/** Readings older than this are dropped on write. A week, the span calibration needs (#2010). */
export const READINGS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A hard ceiling on the entry count regardless of the window, so a cron firing far faster than
 * its five minute cadence (a retry storm) cannot swell the value. A week at five minutes is
 * about 2,016 entries, so this leaves generous headroom while still bounding the value size.
 */
export const READINGS_MAX = 3000

/**
 * One recorded reading. The fields mirror the `event=database_memory` log line in the same
 * decimal MB unit the thresholds are set in (L118), so `swapUsedMb` is directly comparable to
 * the 600 MB concern line it exists to calibrate.
 */
export interface StoredMemoryReading {
  /** Epoch milliseconds the reading was taken. */
  at: number
  /** Memory available as a percentage of total, to one decimal. */
  freePct: number
  /** Memory available, decimal MB. */
  availableMb: number
  /** Total memory, decimal MB. */
  totalMb: number
  /** Swap in use, decimal MB. The figure the swap thresholds are calibrated against. */
  swapUsedMb: number
  /** Whether this reading counted as over the swap concern line when it was taken. */
  swapHigh: boolean
}

/** The slice of a KV namespace this module needs. `env.IDEMPOTENCY` satisfies it. */
export interface ReadingsKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

function isStoredReading(v: unknown): v is StoredMemoryReading {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  return num(r.at) && num(r.freePct) && num(r.availableMb) && num(r.totalMb) && num(r.swapUsedMb) && typeof r.swapHigh === 'boolean'
}

/**
 * The stored readings from a raw KV value, never a throw: nothing stored, malformed JSON, or a
 * value an older or corrupt writer left all read as an empty list, and any entry not shaped
 * like a reading is dropped rather than carried forward (L50).
 */
export function parseStoredReadings(raw: string | null): StoredMemoryReading[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isStoredReading)
}

/**
 * Append a reading, drop everything older than the window relative to it, and cap the count at
 * the newest. One GET then one PUT. A GET that THREW (a storage outage) propagates and writes
 * nothing, so a failed read never overwrites the existing history with a lone fresh entry.
 */
export async function recordMemoryReading(
  kv: ReadingsKv,
  entry: StoredMemoryReading,
  opts: { windowMs?: number; max?: number } = {},
): Promise<void> {
  const windowMs = opts.windowMs ?? READINGS_WINDOW_MS
  const max = opts.max ?? READINGS_MAX
  const existing = parseStoredReadings(await kv.get(DATABASE_MEMORY_READINGS_KEY))
  const cutoff = entry.at - windowMs
  const kept = existing.filter((r) => r.at > cutoff)
  kept.push(entry)
  const trimmed = kept.length > max ? kept.slice(kept.length - max) : kept
  await kv.put(DATABASE_MEMORY_READINGS_KEY, JSON.stringify(trimmed))
}

/**
 * The reader for the admin route. A storage outage is its own reported state, never an empty
 * list that reads as "nothing recorded yet" (L11).
 */
export async function readMemoryReadings(kv: ReadingsKv): Promise<{ readings: StoredMemoryReading[]; error: string | null }> {
  try {
    const raw = await kv.get(DATABASE_MEMORY_READINGS_KEY)
    return { readings: parseStoredReadings(raw), error: null }
  } catch (e) {
    return { readings: [], error: formatErr(e) }
  }
}
