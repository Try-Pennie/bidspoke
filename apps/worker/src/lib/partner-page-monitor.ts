/**
 * The partners page delivery monitor (#2135, PR4 of #2114; decision 2, Dan,
 * 2026-10-15: a Worker check on the existing five minute cron, signing in as a
 * monitor user of a synthetic organization, with one new Worker secret).
 *
 * Every five minutes it does what a person's page does: signs in, joins the
 * private topic partners:<monitor organization>, and waits for a notice. The
 * notice is sent by monitor_partner_page_ping through notify_partner_page, the
 * same sender every page table trigger calls, so a working ping proves the
 * sender, the policy, Realtime and the join; that the triggers call the sender
 * is proved by the pg_trigger guard in supabase/tests/partner_page_notice.test.sql,
 * not here. A row in realtime.messages is not delivery: only receipt counts.
 *
 * What pages (the only thing that pages at launch, L36):
 *  - `channel`: the monitor's own notice did not arrive within
 *    RECEIPT_DEADLINE_MS of its first ping (re-sent every PING_RETRY_MS, since
 *    Realtime starting up can lose the first, ADR 0012), or the join was
 *    refused. That is a broken channel for
 *    every organization, not a threshold judgement, so it pages on the run that
 *    sees it.
 *  - `monitor`: the check could not run (no secret, no monitor organization,
 *    sign in or the ping failing) for UNMEASURED_ALERT_AFTER_MS on the clock, so
 *    a dead check is never silence (L557, L98). It never counts as a working
 *    channel: a standing channel incident gets no all-clear from it.
 *
 * What is recorded and never pages: each run's outcome, receipt latency, and
 * whether today's and tomorrow's realtime.messages partitions exist, in
 * job_runs (job PARTNER_PAGE_MONITOR_JOB), so pass and fail counts exist. A day
 * can start with no partition (ADR 0012): a join refused as MissingPartition is
 * retried, and a send made while today's partition was absent is recorded as
 * `partition_missing_at_send`, never as a failure. The live misses pages post
 * are in partner_page_live_misses. No miss threshold ships: the issue that sets
 * one from a measured week is filed with #2135 (L65).
 */
