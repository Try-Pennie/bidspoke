/**
 * The one owner of "Bidspoke cannot read its database" (#2061, #1303 phase 3).
 *
 * Until #2061 only the minute volume check could say the database was down, and
 * only when one of its own three reads failed; the rest of the scheduled code
 * found out separately and said nothing. Now every scheduled read that fails
 * reports here, and this module alone pages, from the saved Slack copy (the
 * token's home is the database that cannot be read), with its claim and the
 * backoff it always had. Its KV keys are the ones volume-cliff.ts wrote, so an
 * incident open at the deploy is continued rather than announced again.
 *
 * Who reports, and when a report pages (REACHABILITY_SOURCES):
 *
 * - the volume check's three reads (volume-cliff.ts) page at once, as they did:
 *   they run under the client's full deadline, so a failure there has waited;
 * - the minute probe (below) and the per tick scheduled read flag
 *   (scheduled-slack.ts onUnreachable) are fast reads, 5 s and 3 s, never
 *   calibrated against the 08:15 to 09:10 UTC batch window, so a failure from
 *   either pages only when a failure was also reported in the minute before.
 *   One slow read in a busy minute is not an outage; two minutes running is.
 *
 * The all-clear is owed only when no scheduled read has failed for the re-arm
 * window AND the probe and the volume check have each answered for that whole
 * window (at least every HEALTH_GAP_MS). A missing failure is not enough on its
 * own: a volume check abandoned at the minute deadline in a stall never reports
 * anything, and one cheap probe read answering then must not stand the incident
 * down (L345, L98). The all-clear says what was measured.
 *
 * The probe is also the writer of the saved Slack copy, so the copy's freshness
 * no longer depends on the volume check's heavy reads. Its heartbeat stamps are
 * passed in by the scheduled handler, and the completed one is written in a
 * finally, so a probe that throws still reads as a run that finished.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readSlackConnectionRows } from './alert-fanout'
import { boundedRead, type BoundableQuery } from './scheduled-slack'
import { readSlackCopy, rememberSlackConnections } from './slack-copy'
import { parseSlackConnection, type SlackConnection } from './slack-connection'
import { sendDatabaseRecoveredAlert, sendDatabaseUnreachableAlert } from './slack'
import {
  announceRecovery,
  markAlerted,
  markSpikeSeen,
  recordPaged,
  RECOVERY_REARM_MINUTES,
  RECOVERY_TTL_SECONDS,
  type IncidentContext,
  type RecoveryKv,
} from './alert-recovery'
import { BACKOFF_STEPS_SECONDS, backoffCooldownKey, clearCondition, describeRepeat, inCooldown, readCondition, recordAlert } from './alert-backoff'
import type { AlertClaims } from './alert-claim'
import type { SecretKeyInput } from './secret-crypto'
import { formatErr } from './format-error'

/** The incident record's signal, and the prefix of every key below (unchanged from volume-cliff.ts). */
export const DB_UNREACHABLE_PREFIX = 'db-unreachable'
export const DB_UNREACHABLE_COOLDOWN_SECONDS = 15 * 60

/** The heartbeat job id of the minute probe (cron-heartbeat.ts CRON_JOBS). */
export const DATABASE_REACHABILITY_JOB = 'database-reachability'

/** The probe's deadline: one small read, never calibrated, so one failure does not page. */
export const DB_PROBE_DEADLINE_MS = 5_000

/**
 * The longest gap between two answers that still counts as answering throughout
 * the window. The probe and the volume check run every minute; this allows a
 * dropped tick or a run cut at the minute deadline, and no more.
 */
export const HEALTH_GAP_MS = 5 * 60_000

// A database that cannot be read refuses work while it stands, so the page
// keeps its short first reminder and then climbs the shared tail (#1337).
const DB_UNREACHABLE_STEPS = [DB_UNREACHABLE_COOLDOWN_SECONDS, ...BACKOFF_STEPS_SECONDS]
// The standing condition lives as long as the recovery marker, so it cannot
// outlive a held all-clear and make a later outage read as a reminder (#1337).
const CONDITION_TTL_SECONDS = RECOVERY_TTL_SECONDS
// A claim only has to outlast ticks released together (#1298).
const ALERT_CLAIM_TTL_SECONDS = 2 * 60

const backoffKey = (orgId: string) => `${DB_UNREACHABLE_PREFIX}:${orgId}`
const FAILED_MINUTES_KEY = 'db-reachability:failed-minutes'
const sourceKey = (source: ReachabilitySource) => `db-reachability:source:${source}`
// The failed minutes only need to reach back one minute; a few are kept for a reader.
const FAILED_MINUTES_KEPT = 10
const FAILED_MINUTES_TTL_SECONDS = 60 * 60

