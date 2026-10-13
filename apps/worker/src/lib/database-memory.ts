/**
 * The database memory check (#1928).
 *
 * On 2026-10-08 the database stalled for 90 seconds at 12:20 UTC and every post-response
 * write missed its budget (#1884). It was on Micro compute (1 GB) and had been short of
 * memory, swapping about 1 GB, every hour for at least a week; nothing said so, and it was
 * found only by opening the dashboard's memory chart after the damage. Memory history is
 * not reachable by API, but Supabase's metrics feed gives the figures as they stand, so
 * this reads them every five minutes and alerts once memory has been thin for 15 minutes.
 *
 * What it judges, and why:
 *
 *  - Thin means less than `MEMORY_FREE_FLOOR` of memory available, or more than
 *    `SWAP_CONCERN_BYTES` of swap in use. Either sign on every reading for
 *    `MEMORY_SHORT_ALERT_AFTER_MS` alerts. Swap is judged by its LEVEL, not by growth
 *    since the previous reading (#1928 follow-up, Dan 2026-10-12): the database pages cold
 *    pages out to disk every overnight batch window while free memory stays healthy, and a
 *    growth trip fired on that benign swapping every morning and self-cleared, which is the
 *    noise that teaches people to ignore the alert (L36). The level worth a page is one
 *    approaching the ~1 GB of swap that preceded the Oct 8 stall, well above the ~300 MB
 *    the overnight window reaches, so only that is a page now.
 *  - Every threshold is judged on the CLOCK from the moment a state began, never on a count
 *    of ticks, because a delayed or retried cron moves a count without moving time (L386).
 *  - A feed it cannot read is its own state, never healthy memory (L215): a standing memory
 *    alert gets no all-clear from a run of failed reads, and the feed failing for
 *    `FEED_UNREADABLE_ALERT_AFTER_MS` is its own alert so silence never means a dead check.
 *  - It posts to every org's Slack with the last-good copy as the fallback, because the
 *    connection's home is the database this alert is about (L682).
 *
 * The 15 percent floor was reasoned, not calibrated: it went live with one reading taken
 * minutes after the move to Medium. Every run logs its figures so the floor can be checked
 * against a full day of real readings (L172). Log line to search for: `event=database_memory`.
 * Those logs are not reachable by query (Logpush drops console messages; the observability
 * tool rejects cron events), so each successful run also records its figures into a bounded KV
 * ring buffer (`database-memory-readings.ts`) that `GET /api/admin/database-memory-readings`
 * reads back. That is the queryable home the swap thresholds are calibrated against (#2010).
 */
import type { AlertClaims } from './alert-claim'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { backoffCooldownKey, clearCondition, type BackoffKv } from './alert-backoff'
import { keepAlerted, markSpikeSeen, recoveryDue, recoveryKey, settleRecovery, RECOVERY_REARM_MINUTES, type RecoveryKv } from './alert-recovery'
import { deliverAll, postStanding, type SlackTarget } from './standing-alert'
import { sendDatabaseMemoryShortAlert, sendDatabaseMemoryUnreadableAlert, sendGroupedRecoveryAlert } from './slack'
import { recordMemoryReading, type StoredMemoryReading } from './database-memory-readings'
import { formatErr } from './format-error'

const MIN = 60 * 1000
const MB = 1024 * 1024
/** Decimal MB, the unit the thresholds are set in and sizes are shown in, for the log line. */
const MB_DECIMAL = 1_000_000

/** The heartbeat id the scheduler stamps for this check. */
export const DATABASE_MEMORY_JOB = 'database-memory'
/** The alert key for memory running thin. Mute it by writing `supabase-memory:cooldown` with a TTL. */
export const DATABASE_MEMORY_KEY = 'supabase-memory'
/** The alert key for the feed being unreadable, muted on its own. */
export const DATABASE_MEMORY_UNREADABLE_KEY = 'supabase-memory-unreadable'
export const DATABASE_MEMORY_STATE_KEY = 'database-memory:state'
const RECOVERY_PREFIX = 'supabase-memory'
const MEMORY_ID = 'memory'
const FEED_ID = 'feed'

