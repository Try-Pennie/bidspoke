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
 *  - Thin means less than `MEMORY_FREE_FLOOR` of memory available, or the database moving
 *    memory to disk since the previous reading: the swap-out counter rising, or the swap in
 *    use growing by more than `SWAP_GROWTH_BYTES`. Either sign on every reading for
 *    `MEMORY_SHORT_ALERT_AFTER_MS` alerts. Both are read because on 2026-10-09 the host held
 *    50 MB in swap with the counter still at 0, so the counter alone can miss swapping.
 *    Swap merely IN USE is not judged: pages pushed out once can sit there long after the
 *    pressure ends, so only growth is evidence of pressure now.
 *  - Every threshold is judged on the CLOCK from the moment a state began, never on a count
 *    of ticks, because a delayed or retried cron moves a count without moving time (L386).
 *  - A first reading has no earlier counter, and a counter that went BACKWARDS means the
 *    database restarted (a compute resize does that), so neither is read as swapping. The
 *    restart is logged as `counter_reset=true`.
 *  - A feed it cannot read is its own state, never healthy memory (L215): a standing memory
 *    alert gets no all-clear from a run of failed reads, and the feed failing for
 *    `FEED_UNREADABLE_ALERT_AFTER_MS` is its own alert so silence never means a dead check.
 *  - It posts to every org's Slack with the last-good copy as the fallback, because the
 *    connection's home is the database this alert is about (L682).
 *
 * The 15 percent floor was reasoned, not calibrated: it went live with one reading taken
 * minutes after the move to Medium. Every run logs its figures so the floor can be checked
 * against a full day of real readings (L172). Log line to search for: `event=database_memory`.
 */
import type { AlertClaims } from './alert-claim'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { backoffCooldownKey, clearCondition, type BackoffKv } from './alert-backoff'
import { keepAlerted, markSpikeSeen, recoveryDue, recoveryKey, settleRecovery, RECOVERY_REARM_MINUTES, type RecoveryKv } from './alert-recovery'
import { deliverAll, postStanding, type SlackTarget } from './standing-alert'
import { sendDatabaseMemoryShortAlert, sendDatabaseMemoryUnreadableAlert, sendGroupedRecoveryAlert } from './slack'
import { formatErr } from './format-error'

const MIN = 60 * 1000
const MB = 1024 * 1024

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
/** Swap in use growing by more than this between readings counts as moving memory to disk. */
export const SWAP_GROWTH_BYTES = 1024 * 1024
/** Memory thin on every reading for this long, on the clock, alerts. */
export const MEMORY_SHORT_ALERT_AFTER_MS = 15 * MIN
/** The feed unreadable for this long alerts that memory cannot be measured. */
export const FEED_UNREADABLE_ALERT_AFTER_MS = 30 * MIN
export const METRICS_TIMEOUT_MS = 10_000
/** A standing record is re-armed on every reading, so this only bounds one left behind. */
const CONDITION_TTL_SECONDS = 25 * 60 * 60

const METRIC = {
  totalBytes: 'node_memory_MemTotal_bytes',
  availableBytes: 'node_memory_MemAvailable_bytes',
  swapTotalBytes: 'node_memory_SwapTotal_bytes',
  swapFreeBytes: 'node_memory_SwapFree_bytes',
  swapOutPages: 'node_vmstat_pswpout',
} as const