const incident = (orgId: string): IncidentContext => ({ scope: { kind: 'org', organizationId: orgId }, subjectLabel: 'Bidspoke' })

/** Every reader that reports here, how its failure pages, and whether the all-clear needs it seen answering. */
export const REACHABILITY_SOURCES = {
  'volume-cliff': { pages: 'at-once', mustBeSeenAnswering: true, words: 'the volume check' },
  probe: { pages: 'second-minute', mustBeSeenAnswering: true, words: 'the minute database probe' },
  // Not every tick makes a scheduled Slack read, so its answering cannot be
  // seen; only its failures count, and they hold the all-clear for the window.
  'scheduled-read': { pages: 'second-minute', mustBeSeenAnswering: false, words: 'a scheduled Slack read' },
} as const satisfies Record<string, { pages: 'at-once' | 'second-minute'; mustBeSeenAnswering: boolean; words: string }>

export type ReachabilitySource = keyof typeof REACHABILITY_SOURCES

export interface ReachabilityDeps {
  kv: RecoveryKv
  secretKeys: SecretKeyInput
  appUrl: string
  /** Decides which of several simultaneous reporters posts (#1298); production always passes it. */
  claims?: AlertClaims
  now?: () => number
}

export interface UnreachableReport {
  source: ReachabilitySource
  /** The read that failed, as the page names it. */
  what: string
  error: unknown
}

/** One reader's record: when it last answered, since when it has answered without a break, and when it last failed. */
interface SourceRecord {
  healthySince: number | null
  lastHealthy: number | null
  lastFailed: number | null
}

async function readSource(kv: RecoveryKv, source: ReachabilitySource): Promise<SourceRecord> {
  const raw = await kv.get(sourceKey(source))
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<SourceRecord>
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return { healthySince: num(p.healthySince), lastHealthy: num(p.lastHealthy), lastFailed: num(p.lastFailed) }
    } catch {
      // An unreadable record is read as nothing seen, which holds the all-clear (the safe side).
    }
  }
  return { healthySince: null, lastHealthy: null, lastFailed: null }
}

function writeSource(kv: RecoveryKv, source: ReachabilitySource, record: SourceRecord): Promise<void> {
  return kv.put(sourceKey(source), JSON.stringify(record), { expirationTtl: RECOVERY_TTL_SECONDS })
}

/** A reader answered: extend its unbroken run, or start a new one after a gap. */
export async function reportDatabaseReadable(kv: RecoveryKv, source: ReachabilitySource, nowMs: number): Promise<void> {
  const r = await readSource(kv, source)
  const unbroken = r.healthySince !== null && r.lastHealthy !== null && nowMs - r.lastHealthy <= HEALTH_GAP_MS
  await writeSource(kv, source, { healthySince: unbroken ? r.healthySince : nowMs, lastHealthy: nowMs, lastFailed: r.lastFailed })
}

/**
 * Note a failed minute and say whether the minute before also failed. A
 * read-modify-write: two reporters in one minute add the same minute, so losing
 * one of their writes changes nothing.
 */
async function noteFailedMinute(kv: RecoveryKv, nowMs: number): Promise<boolean> {
  const minute = Math.floor(nowMs / 60_000)
  let minutes: number[] = []
  try {
    const parsed: unknown = JSON.parse((await kv.get(FAILED_MINUTES_KEY)) ?? '[]')
    if (Array.isArray(parsed)) minutes = parsed.filter((m): m is number => typeof m === 'number')
  } catch {
    minutes = []
  }
  const previousFailed = minutes.includes(minute - 1)
  if (!minutes.includes(minute)) {
    const kept = [...minutes, minute].sort((a, b) => a - b).slice(-FAILED_MINUTES_KEPT)
    await kv.put(FAILED_MINUTES_KEY, JSON.stringify(kept), { expirationTtl: FAILED_MINUTES_TTL_SECONDS })
  }
  return previousFailed
}

/** What one report did, organization by organization. */
export interface UnreachableOutcome {
  /** Organizations a page reached on this report. */
  told: string[]
  /**
   * Organizations whose page or its bookkeeping threw, with why. One whose page
   * reached Slack before its bookkeeping threw is in both lists: it was told,
   * and its next reminder may come early.
   */
  failed: { orgId: string; reason: string }[]
}

/**
 * A scheduled read failed. Recorded against its reader, stamped as the
 * incident's running end for every organization in the copy, and paged once per
 * cooldown per organization when the reader's rule says this report pages.
 *
 * Each organization is its own failure boundary: a Slack post or KV write that
 * throws for one is logged with its reason and the rest are still paged, and
 * the result says which were told and which failed. Throws only when KV refuses
 * a write before the organizations are reached (the reader's record, the
 * failed minute).
 */
