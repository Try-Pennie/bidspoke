/**
 * A snapshot of what the database is doing, taken DURING a write stall (#2292).
 *
 * On 2026-10-16 writes to workflow_executions, lead_sightings and execution_steps
 * stalled for minutes three times (12:55 to 13:02, 17:30, 18:30 to 18:41 UTC)
 * and served leads lost their records. Afterwards disk, CPU, memory, lock waits,
 * pg_cron, deploys and connection counts were all ruled out, and nothing had
 * recorded what each backend was doing at the time. So the cause could not be
 * found after the fact, and the next stall has to record it while it happens.
 *
 * WHEN. The moment one of a run's post-response writes times out
 * (recordUnconfirmedOutcome in engine/durability.ts), which is the earliest point
 * the Worker knows a write is stuck: 15 to 22 seconds into the stall, rather than
 * the minutes later the slowdown summary goes out. Once per window
 * (STALL_SNAPSHOT_WINDOW_SECONDS), decided first by this isolate's own gate, so a
 * stall timing out dozens of writes a second costs the claim object one call per
 * isolate, then by the alert claim, so isolates do not each take one. A 10 minute
 * stall takes about five.
 *
 * WHAT. public.db_stall_snapshot() (migration 20261016210000): each non-idle
 * backend with its wait event and the first 300 characters of its query, the
 * blocking chains, and the backends counted by state and by client. Query text
 * can carry customer data: it is cut to 300 characters again here, it is kept
 * only in KV, and it never goes to Slack (the slowdown alert says only that a
 * snapshot was taken and how to read it).
 *
 * WHERE. KV, one key per snapshot, expiring after STALL_SNAPSHOT_TTL_SECONDS. Not
 * the database: the database is the thing stalling, so a write there could stall
 * too and take the evidence with it. The same reasoning as the unconfirmed write
 * entries and the incident outbox. Each key's metadata carries its outcome, so
 * the slowdown alert counts snapshots from the list without reading a body.
 *
 * FAIL LOUD, NEVER BLOCK. The engine hands the capture to waitUntil, so nothing
 * on the request or the write chain waits for it. The read has its own deadline
 * (a stalled database may not answer it either) and is aborted there, and a
 * read that did not answer is stored as "timed_out", which is itself evidence:
 * the database, or the pool in front of it, could not answer a catalogue read.
 * Nothing here throws; a snapshot that could not be stored is logged as such.
 *
 * Read them back with GET /api/admin/db-stall-snapshots, which withholds the
 * query text, or in full with wrangler (docs/disaster-recovery.md, Scenario E).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AlertClaims } from './alert-claim'
import { formatErr } from './format-error'

export const STALL_SNAPSHOT_PREFIX = 'db-stall-snapshot:'
/** Kept three days: long enough to read after a weekend stall, short enough to bound what KV holds. */
export const STALL_SNAPSHOT_TTL_SECONDS = 3 * 24 * 60 * 60
/** At most one snapshot per this many seconds, across isolates. */
export const STALL_SNAPSHOT_WINDOW_SECONDS = 120
export const STALL_SNAPSHOT_CLAIM_KEY = 'db-stall-snapshot'
/**
 * How long the read may take. The capture starts when a write gives up, 15 s
 * (the step flush) to 22 s (a dead-lettered write) after the response, and
 * Cloudflare cancels waitUntil work at 30 s: the claim's own 2 s deadline, this,
 * and the KV write still fit. On a healthy database the read takes milliseconds
 * (about 4 KB for 23 backends, measured on the bidding project 2026-10-16).
 */
export const STALL_SNAPSHOT_DEADLINE_MS = 3_000
/** The stored record's ceiling, far below KV's 25 MiB value limit. */
export const STALL_SNAPSHOT_MAX_BYTES = 256 * 1024
/** Query text kept per backend, matching the function's own cut. */
export const STALL_SNAPSHOT_QUERY_CHARS = 300
/** The admin read lists at most this many KV pages (1,000 keys each). */
const MAX_LIST_PAGES = 10

export type StallSnapshotStatus = 'taken' | 'timed_out' | 'failed'

/** The timed out write that set the capture off. No lead data: a label and the run. */
export interface StallSnapshotTrigger {
  label: string
  execution_id?: string
  workflow_name?: string
}