export interface MemoryReading {
  totalBytes: number
  availableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
  /** Cumulative pages swapped out since the database last started. */
  swapOutPages: number
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

/**
 * The five figures for the `db` service from Prometheus text. The feed also reports
 * gotrue, postgrest and postgresql, so a line is taken only with `service_type="db"`, and
 * two such lines for one figure is refused rather than resolved by picking one (L521).
 */
export function parseMemoryMetrics(text: string): FeedAnswer {
  const lines = text.split('\n')
  const reading: Partial<MemoryReading> = {}
  for (const [field, name] of Object.entries(METRIC) as Array<[keyof MemoryReading, string]>) {
    const matches = lines.filter((l) => l.startsWith(`${name}{`) && l.includes('service_type="db"'))
    if (matches.length === 0) return { kind: 'failed', reason: `the feed carried no ${name} for the db service` }
    if (matches.length > 1) return { kind: 'failed', reason: `the feed carried ${matches.length} ${name} lines for the db service` }
    // The value is the first field after the labels; Prometheus allows a timestamp after it.
    const token = matches[0].slice(matches[0].lastIndexOf('}') + 1).trim().split(/\s+/)[0]
    const value = token === '' ? NaN : Number(token)
    if (!Number.isFinite(value)) return { kind: 'failed', reason: `${name} was not a number` }
    reading[field] = value
  }
  if (reading.totalBytes === 0) return { kind: 'failed', reason: `${METRIC.totalBytes} was 0` }
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
  /** The swap-out counter at the last successful reading, carried across failed ones. */
  lastSwapOut?: number
  /** Swap in use at the last successful reading, carried across failed ones. */
  lastSwapUsed?: number
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
    const valid = (['ok', 'short'] as const).includes(parsed.state as 'ok' | 'short') && typeof parsed.since === 'string' && Number.isFinite(Date.parse(parsed.since))
    if (!valid) return { kind: 'malformed', error: 'the state record is not one this check wrote' }
    return { kind: 'present', state: parsed as MemoryState }
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
  if (answer.kind === 'failed') {
    summary.state = 'unreadable'
    // Memory is carried as last measured; only the feed's clock moves.
    state = previous ? { ...previous } : { state: 'ok', reason: 'no reading yet', since: iso(nowMs) }
    state.feedFailingSince = previous?.feedFailingSince ?? iso(nowMs)
    line = ` reason=${JSON.stringify(answer.reason)} feed_failing_since=${state.feedFailingSince}`
  } else {
    reading = answer.reading
    const freeShare = reading.availableBytes / reading.totalBytes
    const counterReset = previous?.lastSwapOut !== undefined && reading.swapOutPages < previous.lastSwapOut
    const swapUsed = reading.swapTotalBytes - reading.swapFreeBytes
    const counterRose = previous?.lastSwapOut !== undefined && reading.swapOutPages > previous.lastSwapOut
    const swapGrew = previous?.lastSwapUsed !== undefined && swapUsed - previous.lastSwapUsed > SWAP_GROWTH_BYTES
    swapping = counterRose || swapGrew
    lowFree = freeShare < MEMORY_FREE_FLOOR
    const current = lowFree || swapping ? 'short' : 'ok'
    const reason = [lowFree ? 'low_free' : null, swapping ? 'swapping' : null].filter(Boolean).join('+') || 'clear'
    summary.state = current
    summary.freeShare = freeShare
    const changed = previous === null || previous.state !== current
    state = changed ? { state: current, reason, since: iso(nowMs) } : { ...previous, reason }
    delete state.feedFailingSince
    state.lastSwapOut = reading.swapOutPages
    state.lastSwapUsed = swapUsed
    if (current === 'short') {
      state.lowestAvailableBytes = Math.min(state.lowestAvailableBytes ?? Infinity, reading.availableBytes)
      state.lowFree = (state.lowFree ?? false) || lowFree
      state.swapping = (state.swapping ?? false) || swapping
    } else {
      delete state.lowestAvailableBytes
      delete state.lowFree
      delete state.swapping
    }
    line =
      ` free_pct=${(freeShare * 100).toFixed(1)} available_mb=${Math.round(reading.availableBytes / MB)} total_mb=${Math.round(reading.totalBytes / MB)}` +
      ` swap_used_mb=${Math.round(swapUsed / MB)} swap_out_pages=${reading.swapOutPages}` +
      ` swapped=${swapping} counter_reset=${counterReset}`
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

  let targets: SlackTarget[] = []
  try {
    targets = await deps.resolveSlack()
  } catch (e) {
    summary.errors.push(`Slack destinations could not be resolved: ${formatErr(e)}`)
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
    const delivered = await deliverAll(targets, (s) => deps.senders.recovery(s, s.default_channel, {
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
    `has kept more than ${Math.round(MEMORY_FREE_FLOOR * 100)} percent of its memory free, with nothing moved to disk, for ${RECOVERY_REARM_MINUTES} minutes`)
  return summary
}

/** The senders the cron wires in production. */
export const liveDatabaseMemorySenders: DatabaseMemoryDeps['senders'] = {
  short: sendDatabaseMemoryShortAlert,
  unreadable: sendDatabaseMemoryUnreadableAlert,
  recovery: sendGroupedRecoveryAlert,
}