export async function reportDatabaseUnreachable(deps: ReachabilityDeps, report: UnreachableReport): Promise<UnreachableOutcome> {
  const outcome: UnreachableOutcome = { told: [], failed: [] }
  const { kv } = deps
  const nowMs = (deps.now ?? Date.now)()
  const record = await readSource(kv, report.source)
  await writeSource(kv, report.source, { ...record, healthySince: null, lastFailed: nowMs })
  const previousMinuteFailed = await noteFailedMinute(kv, nowMs)
  const pages = REACHABILITY_SOURCES[report.source].pages === 'at-once' || previousMinuteFailed
  const errorText = formatErr(report.error)

  const copy = await readSlackCopy(kv, deps.secretKeys)
  if (copy.kind !== 'read' || copy.connections.size === 0) {
    const why = copy.kind === 'unreadable' ? `the saved Slack copy cannot be read (${copy.detail})` : 'there is no last-good Slack connection in KV'
    // The exact words a log alert can match on (#1303 decision 2).
    console.error(`[database-reachability] ${report.what} read failed and ${why}, so nobody can be told: ${errorText}`)
    return outcome
  }
  const copyAgeMs = copy.savedAtMs === null ? null : Math.max(0, nowMs - copy.savedAtMs)
  if (!pages) {
    console.warn(`[database-reachability] ${report.what} read failed (${errorText}); ${REACHABILITY_SOURCES[report.source].words} pages only when the minute before also failed, so this is held`)
  }

  for (const [orgId, conn] of copy.connections) {
    if (!conn.volume_alerts_enabled) continue
    const claimKey = `${DB_UNREACHABLE_PREFIX}:${orgId}`
    let claimed = false
    try {
      await markSpikeSeen(kv, DB_UNREACHABLE_PREFIX, orgId, nowMs)
      if (!pages) continue
      const backoff = backoffKey(orgId)
      if (await inCooldown(kv, backoff)) continue
      if (deps.claims && !(await deps.claims.claim(claimKey, ALERT_CLAIM_TTL_SECONDS))) {
        console.log(`[database-reachability] database unreachable alert claimed by another reporter org=${orgId}`)
        continue
      }
      claimed = deps.claims !== undefined
      // Unchanged is false since the error text can move between reminders (#1337).
      const standing = await readCondition(kv, backoff)
      const repeat = describeRepeat(standing, nowMs, false, DB_UNREACHABLE_STEPS) ?? undefined
      const ts = await sendDatabaseUnreachableAlert(conn, conn.default_channel, { what: report.what, error: errorText, appUrl: deps.appUrl, repeat, copyAgeMs })
      if (ts) {
        outcome.told.push(orgId)
        // The marker before the cooldown (#2058): a cut between them then costs at
        // worst a repeated page, never a lost all-clear.
        await markAlerted(kv, DB_UNREACHABLE_PREFIX, orgId, incident(orgId), nowMs)
        await recordPaged(kv, DB_UNREACHABLE_PREFIX, orgId, incident(orgId), nowMs)
        await recordAlert(kv, backoff, standing, nowMs, { stepsSeconds: DB_UNREACHABLE_STEPS, conditionTtlSeconds: CONDITION_TTL_SECONDS })
      } else if (claimed) {
        await deps.claims!.release(claimKey)
      }
    } catch (e) {
      // This organization only: the others are still paged. Its claim is freed
      // so the next report can try again; a page that did go out before the
      // throw costs at worst a repeat, never a lost all-clear (#2058).
      const reason = formatErr(e)
      outcome.failed.push({ orgId, reason })
      console.error(`[database-reachability] database unreachable page for org=${orgId} failed, the other organizations are still paged: ${reason}`)
      if (claimed) await deps.claims!.release(claimKey)
    }
  }
  return outcome
}

/**
 * Whether every reader has been healthy for the re-arm window, and if so the
 * sentence saying what was measured. Null holds the all-clear.
 */
async function measuredHealthy(kv: RecoveryKv, nowMs: number): Promise<string | null> {
  const windowMs = RECOVERY_REARM_MINUTES * 60_000
  let since = -Infinity
  const seen: string[] = []
  for (const source of Object.keys(REACHABILITY_SOURCES) as ReachabilitySource[]) {
    const rule = REACHABILITY_SOURCES[source]
    const r = await readSource(kv, source)
    if (r.lastFailed !== null && nowMs - r.lastFailed < windowMs) return null
    if (!rule.mustBeSeenAnswering) continue
    if (r.healthySince === null || r.lastHealthy === null) return null
    if (nowMs - r.lastHealthy > HEALTH_GAP_MS || nowMs - r.healthySince < windowMs) return null
    since = Math.max(since, r.healthySince)
    seen.push(rule.words)
  }
  const minutes = Math.floor((nowMs - since) / 60_000)
  return `Measured: for the last ${minutes} minutes ${seen.join(' and ')} have answered, at least every ${HEALTH_GAP_MS / 60_000} minutes, and no scheduled read has failed.`
}