export interface StallSnapshotRecord {
  v: 1
  id: string
  /** When the capture began, ISO. */
  started_at: string
  status: StallSnapshotStatus
  /** How long the read took, or how long it was waited for. */
  elapsed_ms: number
  deadline_ms: number
  trigger: StallSnapshotTrigger
  /** Why there is no snapshot, for timed_out and failed. */
  error?: string
  /** db_stall_snapshot()'s answer, query text cut to 300 characters. */
  snapshot?: unknown
  /** True when the answer was too big and its backend list was dropped. */
  truncated?: boolean
}

interface SnapshotMetadata {
  status: StallSnapshotStatus
  started_at: string
}

export interface StallSnapshotKv {
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>
}

export interface StallSnapshotListKv {
  get(key: string): Promise<string | null>
  list(opts: { prefix: string; limit: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>
    list_complete?: boolean
    cursor?: string
  }>
}

/** Keys sort by capture time, so a KV list returns them oldest first. */
export function stallSnapshotKey(startedAtMs: number, id: string): string {
  return `${STALL_SNAPSHOT_PREFIX}${String(startedAtMs).padStart(15, '0')}:${id}`
}

function startedOfKey(key: string): number {
  const m = /^db-stall-snapshot:(\d{15}):/.exec(key)
  return m ? Number(m[1]) : Number.NaN
}

/**
 * This isolate's own memory of when it last took a snapshot. A stall times out
 * many writes a second, and without it each would ask the claim object, which
 * is one more thing to load during an incident.
 */
export class StallSnapshotGate {
  private nextAt = Number.NEGATIVE_INFINITY

