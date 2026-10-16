/**
 * Real-time volume cliff detection — fires within ~5 min of an upstream traffic stop.
 *
 * Companion to `volume-anomaly.ts`, which runs daily and compares whole-day totals.
 * The daily check is structurally blind to intraday cliffs (a 1-2hr stop on an
 * otherwise normal day still leaves the day's total ≥80% of baseline). This check
 * runs every minute and compares the last 5 minutes' rate to a rolling 60-minute
 * baseline, so a cliff at 21:38 UTC is alertable by ~21:43 UTC.
 *
 * Detection:
 *   baseline_per_min = median executions/min in the [-60min, -5min] window
 *   skip if baseline_per_min < MIN_BASELINE_PER_MIN (low-volume workflows)
 *   fire  if last_5min_count < (baseline_per_min * 5) * (ALERT_THRESHOLD_PCT / 100)
 *
 * Reminders: the first repeat is held 30 min, then the interval climbs the shared
 * backoff tail (6h, 12h, daily) for as long as the cliff stands, and resets the
 * moment it clears (#1337). The database-unreachable alert here uses the same
 * backoff with a 15 min first step. Both are keyed in KV under `<family>:cooldown`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { probeSlackConnectionsTable, readSlackConnectionRowsForCopy } from './alert-fanout'
import { formatErr } from './format-error'
import { getSlackConnection, postMessage, sendDatabaseUnreachableAlert } from './slack'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, RECOVERY_TTL_SECONDS, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { sendRecoveryAlert } from './slack'
import { parseSlackConnection, type SlackConnection } from './slack-connection'
import type { SecretKeyInput } from './secret-crypto'
import { readLastGoodSlackConnections, rememberSlackConnections } from './slack-copy'
import type { AlertClaims } from './alert-claim'
import { BACKOFF_STEPS_SECONDS, backoffCooldownKey, clearCondition, describeRepeat, inCooldown, readCondition, recordAlert } from './alert-backoff'

export const COOLDOWN_TTL_SECONDS = 30 * 60
// How long a claim (#1298) holds. It only has to outlast the race it exists
// for, ticks released within seconds of each other, plus KV's propagation of
// the cooldown key the winner writes. Kept far shorter than the cooldown so a
// tick that claims and then dies before posting suppresses the alert for two
// minutes, not thirty.
export const ALERT_CLAIM_TTL_SECONDS = 2 * 60
export const ALERT_THRESHOLD_PCT = 25
export const MIN_BASELINE_PER_MIN = 10
export const BASELINE_WINDOW_MINUTES = 55  // indices 0-54, minutes [-59, -5]
// The recent window is the last 4 COMPLETE minutes [-4, -1]. The current minute
// (index 59) is in progress and ~empty at cron-fire time, so including it would
// deflate the recent count and fire the alert ~6 percentage points more eagerly
// than ALERT_THRESHOLD_PCT configures (#110). It is dropped in detectCliff.
export const RECENT_WINDOW_MINUTES = 4     // [-4, -1]

// External URL we hit when a cliff fires, to confirm the worker is reachable from
// outside Cloudflare. A 200 here means the issue is upstream of CF (caller stopped
// sending); a failure means CF/route/DNS/TLS — investigate our side first.
//
// Default is a stable bidspoke-owned hostname (the hook.trypennie.dev route hits
// this worker and a GET returns 200). Override via the SELF_CHECK_URL env var.
export const DEFAULT_SELF_CHECK_URL = 'https://hook.trypennie.dev/'
const SELF_CHECK_TIMEOUT_MS = 5000

export interface DatabaseProbeResult {
  ok: boolean
  latency_ms: number
  error: string | null
}

export interface SelfCheckResult {
  ok: boolean
  status: number | null
  latency_ms: number
  error: string | null
  /** The database probe run beside the worker probe (#1297). */
  database: DatabaseProbeResult
}

// ── Speaking while the database is down (#1297) ──────────────────────────────
//
// This check counts executions in the database, and every alert path looks the
// Slack token up there too. On 2026-09-10 Supabase was unresponsive for ten
// minutes: the check could not count, could not post, and only spoke once the
// database was back, when it blamed the caller. So every healthy tick writes an
// ENCRYPTED last-good copy of the Slack connections to KV (the token is a
// secret and KV is not the place for plaintext, #491), and a tick whose reads
// fail posts from that copy instead of returning quietly. The copy's reader and
// writer live in slack-copy.ts, which every other reader of it shares.
export const DB_UNREACHABLE_PREFIX = 'db-unreachable'
export const DB_UNREACHABLE_COOLDOWN_SECONDS = 15 * 60