/**
 * Announce the all-clear to each organization that was paged, once every reader
 * has been healthy for the window. Called by the probe on a healthy minute with
 * the connections it has just read, so an organization that disconnected is not
 * told. Each organization is its own failure boundary, as for the page: one
 * whose all-clear or settling throws is logged and the rest are still told, and
 * its incident stays open for the next healthy minute to try again.
 */
async function announceDatabaseReadable(deps: ReachabilityDeps, connections: Map<string, SlackConnection>, nowMs: number): Promise<void> {
  let measured: Promise<string | null> | null = null
  for (const [orgId, conn] of connections) {
    try {
      await announceOne(orgId, conn)
    } catch (e) {
      console.error(`[database-reachability] database all-clear for org=${orgId} failed, the other organizations are still told: ${formatErr(e)}`)
    }
  }

  async function announceOne(orgId: string, conn: SlackConnection): Promise<void> {
    const backoff = backoffKey(orgId)
    let sentence: string | null = null
    const recovered = await announceRecovery(
      deps.kv,
      DB_UNREACHABLE_PREFIX,
      orgId,
      backoffCooldownKey(backoff),
      incident(orgId),
      async (alertedAt, endedAt) => {
        if (!conn.volume_alerts_enabled || sentence === null) return false
        return sendDatabaseRecoveredAlert(conn, conn.default_channel, { alertedAt, endedAt, measured: sentence, appUrl: deps.appUrl }, nowMs)
      },
      {
        now: nowMs,
        // Read once a tick, and only when an all-clear is owed.
        hasEvidence: async () => {
          measured ??= measuredHealthy(deps.kv, nowMs)
          sentence = await measured
          return sentence !== null
        },
      },
    )
    // The next outage starts at the short first reminder gap (#1337).
    if (recovered) await clearCondition(deps.kv, backoff)
  }
}

export interface ProbeDeps extends ReachabilityDeps {
  supabase: SupabaseClient
  /** The deadline timer; a test controls it (L524). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  deadlineMs?: number
  /** The heartbeat stamps (cron-heartbeat.ts), passed in by the scheduled handler. */
  stamps: { started: () => Promise<void>; completed: () => Promise<void> }
}

export type ProbeResult = { kind: 'answered'; organizations: number } | { kind: 'failed'; detail: string }

/**
 * The minute probe: one bounded read of every Slack connection. An answer
 * rewrites the saved copy (an empty answer included, #2060), counts as the
 * probe answering, and lets an owed all-clear go out; a failure reports here.
 */
export async function runDatabaseReachabilityProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? Date.now
  await deps.stamps.started().catch((e: unknown) => console.error(`[database-reachability] started stamp failed: ${formatErr(e)}`))
  try {
    const nowMs = now()
    const query = readSlackConnectionRows(deps.supabase) as unknown as BoundableQuery<{ organization_id: string; config: unknown }[]>
    const read = await boundedRead(query, deps.deadlineMs ?? DB_PROBE_DEADLINE_MS, deps.sleep)
    if (read.kind === 'failed') {
      const detail = `${read.how}: ${read.detail}`
      await reportDatabaseUnreachable(deps, { source: 'probe', what: REACHABILITY_SOURCES.probe.words, error: detail })
      return { kind: 'failed', detail }
    }
    const rows = read.data ?? []
    const connections = new Map<string, SlackConnection>()
    for (const row of rows) {
      const conn = parseSlackConnection(row.config)
      if (conn) connections.set(row.organization_id, conn)
    }
    if (rows.length > 0 && connections.size === 0) {
      // The database answered, so the probe did measure it, but an empty copy
      // written now would leave the next outage nobody to tell. Most likely the
      // connection's shape changed under the parser; keep the last good copy.
      console.error(`[database-reachability] ${rows.length} Slack connection rows came back and none could be read as a Slack connection, so the saved copy was left as it was`)
    } else {
      // An empty answer is written too (#2060): every organization disconnected.
      await rememberSlackConnections(deps.kv, deps.secretKeys, connections, nowMs)
    }
    await reportDatabaseReadable(deps.kv, 'probe', nowMs)
    await announceDatabaseReadable(deps, connections, nowMs)
    return { kind: 'answered', organizations: connections.size }
  } finally {
    await deps.stamps.completed().catch((e: unknown) => console.error(`[database-reachability] completed stamp failed: ${formatErr(e)}`))
  }
}
