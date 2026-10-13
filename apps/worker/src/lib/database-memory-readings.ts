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
 * A raw KV value classified, never a throw. `unreadable` is a present value that is not a JSON
 * array (corrupt, or an older writer's non-array). `droppedCount` is array elements that were
 * not shaped like a reading and so were discarded (a future field change would make this the
 * whole array). The two are kept apart from a genuinely empty buffer so a reader does not show
 * "nothing recorded yet" over corruption and a writer can log the loss (L10, L11, L50).
 */
export interface ParsedReadings {
  readings: StoredMemoryReading[]
  unreadable: boolean
  droppedCount: number
}

export function parseReadings(raw: string | null): ParsedReadings {
  if (raw === null) return { readings: [], unreadable: false, droppedCount: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { readings: [], unreadable: true, droppedCount: 0 }
  }
  if (!Array.isArray(parsed)) return { readings: [], unreadable: true, droppedCount: 0 }
  const readings = parsed.filter(isStoredReading)
  return { readings, unreadable: false, droppedCount: parsed.length - readings.length }
}

/** The valid readings only, for callers that do not need the corruption signal. */
export function parseStoredReadings(raw: string | null): StoredMemoryReading[] {
  return parseReadings(raw).readings
}

/**
 * Append a reading, drop everything older than the window relative to it, and cap the count at
 * the newest. One GET then one PUT. A GET that THREW (a storage outage) propagates and writes
 * nothing, so a failed read never overwrites the existing history with a lone fresh entry.
 *
 * A read that SUCCEEDED but returned a value that cannot be used (not a JSON array, or an
 * array whose entries no longer match the reading shape) loses that history, which rebuilds
 * over the window. It must not happen SILENTLY (L11): both shapes are logged so a recurring
 * corruption or a shape change is visible rather than looking like a buffer that simply
 * started fresh. A buffer that keeps some well-shaped entries and drops others is also logged,
 * but it is not a wipe: the good entries are carried forward.
 */
export async function recordMemoryReading(
  kv: ReadingsKv,
  entry: StoredMemoryReading,
  opts: { windowMs?: number; max?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const windowMs = opts.windowMs ?? READINGS_WINDOW_MS
  const max = opts.max ?? READINGS_MAX
  const log = opts.log ?? ((line: string) => console.warn(line))
  const parsed = parseReadings(await kv.get(DATABASE_MEMORY_READINGS_KEY))
  if (parsed.unreadable) {
    log('[database-memory-readings] stored buffer was not a JSON array; replacing it with a fresh entry (diagnostic history lost)')
  } else if (parsed.droppedCount > 0) {
    log(`[database-memory-readings] dropped ${parsed.droppedCount} stored reading(s) that no longer match the reading shape`)
  }
  const existing = parsed.readings
  const cutoff = entry.at - windowMs
  const kept = existing.filter((r) => r.at > cutoff)
  kept.push(entry)
  const trimmed = kept.length > max ? kept.slice(kept.length - max) : kept
  await kv.put(DATABASE_MEMORY_READINGS_KEY, JSON.stringify(trimmed))
}

/**
 * The reader for the admin route. A storage outage is its own reported state, and so is a
 * buffer that read back but could not be parsed into readings: neither is shown as an empty
 * list that reads as "nothing recorded yet" (L10, L11). A buffer that yielded some readings but
 * dropped others returns the good ones (not an error): that is partial, not nothing.
 */
export async function readMemoryReadings(
  kv: ReadingsKv,
): Promise<{ readings: StoredMemoryReading[]; error: string | null; droppedCount: number }> {
  let raw: string | null
  try {
    raw = await kv.get(DATABASE_MEMORY_READINGS_KEY)
  } catch (e) {
    return { readings: [], error: formatErr(e), droppedCount: 0 }
  }
  const parsed = parseReadings(raw)
  if (parsed.unreadable || (parsed.readings.length === 0 && parsed.droppedCount > 0)) {
    return { readings: [], error: 'the stored readings buffer is corrupt or in an unrecognised shape, so no readings could be read from it', droppedCount: parsed.droppedCount }
  }
  // Partial loss (some entries dropped for an unrecognised shape) is not an error, but the
  // count is returned so the admin route can show that part of the history is missing (L11).
  return { readings: parsed.readings, error: null, droppedCount: parsed.droppedCount }
}