// Both these conditions are actively harmful while they stand (a database that
// cannot be read refuses live leads; a volume cliff is a traffic stop), so each
// keeps its short first reminder gap and then climbs the shared backoff tail (6h,
// 12h, daily) rather than waiting the shared six hours for its second reminder
// (#1337). The reminder schedule resets the moment the condition clears.
const DB_UNREACHABLE_STEPS = [DB_UNREACHABLE_COOLDOWN_SECONDS, ...BACKOFF_STEPS_SECONDS]
const VOLUME_CLIFF_STEPS = [COOLDOWN_TTL_SECONDS, ...BACKOFF_STEPS_SECONDS]
// Both paths clear the reminder schedule when the all-clear fires, but that is
// HELD when the pipe went dead (#817) and its recovery marker expires after
// RECOVERY_TTL_SECONDS. So the standing condition is given the SAME lifetime as
// that marker (refreshed on every alert, well inside it since the longest step is
// a day), rather than the 30-day default: otherwise it outlives the incident and a
// future, unrelated cliff reads as a reminder of the old one (#1337). The longest
// backoff step (a day) is under this, so an ongoing incident never expires mid-way.
const VOLUME_CONDITION_TTL_SECONDS = RECOVERY_TTL_SECONDS
// Escalating-backoff family keys. readCondition/recordAlert append :condition and
// :cooldown; these do not collide with the recovery-marker keys (markAlerted writes
// ${prefix}-recovery / -active) or the claim keys. These cooldown keys differ from
// the old flat ones (db-unreachable-cooldown:, volume-cliff-cooldown:), so a cliff
// or database outage standing at the deploy loses its old cooldown and re-pages
// once as it enters the schedule: a bounded, one-time transition (same as the
// github-backup path), and re-announcing a still-standing condition is harmless.
const dbUnreachableBackoffKey = (orgId: string) => `${DB_UNREACHABLE_PREFIX}:${orgId}`
const volumeCliffBackoffKey = (wfId: string) => `volume-cliff:${wfId}`

/**
 * The incident record's view of a database outage (#2099): one per organization,
 * since each is told in its own channel. Recorded to the KV outbox, never the
 * database, which is the thing that is down.
 */
const dbUnreachableIncident = (orgId: string): IncidentContext => ({ scope: { kind: 'org', organizationId: orgId }, subjectLabel: 'Bidspoke' })

/**
 * A read this check depends on failed. Say so in Slack from the last-good copy,
 * once per cooldown per org, and stamp the incident so the next healthy tick can
 * announce the all-clear. This is the one alert that must not need the database.
 */
async function reportDatabaseUnreachable(
  kv: KvLike,
  secretEncryptionKey: SecretKeyInput,
  what: string,
  error: unknown,
  appUrl: string,
  claims: AlertClaims | undefined,
): Promise<void> {
  const connections = await readLastGoodSlackConnections(kv, secretEncryptionKey)
  if (connections.size === 0) {
    console.error(`[volume-cliff] ${what} read failed and there is no last-good Slack connection in KV, so nobody can be told: ${formatErr(error)}`)
    return
  }
  for (const [orgId, conn] of connections) {
    if (!conn.volume_alerts_enabled) continue
    // One clock reading per org, so every record this pass writes about the
    // incident carries the same time and they sort in the order they happened.
    const nowMs = Date.now()
    await markSpikeSeen(kv, DB_UNREACHABLE_PREFIX, orgId, nowMs)
    const backoff = dbUnreachableBackoffKey(orgId)
    if (await inCooldown(kv, backoff)) continue
    const claimKey = `${DB_UNREACHABLE_PREFIX}:${orgId}`
    if (claims && !(await claims.claim(claimKey, ALERT_CLAIM_TTL_SECONDS))) {
      console.log(`[volume-cliff] database unreachable alert claimed by another tick org=${orgId}`)
      continue
    }
    // The reminder interval grows while the outage stands (#1337); unchanged is
    // false since the error text can move, so a reminder says "same problem,
    // latest details shown" and never falsely claims nothing changed.
    const standing = await readCondition(kv, backoff)
    const repeat = describeRepeat(standing, nowMs, false, DB_UNREACHABLE_STEPS) ?? undefined
    const ts = await sendDatabaseUnreachableAlert(conn, conn.default_channel, { what, error: formatErr(error), appUrl, repeat })
    if (ts) {
      // The marker before the cooldown (#2058): a cut or a refused write between
      // them then costs at worst a repeated page, never a lost all-clear.
      await markAlerted(kv, DB_UNREACHABLE_PREFIX, orgId, dbUnreachableIncident(orgId), nowMs)
      await recordPaged(kv, DB_UNREACHABLE_PREFIX, orgId, dbUnreachableIncident(orgId), nowMs)
      await recordAlert(kv, backoff, standing, nowMs, { stepsSeconds: DB_UNREACHABLE_STEPS, conditionTtlSeconds: VOLUME_CONDITION_TTL_SECONDS })
    } else if (claims) {
      await claims.release(claimKey)
    }
  }
}