/** Less than this share of memory available is thin. */
export const MEMORY_FREE_FLOOR = 0.15
/**
 * More than this much swap in use counts as the database moving memory to disk at a level
 * worth a page. It sits above the ~300 MB the overnight batch window reaches on its own and
 * over halfway to the ~1 GB of swap that preceded the Oct 8 stall, so benign nightly
 * swapping never pages but a climb toward that shape does. Reasoned, not calibrated: the
 * swap figure history is not reachable by API, so every run logs `swap_used_mb` for it to be
 * checked against a full day of real readings (L172). Decimal MB, so it reads as a round
 * 600 MB wherever a size is shown (Supabase sizes compute in decimal).
 */
export const SWAP_CONCERN_BYTES = 600 * 1000 * 1000
/**
 * Once swap has crossed `SWAP_CONCERN_BYTES`, it stays reported until it falls back under
 * this lower line. The hysteresis stops swap hovering at the threshold from flipping the
 * state on every reading, which would restart the 15 minute stretch and never alert a
 * database parked at the danger line.
 */
export const SWAP_CLEAR_BYTES = 500 * 1000 * 1000
/** Memory thin on every reading for this long, on the clock, alerts. */
export const MEMORY_SHORT_ALERT_AFTER_MS = 15 * MIN
/** The feed unreadable for this long alerts that memory cannot be measured. */
export const FEED_UNREADABLE_ALERT_AFTER_MS = 30 * MIN
export const METRICS_TIMEOUT_MS = 10_000
/** A standing record is re-armed on every reading, so this only bounds one left behind. */
const CONDITION_TTL_SECONDS = 25 * 60 * 60

const REQUIRED_METRIC = {
  totalBytes: 'node_memory_MemTotal_bytes',
  availableBytes: 'node_memory_MemAvailable_bytes',
  swapTotalBytes: 'node_memory_SwapTotal_bytes',
  swapFreeBytes: 'node_memory_SwapFree_bytes',
} as const
/** Logged for diagnostics but no longer judged, so its absence must not fail a reading. */
const SWAP_OUT_METRIC = 'node_vmstat_pswpout'

export interface MemoryReading {
  totalBytes: number
  availableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
  /** Cumulative pages swapped out since the database last started, or null if the feed omits or garbles it. */
  swapOutPages: number | null
}

export type FeedAnswer = { kind: 'read'; reading: MemoryReading } | { kind: 'failed'; reason: string }

/** The Prometheus feed's address for a project URL, or null when the URL cannot be read. */
export function metricsUrl(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null
  try {
    return `${new URL(supabaseUrl).origin}/customer/v1/privileged/metrics`
  } catch {
    return null
  }
}

/** One db-service figure from Prometheus text, or a reason it could not be read (L521: two lines refused, never picked). */
function dbMetric(lines: string[], name: string): { ok: true; value: number } | { ok: false; reason: string } {
  const matches = lines.filter((l) => l.startsWith(`${name}{`) && l.includes('service_type="db"'))
  if (matches.length === 0) return { ok: false, reason: `the feed carried no ${name} for the db service` }
  if (matches.length > 1) return { ok: false, reason: `the feed carried ${matches.length} ${name} lines for the db service` }
  // The value is the first field after the labels; Prometheus allows a timestamp after it.
  const token = matches[0].slice(matches[0].lastIndexOf('}') + 1).trim().split(/\s+/)[0]
  const value = token === '' ? NaN : Number(token)
  if (!Number.isFinite(value)) return { ok: false, reason: `${name} was not a number` }
  return { ok: true, value }
}

/**
 * The four byte figures for the `db` service from Prometheus text, plus the swap-out counter.
 * The feed also reports gotrue, postgrest and postgresql, so a line is taken only with
 * `service_type="db"`. The four byte figures are required and the reading fails without any
 * of them. The swap-out counter is only logged, not judged, so the feed dropping or renaming
 * it reads as null (logged as unknown) rather than failing the whole reading and raising a
 * false unreadable alert (#1928 follow-up).
 */