  /** True for the first call per window in this isolate. */
  enter(nowMs: number, windowMs: number): boolean {
    if (nowMs < this.nextAt) return false
    this.nextAt = nowMs + windowMs
    return true
  }
}

/** The gate the production wiring shares across every run in the isolate. */
export const isolateStallSnapshotGate = new StallSnapshotGate()

export interface CaptureDeps {
  kv: StallSnapshotKv
  /** The atomic claim across isolates. Absent, only the isolate's gate dedupes. */
  claims?: AlertClaims
  /** Calls db_stall_snapshot; the signal is aborted at the deadline. */
  read: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>
  now?: () => number
  /**
   * The deadline's watch, injected so a test never waits (L524). The signal is
   * aborted once the read settles, so a watch that is not needed any more ends.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  gate?: StallSnapshotGate
  deadlineMs?: number
  id?: () => string
}

export type CaptureOutcome =
  | { kind: 'skipped'; reason: 'gate' | 'claim' }
  | { kind: 'recorded'; status: StallSnapshotStatus; key: string }
  | { kind: 'unrecorded'; status: StallSnapshotStatus; error: string }

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

/**
 * Takes and stores one snapshot, unless this window already has one. Never
 * throws: every failure is either the snapshot's own recorded outcome or a log
 * line saying the snapshot could not be stored.
 */
export async function captureStallSnapshot(deps: CaptureDeps, trigger: StallSnapshotTrigger): Promise<CaptureOutcome> {
  const now = deps.now ?? Date.now
  const gate = deps.gate ?? isolateStallSnapshotGate
  const startedMs = now()
  if (!gate.enter(startedMs, STALL_SNAPSHOT_WINDOW_SECONDS * 1000)) return { kind: 'skipped', reason: 'gate' }
  if (deps.claims) {
    let claimed = true
    try {
      claimed = await deps.claims.claim(STALL_SNAPSHOT_CLAIM_KEY, STALL_SNAPSHOT_WINDOW_SECONDS)
    } catch (e) {
      // Fails open: a duplicate snapshot costs a few KB, a missing one costs the evidence.
      console.error(`[db-stall-snapshot] claim failed, taking the snapshot without it: ${formatErr(e)}`)
    }
    if (!claimed) return { kind: 'skipped', reason: 'claim' }
  }

  const deadlineMs = deps.deadlineMs ?? STALL_SNAPSHOT_DEADLINE_MS
  const abort = new AbortController()
  type Read = { kind: 'answered'; data: unknown; error: { message: string; code?: string | null } | null } | { kind: 'threw'; error: unknown } | { kind: 'timed_out' }
  const answered: Promise<Read> = (async () => deps.read(abort.signal))().then(
    (r) => ({ kind: 'answered' as const, data: r.data, error: r.error }),
    (error: unknown) => ({ kind: 'threw' as const, error }),
  )
  const watch = new AbortController()
  const expired: Promise<Read> = (deps.sleep ?? realSleep)(deadlineMs, watch.signal).then(() => ({ kind: 'timed_out' as const }))
  const read = await Promise.race([answered, expired])
  watch.abort()
  // Abandoning the read is not enough: aborting the request frees the connection.
  if (read.kind === 'timed_out') abort.abort()
  const elapsedMs = now() - startedMs

  const id = (deps.id ?? (() => crypto.randomUUID()))()
  const base = { v: 1 as const, id, started_at: new Date(startedMs).toISOString(), elapsed_ms: elapsedMs, deadline_ms: deadlineMs, trigger }
  let record: StallSnapshotRecord
  if (read.kind === 'timed_out') {
    record = { ...base, status: 'timed_out', error: `db_stall_snapshot did not answer within ${deadlineMs} ms` }
  } else if (read.kind === 'threw') {
    record = { ...base, status: 'failed', error: formatErr(read.error) }
  } else if (read.error) {
    record = { ...base, status: 'failed', error: `${read.error.code ?? 'no code'}: ${read.error.message}` }
  } else {
    record = { ...base, status: 'taken', snapshot: cutQueries(read.data) }
  }

  const value = boundRecord(record)
  const key = stallSnapshotKey(startedMs, id)
  const metadata: SnapshotMetadata = { status: record.status, started_at: record.started_at }
  try {
    await deps.kv.put(key, value, { expirationTtl: STALL_SNAPSHOT_TTL_SECONDS, metadata })
  } catch (e) {
    const message = formatErr(e)
    console.error(`[db-stall-snapshot] could not store the ${record.status} snapshot of ${record.started_at} (${trigger.label}): ${message}`)
    return { kind: 'unrecorded', status: record.status, error: message }
  }
  if (record.status !== 'taken') console.warn(`[db-stall-snapshot] ${record.status} at ${record.started_at}: ${record.error}`)
  return { kind: 'recorded', status: record.status, key }
}

/** Cuts every `query` string in the answer's lists, whatever the function returned. */
function cutQueries(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  for (const list of ['backends', 'blocking']) {
    const rows = out[list]
    if (!Array.isArray(rows)) continue
    out[list] = rows.map((row: unknown) => {
      if (!row || typeof row !== 'object') return row
      const r = row as Record<string, unknown>
      return typeof r.query === 'string' ? { ...r, query: r.query.slice(0, STALL_SNAPSHOT_QUERY_CHARS) } : r
    })
  }
  return out
}

/**
 * A record with everything belonging to one organization removed, for a reader
 * who may see the platform's state but not any organization's work: every
 * `query` string, and the run and workflow of the write that set it off (only
 * the kind of write, its label, is kept).
 */
export function withoutOrganizationData(record: StallSnapshotRecord): StallSnapshotRecord {
  const platform: StallSnapshotRecord = { ...record, trigger: { label: record.trigger.label } }
  const snap = record.snapshot
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return platform
  const out: Record<string, unknown> = { ...(snap as Record<string, unknown>) }
  for (const list of ['backends', 'blocking']) {
    const rows = out[list]
    if (!Array.isArray(rows)) continue
    out[list] = rows.map((row: unknown) => {
      if (!row || typeof row !== 'object') return row
      const { query: _query, ...rest } = row as Record<string, unknown>
      return rest
    })
  }
  return { ...platform, snapshot: out }
}

/** The stored JSON, within STALL_SNAPSHOT_MAX_BYTES: an oversized answer drops its backend list first. */
function boundRecord(record: StallSnapshotRecord): string {
  const whole = JSON.stringify(record)
  if (whole.length <= STALL_SNAPSHOT_MAX_BYTES) return whole
  const snap = record.snapshot
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
    const lean = JSON.stringify({ ...record, truncated: true, snapshot: { ...(snap as Record<string, unknown>), backends: [] } })
    if (lean.length <= STALL_SNAPSHOT_MAX_BYTES) return lean
  }
  return JSON.stringify({ ...record, truncated: true, snapshot: undefined, error: `snapshot of ${whole.length} bytes was too large to keep` })
}

/** The production read: the run's own client, aborted at the deadline. */
export function stallSnapshotRead(supabase: SupabaseClient): CaptureDeps['read'] {
  // The name is a literal, so the rpc classification guard sees this call site.
  return (signal) => supabase.rpc('db_stall_snapshot').abortSignal(signal)
}

export interface StallSnapshotCount {
  attempts: number
  taken: number
  timed_out: number
  failed: number
  /** The earliest attempt in the window, ISO, or null when there was none. */
  first_at: string | null
}

function isStatus(v: unknown): v is StallSnapshotStatus {
  return v === 'taken' || v === 'timed_out' || v === 'failed'
}

async function statusOf(kv: StallSnapshotListKv, key: { name: string; metadata?: unknown }): Promise<StallSnapshotStatus | null> {
  const m = key.metadata as Partial<SnapshotMetadata> | undefined
  if (m && isStatus(m.status)) return m.status
  const raw = await kv.get(key.name)
  if (!raw) return null
  try {
    const status = (JSON.parse(raw) as Partial<StallSnapshotRecord>).status
    return isStatus(status) ? status : null
  } catch {
    return null
  }
}

/** The longest key prefix every key between the two times shares, so the list stays near the window. */
function windowPrefix(fromMs: number, toMs: number): string {
  const a = String(Math.max(0, Math.floor(fromMs))).padStart(15, '0')
  const b = String(Math.max(0, Math.floor(toMs))).padStart(15, '0')
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return STALL_SNAPSHOT_PREFIX + a.slice(0, i)
}

/**
 * How many snapshots were attempted between two times, by outcome, for the
 * slowdown alert's one line. Throws when KV cannot be listed: the caller says it
 * could not look, rather than claiming none was taken (L11).
 */
export async function countStallSnapshots(kv: StallSnapshotListKv, fromMs: number, toMs: number): Promise<StallSnapshotCount> {
  const out: StallSnapshotCount = { attempts: 0, taken: 0, timed_out: 0, failed: 0, first_at: null }
  const prefix = windowPrefix(fromMs, toMs)
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    for (const key of listed.keys) {
      const at = startedOfKey(key.name)
      if (!(at >= fromMs && at <= toMs)) continue
      const status = await statusOf(kv, key)
      if (!status) continue
      out.attempts++
      out[status]++
      if (out.first_at === null || at < Date.parse(out.first_at)) out.first_at = new Date(at).toISOString()
    }
    if (listed.list_complete !== false || !listed.cursor) break
    cursor = listed.cursor
  }
  return out
}