export interface CliffDetection {
  workflow_id: string
  workflow_name: string
  organization_id: string
  recent_count: number
  baseline_per_min: number
}

/** The volume figures the cliff detector and the recovery check both read. */
interface VolumeAnalysis {
  /** The baseline carried enough traffic to judge against (median >= minBaseline). */
  hasBaseline: boolean
  median: number
  recentCount: number
  /** recentCount below this is a cliff, at or above it is normal volume. */
  threshold: number
}

/**
 * The shared volume math behind both the cliff detector and the recovery
 * evidence check, so the two cannot drift (L370). Returns null only when the
 * counts are the wrong shape.
 */
function analyzeVolume(
  perMinuteCounts: number[],
  lowPct: number,
  minBaseline: number,
): VolumeAnalysis | null {
  if (perMinuteCounts.length !== 60) return null

  const baseline = perMinuteCounts.slice(0, BASELINE_WINDOW_MINUTES)
  // Drop the final bucket (index 59): the current, in-progress minute is ~empty
  // at cron-fire time and would deflate the recent count (#110). Compare the last
  // 4 complete minutes against median * 4.
  const recent = perMinuteCounts.slice(BASELINE_WINDOW_MINUTES, perMinuteCounts.length - 1)

  const sorted = [...baseline].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const recentCount = recent.reduce((sum, n) => sum + n, 0)
  const expected = median * recent.length
  const threshold = expected * (lowPct / 100)
  return { hasBaseline: median >= minBaseline, median, recentCount, threshold }
}

/**
 * Pure detection logic: given per-minute counts for the last 60 minutes, decide
 * whether the trailing 4 complete minutes are a cliff against the prior 55.
 * Returns null when there is no cliff, which is true both when volume is healthy
 * and when the baseline itself has collapsed (see isVolumeRecovered).
 */
export function detectCliff(
  perMinuteCounts: number[],  // length 60: index 0 = oldest minute, 59 = most recent
  lowPct = ALERT_THRESHOLD_PCT,
  minBaseline = MIN_BASELINE_PER_MIN
): { recentCount: number; baselinePerMin: number } | null {
  const a = analyzeVolume(perMinuteCounts, lowPct, minBaseline)
  if (!a || !a.hasBaseline) return null
  if (a.recentCount >= a.threshold) return null
  return { recentCount: a.recentCount, baselinePerMin: a.median }
}

/**
 * Evidence of a genuine volume recovery, as distinct from a workflow that simply
 * went quiet (#817).
 *
 * detectCliff returns null for BOTH a recovered workflow and one whose baseline
 * collapsed, so the all-clear cannot be decided on "no cliff" alone: a dead pipe
 * would then announce "back to normal". Recovery is judged on the RECENT window
 * carrying healthy volume (at least the minimum baseline rate per minute), NOT on
 * the baseline median: an outage of about half an hour or more fills most of the
 * 55 minute baseline window with its own low counts, so the median stays near
 * zero for up to that long after traffic is fully back, and keying recovery on it
 * would hold the all-clear for the whole time the outage takes to scroll out. The
 * recent window is the part the outage leaves first, so it is what says the pipe
 * is alive again. A recent window still near zero is a quiet pipe, not a
 * recovery, so the all-clear is held until the volume actually returns.
 *
 * The bar is minBaseline per minute, NOT a fraction of the workflow's own
 * baseline. That is deliberate: minBaseline is the very floor detectCliff
 * requires before it will judge a workflow at all, so a recent rate below it is
 * by this check's own definition too quiet to judge, which is the state the
 * all-clear must not call recovered. It is an absolute aliveness bar, so it does
 * not read the cliff percentage. What a workflow's rate was before a long outage
 * is unknowable from a trailing window and is not what this guards: the bug it
 * closes is the all-clear over a dead pipe, and a pipe back above the minimum
 * judgeable rate is not dead.
 *
 * The cost of an absolute bar is a band for a workflow whose baseline sits near
 * the minimum: once its recent rate climbs back over 25% of its own baseline,
 * detectCliff stops flagging a cliff, but the all-clear still waits until the
 * rate reaches the minimum judgeable level, so for such a workflow it can arrive
 * a little late. That is the safe direction (a late all-clear, never a false
 * one), and the alternative, a bar relative to the stored baseline, cannot
 * survive an outage long enough to fill the baseline window, which is the very
 * failure this is here to close.
 */