export function parseMemoryMetrics(text: string): FeedAnswer {
  const lines = text.split('\n')
  const reading: Partial<MemoryReading> = {}
  for (const [field, name] of Object.entries(REQUIRED_METRIC) as Array<[keyof MemoryReading, string]>) {
    const m = dbMetric(lines, name)
    if (!m.ok) return { kind: 'failed', reason: m.reason }
    reading[field] = m.value
  }
  if (reading.totalBytes === 0) return { kind: 'failed', reason: `${REQUIRED_METRIC.totalBytes} was 0` }
  // null, not 0, when it cannot be read, so the log shows "unknown" rather than a figure that
  // reads as a measured zero (L11). The reading still succeeds: the counter is not judged.
  const swapOut = dbMetric(lines, SWAP_OUT_METRIC)
  reading.swapOutPages = swapOut.ok ? swapOut.value : null
  return { kind: 'read', reading: reading as MemoryReading }
}

/** The production read: one GET with the secret key as Basic auth, a deadline, and never a throw. */
export async function fetchMemoryReading(opts: { url: string; secretKey: string | undefined; fetchImpl?: typeof fetch }): Promise<FeedAnswer> {
  // An absent key is its own cause: sent as "undefined" it would come back as a 401 and the
  // alert would blame a key that was never there (L11).
  if (!opts.secretKey) return { kind: 'failed', reason: 'SUPABASE_SECRET_KEY is not set on the worker' }
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(opts.url, {
      method: 'GET',
      headers: { Authorization: `Basic ${btoa(`service_role:${opts.secretKey}`)}` },
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    })
    if (!res.ok) return { kind: 'failed', reason: `the metrics feed answered HTTP ${res.status}` }
    return parseMemoryMetrics(await res.text())
  } catch (e) {
    return { kind: 'failed', reason: `the metrics feed could not be fetched: ${formatErr(e)}` }
  }
}

type MemoryStateName = 'ok' | 'short' | 'unreadable'

/**
 * Memory and the feed run on two clocks (#1928 review). Memory's state changes only on a
 * reading that worked, so a failed read in the middle of a thin stretch neither ends it nor
 * restarts its 15 minutes: a feed failing one read in three would otherwise hold the alert
 * off for ever while never failing long enough to raise its own.
 */
interface MemoryState {
  /** Memory as last measured. */
  state: 'ok' | 'short'
  reason: string
  /** ISO time the current memory state began. Every memory threshold is judged from here. */
  since: string
  /** ISO time the feed began failing, present only while it is failing. */
  feedFailingSince?: string
  /** Whether swap is currently latched above the concern line, carried across readings for hysteresis. */
  swapLatched?: boolean
  /** Over the current thin stretch only: the lowest available figure, and which signs were seen. */
  lowestAvailableBytes?: number
  lowFree?: boolean
  swapping?: boolean
}

/**
 * A read that THREW is a storage outage and skips the run. A record that reads but cannot be
 * parsed is permanent, so it is replaced rather than skipped: skipping would leave the check
 * blind on every later run while its heartbeat said it was running.
 */
type StateRead = { kind: 'absent' } | { kind: 'unreadable'; error: string } | { kind: 'malformed'; error: string } | { kind: 'present'; state: MemoryState }

async function readState(kv: RecoveryKv): Promise<StateRead> {
  let raw: string | null
  try {
    raw = await kv.get(DATABASE_MEMORY_STATE_KEY)
  } catch (e) {
    return { kind: 'unreadable', error: formatErr(e) }
  }
  if (raw === null) return { kind: 'absent' }
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryState>
    const isTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
    const isNumber = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v))
    const isFlag = (v: unknown) => v === undefined || typeof v === 'boolean'
    const valid = (['ok', 'short'] as const).includes(parsed.state as 'ok' | 'short') && isTime(parsed.since) &&
      (parsed.feedFailingSince === undefined || isTime(parsed.feedFailingSince)) &&
      isNumber(parsed.lowestAvailableBytes) &&
      isFlag(parsed.lowFree) && isFlag(parsed.swapping) && isFlag(parsed.swapLatched)
    if (!valid) return { kind: 'malformed', error: 'the state record is not one this check wrote' }
    // Rebuild from the known fields only, so a field an earlier version wrote (the retired
    // swap-growth baseline) is dropped on first read rather than carried forward for ever by
    // the `{ ...previous }` spreads downstream.
    const clean: MemoryState = { state: parsed.state as 'ok' | 'short', reason: parsed.reason ?? 'clear', since: parsed.since as string }
    if (parsed.feedFailingSince !== undefined) clean.feedFailingSince = parsed.feedFailingSince
    if (parsed.swapLatched !== undefined) clean.swapLatched = parsed.swapLatched
    if (parsed.lowestAvailableBytes !== undefined) clean.lowestAvailableBytes = parsed.lowestAvailableBytes
    if (parsed.lowFree !== undefined) clean.lowFree = parsed.lowFree
    if (parsed.swapping !== undefined) clean.swapping = parsed.swapping
    return { kind: 'present', state: clean }
  } catch (e) {
    return { kind: 'malformed', error: formatErr(e) }
  }
}