import { parsePartnerPageNotice, partnerPageTopic } from '@bidspoke/partner-page-live'
import type { AlertClaims } from './alert-claim'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { backoffCooldownKey, clearCondition, type BackoffKv } from './alert-backoff'
import { keepAlerted, markSpikeSeen, recordPaged, recoveryDue, recoveryKey, settleRecovery, RECOVERY_REARM_MINUTES, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { deliverAll, postStanding, type SlackTarget } from './standing-alert'
import type { sendGroupedRecoveryAlert, sendPartnerPageLiveAlert } from './slack'
import { formatErr } from './format-error'

const MIN = 60 * 1000

/** The heartbeat and job_runs id of this check. */
export const PARTNER_PAGE_MONITOR_JOB = 'partner-page-monitor'
/** The alert key for a broken channel. Mute it by writing `partner-page-live:cooldown` with a TTL. */
export const PARTNER_PAGE_LIVE_KEY = 'partner-page-live'
/** The alert key for a check that cannot run, muted on its own. */
export const PARTNER_PAGE_MONITOR_UNMEASURED_KEY = 'partner-page-live-unmeasured'
export const PARTNER_PAGE_MONITOR_STATE_KEY = 'partner-page-monitor:state'
const RECOVERY_PREFIX = 'partner-page-live'
const CHANNEL_ID = 'channel'
const MONITOR_ID = 'monitor'

/** How long a sent notice may take to arrive. The live run measured a 114 ms worst case of 20 (ADR 0012). */
export const RECEIPT_DEADLINE_MS = 10_000
/**
 * How often the ping is sent again, with the same save id, while its notice has
 * not arrived and the deadline has not passed. Realtime woken from an idle
 * shutdown answers a private join SUBSCRIBED before it streams database
 * broadcasts, so a notice sent within about a second of that join is lost
 * (2026-10-16 01:45 UTC, ADR 0012); the next ping is not.
 */
export const PING_RETRY_MS = 2_500
/** Joins tried when Realtime refuses one for a missing partition. */
export const JOIN_ATTEMPTS = 3
/** The wait between those joins: the live run saw the partition 0 ms after the first refusal. */
export const JOIN_RETRY_MS = 3_000
/** A check that cannot run for this long, on the clock, pages. */
export const UNMEASURED_ALERT_AFTER_MS = 30 * MIN
/** A standing record is re-armed on every run, so this only bounds one left behind. */
const CONDITION_TTL_SECONDS = 25 * 60 * 60

export type IdentityAnswer =
  | { kind: 'found'; organizationId: string; email: string }
  | { kind: 'missing' | 'ambiguous' | 'unreadable'; reason: string }

export type JoinAnswer = { ok: true; leave: () => Promise<void> } | { ok: false; reason: string; missingPartition: boolean }

export type Outcome =
  | { kind: 'received'; latencyMs: number; partitionToday: boolean; partitionTomorrow: boolean; joinAttempts: number; pings: number }
  | { kind: 'not_received'; partitionToday: boolean; partitionTomorrow: boolean; joinAttempts: number; pings: number }
  | { kind: 'join_refused'; reason: string; joinAttempts: number }
  | { kind: 'partition_missing_at_send'; partitionTomorrow: boolean; joinAttempts: number }
  | { kind: 'unmeasured'; reason: string }

export interface MeasureDeps {
  /** PARTNER_PAGE_MONITOR_PASSWORD. Never logged. */
  password: string | undefined
  findIdentity: () => Promise<IdentityAnswer>
  signIn: (email: string, password: string) => Promise<{ ok: true; jwt: string; signOut: () => Promise<void> } | { ok: false; reason: string }>
  join: (jwt: string, topic: string, onPayload: (payload: unknown) => void) => Promise<JoinAnswer>
  ping: (organizationId: string, saveId: string) => Promise<{ ok: true; partitionToday: boolean; partitionTomorrow: boolean } | { ok: false; reason: string }>
  newSaveId: () => string
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

/** One end to end measurement. Never throws for a remote failure: each is an outcome. */
export async function measurePartnerPageDelivery(deps: MeasureDeps): Promise<Outcome> {
  if (!deps.password) return { kind: 'unmeasured', reason: 'PARTNER_PAGE_MONITOR_PASSWORD is not set on the worker' }
  const identity = await deps.findIdentity()
  if (identity.kind !== 'found') return { kind: 'unmeasured', reason: identity.reason }

  const session = await deps.signIn(identity.email, deps.password)
  if (!session.ok) return { kind: 'unmeasured', reason: `the monitor user could not sign in: ${session.reason}` }

  const saveId = deps.newSaveId()
  let receivedAt: number | null = null
  let resolveReceipt: () => void = () => {}
  const receipt = new Promise<void>((resolve) => { resolveReceipt = resolve })
  const onPayload = (payload: unknown) => {
    const notice = parsePartnerPageNotice(payload)
    if (notice?.kind === 'monitor' && notice.saveId === saveId && receivedAt === null) {
      receivedAt = deps.now()
      resolveReceipt()
    }
  }

  let leave: (() => Promise<void>) | null = null
  try {
    let attempts = 0
    for (;;) {
      attempts += 1
      const joined = await deps.join(session.jwt, partnerPageTopic(identity.organizationId), onPayload)
      if (joined.ok) {
        leave = joined.leave
        break
      }
      // The day's partition can be made by the first refused join (ADR 0012), so a
      // refusal for it is tried again. Every attempt refused means no page can
      // join either: the channel is broken.
      if (joined.missingPartition && attempts < JOIN_ATTEMPTS) {
        deps.log(`[partner-page-monitor] join refused for a missing partition, attempt ${attempts} of ${JOIN_ATTEMPTS}`)
        await deps.sleep(JOIN_RETRY_MS)
        continue
      }
      return { kind: 'join_refused', reason: joined.reason, joinAttempts: attempts }
    }

    const sentAt = deps.now()
    const ping = await deps.ping(identity.organizationId, saveId)
    if (!ping.ok) return { kind: 'unmeasured', reason: `the ping could not be sent: ${ping.reason}` }
    if (!ping.partitionToday) {
      // realtime.send stores nothing into a day with no partition and raises only a
      // WARNING; nobody can be subscribed then either, so this is not a miss.
      return { kind: 'partition_missing_at_send', partitionTomorrow: ping.partitionTomorrow, joinAttempts: attempts }
    }
    // Waits on the notice, never a fixed time after the join (L290): every
    // PING_RETRY_MS without it the same ping is sent again, so a notice lost to
    // Realtime starting up is followed by one it streams. Any of them counts,
    // latency is from the first send, and the partition figures are the first
    // ping's. `pings` counts the sends the database accepted, so a startup race
    // stays countable in job_runs.
    const deadline = sentAt + RECEIPT_DEADLINE_MS
    let pings = 1
    for (;;) {
      const remaining = deadline - deps.now()
      if (remaining <= 0) break
      await Promise.race([receipt, deps.sleep(Math.min(PING_RETRY_MS, remaining))])
      if (receivedAt !== null || deps.now() >= deadline) break
      const again = await deps.ping(identity.organizationId, saveId)
      if (again.ok) pings += 1
      else deps.log(`[partner-page-monitor] re-ping could not be sent: ${again.reason}`)
    }
    if (receivedAt !== null) {
      return { kind: 'received', latencyMs: receivedAt - sentAt, partitionToday: true, partitionTomorrow: ping.partitionTomorrow, joinAttempts: attempts, pings }
    }
    return { kind: 'not_received', partitionToday: true, partitionTomorrow: ping.partitionTomorrow, joinAttempts: attempts, pings }
  } finally {
    // Closed whatever happened, and a failure to close is logged, never thrown
    // over the outcome.
    if (leave) await leave().catch((e: unknown) => deps.log(`[partner-page-monitor] leaving the channel failed: ${formatErr(e)}`))
    await session.signOut().catch((e: unknown) => deps.log(`[partner-page-monitor] signing out failed: ${formatErr(e)}`))
  }
}

// ── Judging and alerting ─────────────────────────────────────────────────────

interface MonitorState {
  /** ISO time the check began failing to run; present only while it is. */
  unmeasuredSince?: string
}

export interface MonitorDeps {
  kv: BackoffKv & RecoveryKv
  claims: AlertClaims | undefined
  env: Record<string, string | undefined>
  measure: () => Promise<Outcome>
  /** The job_runs record of this run. Never throws (job-run-record.ts). */
  record: (outcome: Outcome['kind'], summary: Record<string, unknown>) => Promise<void>
  resolveSlack: () => Promise<SlackTarget[]>
  senders: {
    live: typeof sendPartnerPageLiveAlert
    recovery: typeof sendGroupedRecoveryAlert
  }
  now: () => number
  log: (line: string) => void
}

export interface MonitorSummary {
  mode: 'alert' | 'silent'
  outcome: Outcome['kind'] | null
  alerts: string[]
  allClears: string[]
  errors: string[]
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The figures recorded for one outcome, snake case as job_runs.summary holds them. */
function summaryOf(o: Outcome): Record<string, unknown> {
  switch (o.kind) {
    case 'received':
      return { latency_ms: o.latencyMs, partition_today: o.partitionToday, partition_tomorrow: o.partitionTomorrow, join_attempts: o.joinAttempts, pings: o.pings }
    case 'not_received':
      return { partition_today: o.partitionToday, partition_tomorrow: o.partitionTomorrow, join_attempts: o.joinAttempts, pings: o.pings, deadline_ms: RECEIPT_DEADLINE_MS }
    case 'join_refused':
      return { reason: o.reason, join_attempts: o.joinAttempts }
    case 'partition_missing_at_send':
      return { partition_today: false, partition_tomorrow: o.partitionTomorrow, join_attempts: o.joinAttempts }
    case 'unmeasured':
      return { reason: o.reason }
  }
}

/** One run: measure, record, then page or stand down. Never throws. */
export async function runPartnerPageMonitor(deps: MonitorDeps): Promise<MonitorSummary> {
  const mode: MonitorSummary['mode'] = deps.env.LOCAL_DEV ? 'silent' : 'alert'
  const summary: MonitorSummary = { mode, outcome: null, alerts: [], allClears: [], errors: [] }
  // Local dev shares the production database and Realtime: it neither signs in
  // as the monitor nor sends, as the other cron checks write nothing locally.
  if (mode === 'silent') {
    deps.log('[partner-page-monitor] event=partner_page_monitor mode=silent (LOCAL_DEV)')
    return summary
  }

  let outcome: Outcome
  try {
    outcome = await deps.measure()
  } catch (e) {
    outcome = { kind: 'unmeasured', reason: `the check threw: ${formatErr(e)}` }
  }
  summary.outcome = outcome.kind
  const figures = summaryOf(outcome)
  deps.log(`[partner-page-monitor] event=partner_page_monitor outcome=${outcome.kind} ${Object.entries(figures).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`)
  await deps.record(outcome.kind, figures)

  const nowMs = deps.now()
  let state: MonitorState = {}
  try {
    const raw = await deps.kv.get(PARTNER_PAGE_MONITOR_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MonitorState
      if (parsed.unmeasuredSince === undefined || Number.isFinite(Date.parse(parsed.unmeasuredSince))) state = parsed
    }
  } catch (e) {
    summary.errors.push(`state unreadable: ${formatErr(e)}`)
  }

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
  // The channel is every organization's, so its incidents are the platform's.
  const incident = (id: string): IncidentContext => ({
    scope: { kind: 'platform' },
    subjectLabel: id === CHANNEL_ID ? 'The partners page channel' : 'The partners page delivery check',
    onRecordError: (message) => summary.errors.push(`incident record: ${message}`),
  })
  const keepIfAlerted = async (id: string, posted: boolean, since: string) => {
    if (posted || (await deps.kv.get(recoveryKey(RECOVERY_PREFIX, id))) !== null) await keepAlerted(deps.kv, RECOVERY_PREFIX, id, since, incident(id), nowMs)
    if (posted) await recordPaged(deps.kv, RECOVERY_PREFIX, id, incident(id), nowMs)
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
    await settleRecovery(deps.kv, RECOVERY_PREFIX, id, backoffCooldownKey(key), { ...incident(id), reason: 'all_clear' }, nowMs)
    await clearCondition(deps.kv, key)
    summary.allClears.push(id)
  }
  const saveState = async (next: MonitorState) => {
    try {
      await deps.kv.put(PARTNER_PAGE_MONITOR_STATE_KEY, JSON.stringify(next))
    } catch (e) {
      summary.errors.push(`state write failed: ${formatErr(e)}`)
    }
  }

  if (outcome.kind === 'partition_missing_at_send') {
    // Not judged: no clock moves, nothing is paged, nothing stands down.
    return summary
  }

  if (outcome.kind === 'unmeasured') {
    const since = state.unmeasuredSince ?? iso(nowMs)
    await saveState({ unmeasuredSince: since })
    // Unmeasured is not clear: both incidents' running ends move, so a run of
    // failed checks never counts toward either all-clear.
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, MONITOR_ID, nowMs)
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, CHANNEL_ID, nowMs)
    if (nowMs - Date.parse(since) >= UNMEASURED_ALERT_AFTER_MS) {
      const posted = await postStanding({
        kv: deps.kv, key: PARTNER_PAGE_MONITOR_UNMEASURED_KEY, claim, release, targets, nowMs,
        alert: { problem: 'monitor-cannot-run', details: [outcome.reason] },
        conditionTtlSeconds: CONDITION_TTL_SECONDS, logPrefix: '[partner-page-monitor]', log: deps.log,
        send: (s, repeat) => deps.senders.live(s, s.default_channel, { problem: 'monitor', reason: outcome.reason, since, repeat, at: nowMs }),
      })
      if (posted) summary.alerts.push(MONITOR_ID)
      await keepIfAlerted(MONITOR_ID, posted, since)
    }
    return summary
  }

  // The check ran: it stands down its own incident.
  if (state.unmeasuredSince !== undefined) await saveState({})
  await allClear(MONITOR_ID, PARTNER_PAGE_MONITOR_UNMEASURED_KEY, 'The partners page delivery check', 'partners page delivery check',
    `has run for ${RECOVERY_REARM_MINUTES} minutes`)

  if (outcome.kind === 'not_received' || outcome.kind === 'join_refused') {
    const reason = outcome.kind === 'join_refused'
      ? `the monitor could not join the channel: ${outcome.reason}`
      : `no notice arrived within ${RECEIPT_DEADLINE_MS / 1000} seconds of the first ping, after ${outcome.pings} ${outcome.pings === 1 ? 'ping' : 'pings'}`
    await markSpikeSeen(deps.kv, RECOVERY_PREFIX, CHANNEL_ID, nowMs)
    const since = (await deps.kv.get(recoveryKey(RECOVERY_PREFIX, CHANNEL_ID))) ?? iso(nowMs)
    const posted = await postStanding({
      kv: deps.kv, key: PARTNER_PAGE_LIVE_KEY, claim, release, targets, nowMs,
      alert: { problem: `channel-${outcome.kind}`, details: [reason] },
      conditionTtlSeconds: CONDITION_TTL_SECONDS, logPrefix: '[partner-page-monitor]', log: deps.log,
      send: (s, repeat) => deps.senders.live(s, s.default_channel, { problem: 'channel', reason, since, repeat, at: nowMs }),
    })
    if (posted) summary.alerts.push(CHANNEL_ID)
    await keepIfAlerted(CHANNEL_ID, posted, since)
    return summary
  }

  await allClear(CHANNEL_ID, PARTNER_PAGE_LIVE_KEY, 'The partners page channel', 'partners page live updates',
    `has delivered the delivery check's notice for ${RECOVERY_REARM_MINUTES} minutes`)
  return summary
}