export function isVolumeRecovered(
  perMinuteCounts: number[],
  minBaseline = MIN_BASELINE_PER_MIN,
): boolean {
  // The recovery bar is a recent per-minute rate, which does not use the cliff
  // percentage, so analyzeVolume's threshold is irrelevant here: pass a 0 lowPct
  // and read only the recent count.
  const a = analyzeVolume(perMinuteCounts, 0, minBaseline)
  if (!a) return false
  return a.recentCount >= minBaseline * RECENT_WINDOW_MINUTES
}

// KvLike now needs delete(), for clearing the recovery marker (#253). The shared
// definition lives in alert-recovery so the three rate checks converge on one.
type KvLike = RecoveryKv

/**
 * Run the volume cliff check across all active workflows in orgs that have Slack connected.
 * Called from the Worker scheduled handler on the minute cron.
 */
export async function runVolumeCliffCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string,
  selfCheckUrl: string = DEFAULT_SELF_CHECK_URL,
  secretEncryptionKey: SecretKeyInput,
  // The claim that decides which of several simultaneous ticks posts (#1298).
  // Optional only so the pure detection tests need not build one; production
  // always passes it, and without it two ticks that pass the cooldown together
  // both post.
  claims?: AlertClaims,
): Promise<void> {
  const { data: slackOrgs, error: slackOrgsError } = await readSlackConnectionRowsForCopy(supabase)
  logReadFailure('volume-cliff', 'slack connections', slackOrgsError)
  if (slackOrgsError) {
    await reportDatabaseUnreachable(kv, secretEncryptionKey, 'slack connections', slackOrgsError, appUrl, claims)
    return
  }

  const connections = new Map<string, SlackConnection>()
  for (const row of slackOrgs ?? []) {
    const conn = parseSlackConnection((row as { config?: unknown }).config)
    if (conn) connections.set(row.organization_id as string, conn)
  }
  if (connections.size > 0) await rememberSlackConnections(kv, secretEncryptionKey, connections)

  const slackOrgIds = (slackOrgs ?? []).map((c) => c.organization_id as string)
  if (slackOrgIds.length === 0) return

  const { data: workflows, error: workflowsError } = await supabase
    .from('workflows')
    .select('id, name, organization_id, slack_channel')
    .in('organization_id', slackOrgIds)
    .eq('is_active', true)
    .is('deleted_at', null)
  logReadFailure('volume-cliff', 'workflows', workflowsError)
  if (workflowsError) {
    await reportDatabaseUnreachable(kv, secretEncryptionKey, 'workflows', workflowsError, appUrl, claims)
    return
  }

  if (!workflows?.length) return

  const now = Date.now()
  const workflowIds = workflows.map((w) => w.id as string)

  // 60 wall-clock-minute buckets ending with the current (partial) minute at
  // index 59. windowStart is minute-aligned so the DB's date_trunc('minute', …)
  // buckets map cleanly onto array indices.
  const nowMinuteMs = Math.floor(now / 60000) * 60000
  const windowStartMs = nowMinuteMs - 59 * 60000
  const windowStart = new Date(windowStartMs).toISOString()

  // Aggregate per-minute counts in the database rather than streaming raw rows
  // into the Worker. This collapses thousands of rows to ~60 per workflow and
  // sidesteps PostgREST's 1000-row page cap, which previously forced unordered
  // OFFSET pagination that silently dropped the newest rows (the trailing-5-min
  // window) and fired false cliff alerts.
  const { data: counts, error: countsError } = await supabase.rpc('execution_counts_per_minute', {
    p_workflow_ids: workflowIds,
    p_since: windowStart,
  })
  if (countsError) {
    console.error(`[volume-cliff] execution_counts_per_minute failed: ${countsError.message}`)
    await reportDatabaseUnreachable(kv, secretEncryptionKey, 'execution counts', countsError, appUrl, claims)
    return
  }

  // Every read succeeded, so if we paged that the database was unreachable, this
  // is the tick that can say it is over (the same re-arm rules as the cliff).
  for (const [orgId, conn] of connections) {
    const backoff = dbUnreachableBackoffKey(orgId)
    const recovered = await announceRecovery(kv, DB_UNREACHABLE_PREFIX, orgId, backoffCooldownKey(backoff), dbUnreachableIncident(orgId), async (alertedAt, endedAt) => {
      if (!conn.volume_alerts_enabled) return false
      return sendRecoveryAlert(conn, conn.default_channel, {
        signal: 'database unreachable', subject: 'Bidspoke', alertedAt, endedAt, url: `${appUrl}/dashboard`,
      })
    })
    // The all-clear settles the recovery markers and the backoff cooldown; also
    // reset the reminder schedule so the next outage starts at the short first
    // gap, not wherever this one had backed off to (#1337).
    if (recovered) await clearCondition(kv, backoff)
  }
  const rows = (counts ?? []) as { workflow_id: string; minute: string; cnt: number | string }[]
  console.log(`[volume-cliff] fetched ${rows.length} minute-buckets across ${workflows.length} workflows`)

  const perWorkflow = new Map<string, number[]>()
  for (const id of workflowIds) perWorkflow.set(id, new Array(60).fill(0))

  for (const row of rows) {
    const minuteIdx = Math.round((new Date(row.minute).getTime() - windowStartMs) / 60000)
    if (minuteIdx < 0 || minuteIdx >= 60) continue
    const bucket = perWorkflow.get(row.workflow_id)
    if (bucket) bucket[minuteIdx] = Number(row.cnt)
  }

  // Run the self-check at most once per cron tick, lazily — only if we're about
  // to fire at least one alert.
  let cachedSelfCheck: SelfCheckResult | null = null
  const getSelfCheck = async (): Promise<SelfCheckResult> => {
    if (cachedSelfCheck) return cachedSelfCheck
    cachedSelfCheck = await runSelfCheck(selfCheckUrl, supabase)
    return cachedSelfCheck
  }

  for (const wf of workflows) {
    const wfId = wf.id as string
    const bucket = perWorkflow.get(wfId)
    if (!bucket) continue

    const backoff = volumeCliffBackoffKey(wfId)
    const incident: IncidentContext = { scope: { kind: 'org', organizationId: wf.organization_id as string }, subjectLabel: wf.name as string }

    const cliff = detectCliff(bucket)
    if (!cliff) {
      // Healthy. If we paged for this workflow, say so and stand down (#253);
      // otherwise this is the ordinary quiet path and costs one KV read. But
      // "no cliff" is true both when volume returned and when the baseline itself
      // collapsed, so the all-clear requires evidence the volume actually came
      // back (#817): a workflow that went quiet must not read "back to normal".
      const recovered = await announceRecovery(
        kv,
        'volume-cliff',
        wfId,
        backoffCooldownKey(backoff),
        incident,
        async (alertedAt, endedAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id as string)
          if (!slack || !slack.volume_alerts_enabled) return false
          return sendRecoveryAlert(
            slack,
            (wf.slack_channel as string | null) ?? slack.default_channel,
            // Judges the trailing RECENT_WINDOW_MINUTES, so a one-tick cliff has a
            // zero span: name the window it measured, not a gap it did not (#1108).
            { signal: 'volume cliff', subject: wf.name as string, alertedAt, endedAt, measuredWindowMinutes: RECENT_WINDOW_MINUTES, url: `${appUrl}/workflows/${wfId}` },
          )
        },
        { hasEvidence: () => isVolumeRecovered(bucket) },
      )
      // Reset the reminder schedule once the cliff clears, so the next one starts
      // at the short first gap rather than the backed-off interval (#1337).
      if (recovered) await clearCondition(kv, backoff)
      continue
    }

    console.log(`[volume-cliff] detected workflow=${wf.name} workflow_id=${wfId} recent=${cliff.recentCount} baseline_per_min=${cliff.baselinePerMin}`)

    // Stamp the incident's running end on EVERY cliff tick, before the cooldown
    // gate, so the all-clear reports how long the cliff lasted rather than how
    // long ago we last spoke about it (#814). One clock reading per workflow,
    // so every record about the incident carries the same time.
    const nowMs = Date.now()
    await markSpikeSeen(kv, 'volume-cliff', wfId, nowMs)

    if (await inCooldown(kv, backoff)) {
      console.log(`[volume-cliff] suppressed by cooldown workflow_id=${wfId}`)
      continue
    }

    const slack = await getSlackConnection(supabase, wf.organization_id as string)
    if (!slack || !slack.volume_alerts_enabled) {
      console.log(`[volume-cliff] no Slack / opted-out org=${wf.organization_id} workflow_id=${wfId}`)
      continue
    }

    // Between the cooldown read and the post, ask the claim which tick posts
    // (#1298). Two ticks that reach here together both saw no cooldown key.
    const claimKey = `volume-cliff:${wfId}`
    if (claims && !(await claims.claim(claimKey, ALERT_CLAIM_TTL_SECONDS))) {
      console.log(`[volume-cliff] alert claimed by another tick workflow_id=${wfId}`)
      continue
    }

    const selfCheck = await getSelfCheck()

    // The reminder interval grows while the cliff stands (#1337); unchanged is
    // false because the recent count moves each tick, so a reminder says "same
    // problem, latest details shown" rather than claiming nothing changed.
    const standing = await readCondition(kv, backoff)
    const repeat = describeRepeat(standing, nowMs, false, VOLUME_CLIFF_STEPS) ?? undefined

    // Honor the per-workflow channel override, like every other alert path;
    // fall back to the org default (#110).
    const channel = (wf.slack_channel as string | null) ?? slack.default_channel
    const sent = await sendCliffAlert(slack, channel, {
      workflow_id: wfId,
      workflow_name: wf.name as string,
      organization_id: wf.organization_id as string,
      recent_count: cliff.recentCount,
      baseline_per_min: cliff.baselinePerMin,
    }, appUrl, selfCheck, repeat)

    // Only record the alert (which arms the next, longer cooldown) once it actually
    // delivered, so a kicked bot (Slack ok:false) does not suppress retries while
    // the outage goes unannounced.
    if (sent) {
      // Separate marker, longer TTL: a cliff lasting past the cooldown would
      // otherwise leave nothing to say it had ever been broken (#253). Written
      // before the cooldown (#2058): a cut or a refused write between them then
      // costs at worst a repeated page, never a lost all-clear.
      await markAlerted(kv, 'volume-cliff', wfId, incident, nowMs)
      await recordPaged(kv, 'volume-cliff', wfId, incident, nowMs)
      await recordAlert(kv, backoff, standing, nowMs, { stepsSeconds: VOLUME_CLIFF_STEPS, conditionTtlSeconds: VOLUME_CONDITION_TTL_SECONDS })
    } else if (claims) {
      // Slack refused: free the claim so the next tick can retry, the same way
      // the cooldown is only written on delivery.
      await claims.release(claimKey)
    }
  }
}