export interface DatabaseMemoryDeps {
  kv: BackoffKv & RecoveryKv
  claims: AlertClaims | undefined
  env: Record<string, string | undefined>
  read: () => Promise<FeedAnswer>
  resolveSlack: () => Promise<SlackTarget[]>
  senders: {
    short: typeof sendDatabaseMemoryShortAlert
    unreadable: typeof sendDatabaseMemoryUnreadableAlert
    recovery: typeof sendGroupedRecoveryAlert
  }
  now: () => number
  log: (line: string) => void
}

export interface DatabaseMemorySummary {
  /** `error` when the run could not judge at all (its own state unreadable). */
  state: MemoryStateName | 'error'
  freeShare: number | null
  alerts: string[]
  allClears: string[]
  errors: string[]
  mode: 'alert' | 'silent'
}

const iso = (ms: number) => new Date(ms).toISOString()

export async function runDatabaseMemoryCheck(deps: DatabaseMemoryDeps): Promise<DatabaseMemorySummary> {
  const nowMs = deps.now()
  const mode: DatabaseMemorySummary['mode'] = deps.env.LOCAL_DEV ? 'silent' : 'alert'
  const summary: DatabaseMemorySummary = { state: 'error', freeShare: null, alerts: [], allClears: [], errors: [], mode }

  let answer: FeedAnswer
  try {
    answer = await deps.read()
  } catch (e) {
    answer = { kind: 'failed', reason: `the read threw: ${formatErr(e)}` }
  }

  const prior = await readState(deps.kv)
  if (prior.kind === 'unreadable') {
    summary.errors.push(`state unreadable: ${prior.error}`)
    deps.log(`[database-memory] event=database_memory state=error reason=${JSON.stringify(`state unreadable: ${prior.error}`)}`)
    return summary
  }
  if (prior.kind === 'malformed') {
    summary.errors.push(`state replaced: ${prior.error}`)
    deps.log(`[database-memory] event=database_memory state_reset=malformed reason=${JSON.stringify(prior.error)}`)
  }
  const previous = prior.kind === 'present' ? prior.state : null

  let reading: MemoryReading | null = null
  let state: MemoryState
  let lowFree = false
  let swapping = false
  let line: string
  // The figures to record for calibration (#2010), set only on a reading that worked.
  let toRecord: StoredMemoryReading | null = null
  if (answer.kind === 'failed') {
    summary.state = 'unreadable'
    // Memory is carried as last measured; only the feed's clock moves.
    state = previous ? { ...previous } : { state: 'ok', reason: 'no reading yet', since: iso(nowMs) }
    state.feedFailingSince = previous?.feedFailingSince ?? iso(nowMs)
    line = ` reason=${JSON.stringify(answer.reason)} feed_failing_since=${state.feedFailingSince}`
  } else {
    reading = answer.reading
    const freeShare = reading.availableBytes / reading.totalBytes
    const swapUsed = reading.swapTotalBytes - reading.swapFreeBytes
    // Swap judged by its LEVEL, not growth: benign overnight swapping stays well under this,
    // a climb toward the Oct 8 shape crosses it (#1928 follow-up). Hysteresis: once swap is
    // over the concern line it stays reported until it falls under the lower clear line, so
    // swap parked at the line does not flip the state every reading and reset the 15 minutes.
    const wasLatched = previous?.swapLatched ?? false
    swapping = swapUsed > SWAP_CONCERN_BYTES || (wasLatched && swapUsed >= SWAP_CLEAR_BYTES)
    lowFree = freeShare < MEMORY_FREE_FLOOR
    const current = lowFree || swapping ? 'short' : 'ok'
    const reason = [lowFree ? 'low_free' : null, swapping ? 'swap_high' : null].filter(Boolean).join('+') || 'clear'
    summary.state = current
    summary.freeShare = freeShare
    const changed = previous === null || previous.state !== current
    state = changed ? { state: current, reason, since: iso(nowMs) } : { ...previous, reason }
    delete state.feedFailingSince
    // Carried across readings and across the ok boundary, so the clear line is honoured.
    state.swapLatched = swapping
    if (current === 'short') {
      state.lowestAvailableBytes = Math.min(state.lowestAvailableBytes ?? Infinity, reading.availableBytes)
      state.lowFree = (state.lowFree ?? false) || lowFree
      state.swapping = (state.swapping ?? false) || swapping
    } else {
      delete state.lowestAvailableBytes
      delete state.lowFree
      delete state.swapping
    }
    // Decimal MB, the unit the thresholds are set in and the Slack copy shows, so a logged
    // swap_used_mb is directly comparable to the 600 MB concern line it exists to calibrate.
    line =
      ` free_pct=${(freeShare * 100).toFixed(1)} available_mb=${Math.round(reading.availableBytes / MB_DECIMAL)} total_mb=${Math.round(reading.totalBytes / MB_DECIMAL)}` +
      ` swap_used_mb=${Math.round(swapUsed / MB_DECIMAL)} swap_out_pages=${reading.swapOutPages ?? 'unknown'}` +
      ` swap_high=${swapping}`
    // Recorded in the same figures and unit as the log line (L118), so the swap figure stored
    // for calibration is the exact one compared against the 600 MB concern line.
    toRecord = {
      at: nowMs,
      freePct: Number((freeShare * 100).toFixed(1)),
      availableMb: Math.round(reading.availableBytes / MB_DECIMAL),
      totalMb: Math.round(reading.totalBytes / MB_DECIMAL),
      swapUsedMb: Math.round(swapUsed / MB_DECIMAL),
      swapHigh: swapping,
    }
  }
  const heldForMs = nowMs - Date.parse(state.since)

  deps.log(`[database-memory] event=database_memory state=${summary.state}${line} memory_since=${state.since} for=${Math.round(heldForMs / 1000)}s`)

  // Local dev reads and logs, but writes nothing, as the partner probe does.
  if (mode === 'silent') return summary

  try {
    await deps.kv.put(DATABASE_MEMORY_STATE_KEY, JSON.stringify(state))
  } catch (e) {
    summary.errors.push(`state write failed: ${formatErr(e)}`)
  }

  // Give the reading a queryable home so the swap thresholds can be calibrated against real
  // data (#2010). KV, never the watched database, and off the critical path. A failed record
  // is reported, not thrown, so it never breaks the alerting the run exists to do (L95).
  if (toRecord) {
    try {
      await recordMemoryReading(deps.kv, toRecord, { log: deps.log })
    } catch (e) {
      summary.errors.push(`reading not recorded: ${formatErr(e)}`)
    }
  }

  // Read only when about to post: the connections live in the database this check watches,
  // so a quiet run must not add a read to it every five minutes.
  let resolved: SlackTarget[] | null = null
  const targets = async (): Promise<SlackTarget[]> => {
    if (resolved !== null) return resolved
    try {
      resolved = await deps.resolveSlack()
    } catch (e) {
      summary.errors.push(`Slack destinations could not be resolved: ${formatErr(e)}`)
      resolved = []
    }
    return resolved
  }
  const claim = async (key: string): Promise<boolean> => (deps.claims ? deps.claims.claim(key, ALERT_CLAIM_TTL_SECONDS) : true)
  const release = async (key: string): Promise<void> => { if (deps.claims) await deps.claims.release(key) }

  /** Keep the all-clear marker alive only for an incident that was actually posted (L12). */
  const keepIfAlerted = async (id: string, posted: boolean, since: string) => {
    if (posted || (await deps.kv.get(recoveryKey(RECOVERY_PREFIX, id))) !== null) await keepAlerted(deps.kv, RECOVERY_PREFIX, id, since)
  }

  const allClear = async (id: string, key: string, subject: string, signal: string, recoveredPhrase: string) => {
    const due = await recoveryDue(deps.kv, RECOVERY_PREFIX, id, { now: nowMs })
    if (!due) return
    const claimKey = `${RECOVERY_PREFIX}-recovery-${id}`
    if (!(await claim(claimKey))) return
    const delivered = await deliverAll(await targets(), (s) => deps.senders.recovery(s, s.default_channel, {
      signal,
      recoveredPhrase,
      items: [{ subject, alertedAt: due.alertedAt, endedAt: due.endedAt }],
    }, nowMs))
    if (!delivered) {
      await release(claimKey)
      summary.errors.push(`the ${signal} all-clear was not delivered`)
      return
    }
    await settleRecovery(deps.kv, RECOVERY_PREFIX, id, backoffCooldownKey(key))
    await clearCondition(deps.kv, key)
    summary.allClears.push(id)
  }

  const feedAllClear = () => allClear(FEED_ID, DATABASE_MEMORY_UNREADABLE_KEY, 'The metrics feed', 'database memory unreadable', `has answered every reading for ${RECOVERY_REARM_MINUTES} minutes`)

  if (answer.kind === 'failed') {
    const feedSince = state.feedFailingSince ?? iso(nowMs)
    const reason = answer.reason
    // Memory is unmeasured, not clear: the memory incident's running end moves too, so a
    // run of failed reads can never count toward its all-clear.
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, MEMORY_ID, nowMs)
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, FEED_ID, nowMs)
    if (nowMs - Date.parse(feedSince) >= FEED_UNREADABLE_ALERT_AFTER_MS) {
      const posted = await postStanding({
        kv: deps.kv, key: DATABASE_MEMORY_UNREADABLE_KEY, claim, release, targets, nowMs,
        alert: { problem: 'feed-unreadable', details: [reason] },
        conditionTtlSeconds: CONDITION_TTL_SECONDS, logPrefix: '[database-memory]', log: deps.log,
        send: (s, repeat) => deps.senders.unreadable(s, s.default_channel, { reason, since: feedSince, repeat, at: nowMs }),
      })
      if (posted) summary.alerts.push('unreadable')
      await keepIfAlerted(FEED_ID, posted, feedSince)
    }
    return summary
  }

  await feedAllClear()

  if (state.state === 'short' && reading) {
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, MEMORY_ID, nowMs)
    if (heldForMs >= MEMORY_SHORT_ALERT_AFTER_MS) {
      const payload = {
        totalBytes: reading.totalBytes,
        freeFloor: MEMORY_FREE_FLOOR,
        lowestAvailableBytes: state.lowestAvailableBytes ?? reading.availableBytes,
        lowFree: state.lowFree ?? lowFree,
        swapping: state.swapping ?? swapping,
        swapUsedBytes: reading.swapTotalBytes - reading.swapFreeBytes,
        swapConcernBytes: SWAP_CONCERN_BYTES,
        since: state.since,
        at: nowMs,
      }
      const posted = await postStanding({
        kv: deps.kv, key: DATABASE_MEMORY_KEY, claim, release, targets, nowMs,
        alert: { problem: 'memory-short', details: [String(payload.lowFree), String(payload.swapping), String(Math.round(payload.lowestAvailableBytes / MB))] },
        conditionTtlSeconds: CONDITION_TTL_SECONDS, logPrefix: '[database-memory]', log: deps.log,
        send: (s, repeat) => deps.senders.short(s, s.default_channel, { ...payload, repeat }),
      })
      if (posted) summary.alerts.push('short')
      await keepIfAlerted(MEMORY_ID, posted, state.since)
    }
    return summary
  }

  await allClear(MEMORY_ID, DATABASE_MEMORY_KEY, 'The database', 'database memory',
    `has kept more than ${Math.round(MEMORY_FREE_FLOOR * 100)} percent of its memory free, with its swap back below the level we watch, for ${RECOVERY_REARM_MINUTES} minutes`)
  return summary
}

/** The senders the cron wires in production. */
export const liveDatabaseMemorySenders: DatabaseMemoryDeps['senders'] = {
  short: sendDatabaseMemoryShortAlert,
  unreadable: sendDatabaseMemoryUnreadableAlert,
  recovery: sendGroupedRecoveryAlert,
}