export interface StallSnapshotListing {
  /** Every kept snapshot, newest first. */
  entries: Array<{ key: string; started_at: string; status: StallSnapshotStatus | null }>
  /** The newest `limit` in full. */
  latest: StallSnapshotRecord[]
  /** Bodies among the newest that were gone or unparseable. */
  unreadable: number
}

/** For the admin read. Throws when KV cannot be listed or read. */
export async function readStallSnapshots(kv: StallSnapshotListKv, opts: { limit: number }): Promise<StallSnapshotListing> {
  const keys: Array<{ name: string; metadata?: unknown }> = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await kv.list({ prefix: STALL_SNAPSHOT_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) })
    keys.push(...listed.keys)
    if (listed.list_complete !== false || !listed.cursor) break
    cursor = listed.cursor
  }
  keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  const entries = keys.map((k) => {
    const m = k.metadata as Partial<SnapshotMetadata> | undefined
    const at = startedOfKey(k.name)
    return {
      key: k.name,
      started_at: Number.isFinite(at) ? new Date(at).toISOString() : (m?.started_at ?? ''),
      status: m && isStatus(m.status) ? m.status : null,
    }
  })
  const latest: StallSnapshotRecord[] = []
  let unreadable = 0
  for (const k of keys.slice(0, opts.limit)) {
    const raw = await kv.get(k.name)
    try {
      if (!raw) throw new Error('gone')
      latest.push(JSON.parse(raw) as StallSnapshotRecord)
    } catch {
      unreadable++
    }
  }
  return { entries, latest, unreadable }
}