async function runSelfCheck(selfCheckUrl: string, supabase: SupabaseClient): Promise<SelfCheckResult> {
  const [worker, database] = await Promise.all([probeWorker(selfCheckUrl), probeDatabase(supabase)])
  return { ...worker, database }
}

async function probeWorker(selfCheckUrl: string): Promise<Omit<SelfCheckResult, 'database'>> {
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), SELF_CHECK_TIMEOUT_MS)
    const res = await fetch(selfCheckUrl, { method: 'GET', signal: ctrl.signal })
    clearTimeout(timeout)
    const latency = Date.now() - start
    const cfRay = res.headers.get('cf-ray')
    console.log(`[volume-cliff] self-check status=${res.status} latency=${latency}ms cf-ray=${cfRay} url=${selfCheckUrl}`)
    // Any HTTP response (including 4xx) proves the worker is reachable. Only
    // network/timeout errors below mean unreachable. 5xx is the one ambiguous
    // case: treat it as errored (worker up but failing).
    return { ok: res.status < 500, status: res.status, latency_ms: latency, error: null }
  } catch (e) {
    const latency = Date.now() - start
    const errName = e instanceof Error ? e.name : 'unknown'
    const errMsg = formatErr(e)
    console.error(`[volume-cliff] self-check FAILED type=${errName} message=${errMsg} latency=${latency}ms url=${selfCheckUrl}`)
    return { ok: false, status: null, latency_ms: latency, error: `${errName}: ${errMsg}` }
  }
}

// The cheapest read that proves the database answers: one row of a tiny table,
// under the same deadline as the worker probe (#1297).
async function probeDatabase(supabase: SupabaseClient): Promise<DatabaseProbeResult> {
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), SELF_CHECK_TIMEOUT_MS)
    const { error } = await probeSlackConnectionsTable(supabase, ctrl.signal)
    clearTimeout(timeout)
    const latency = Date.now() - start
    if (error) {
      console.error(`[volume-cliff] database probe FAILED latency=${latency}ms: ${error.message}`)
      return { ok: false, latency_ms: latency, error: error.message }
    }
    return { ok: true, latency_ms: latency, error: null }
  } catch (e) {
    const latency = Date.now() - start
    console.error(`[volume-cliff] database probe FAILED latency=${latency}ms: ${formatErr(e)}`)
    return { ok: false, latency_ms: latency, error: formatErr(e) }
  }
}

/**
 * The alert's diagnosis line says exactly what the two probes measured and no
 * more (#1297, L11). Before this it read a 4xx from the worker as proof the
 * caller had stopped sending, which on 2026-09-10 pointed everyone at the wrong
 * system for ten minutes.
 */
export function describeSelfCheck(selfCheck: SelfCheckResult): string {
  const worker = selfCheck.error
    ? `*Worker self-check FAILED:* ${selfCheck.error} after ${selfCheck.latency_ms}ms.`
    : selfCheck.ok
      ? `*Worker reachable* (HTTP ${selfCheck.status} in ${selfCheck.latency_ms}ms).`
      : `*Worker responded but errored* (HTTP ${selfCheck.status} in ${selfCheck.latency_ms}ms).`
  const db = selfCheck.database.ok
    ? `*Database readable* (${selfCheck.database.latency_ms}ms).`
    : `*Database read FAILED:* ${selfCheck.database.error} after ${selfCheck.database.latency_ms}ms.`
  const conclusion = selfCheck.error
    ? 'The worker may be unreachable. Investigate Cloudflare (DNS, route, TLS) first.'
    : !selfCheck.database.ok
      // Not "so it has been refusing leads": since #1845 a failed read serves a
      // stored copy, and this probe never measured whether a lead was refused (#835).
      ? 'The worker is up but its database read failed. Investigate Supabase first.'
      : !selfCheck.ok
        ? 'Investigate worker health.'
        : 'Both ends we control answer now. The missing runs either did not arrive or arrived while one of them was down; check the caller and any database alert above.'
  return `${worker} ${db} ${conclusion}`
}

// Returns the message ts on success, or null if the alert was not delivered
// (HTTP error or Slack ok:false) — the caller gates the cooldown on this.
export async function sendCliffAlert(
  slack: { bot_token: string },
  channel: string,
  cliff: CliffDetection,
  appUrl: string,
  selfCheck: SelfCheckResult,
  // The reminder sentence when the cliff has been standing across ticks (#1337).
  repeat?: string | null,
): Promise<string | null> {
  const expected = cliff.baseline_per_min * RECENT_WINDOW_MINUTES
  const ratePct = expected > 0 ? Math.round((cliff.recent_count / expected) * 100) : 0
  const workflowUrl = `${appUrl}/workflows/${cliff.workflow_id}`

  const checkLine = describeSelfCheck(selfCheck)

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Workflow Volume Cliff${repeat ? ' (still)' : ''}`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<!here> *${cliff.workflow_name}* received *${cliff.recent_count} executions in the last ${RECENT_WINDOW_MINUTES} minutes*. Only *${ratePct}% of expected* based on the prior hour's rate of ~${cliff.baseline_per_min}/min.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: checkLine } },
    ...(repeat ? [{ type: 'section', text: { type: 'mrkdwn', text: repeat } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `<${workflowUrl}|Open workflow →>` } },
  ]

  return postMessage(slack.bot_token, channel, blocks, `Workflow volume cliff: ${cliff.workflow_name}`)
}
