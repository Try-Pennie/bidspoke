/**
 * The page for an ops key reseal that keeps leaving logins on the old key, or
 * a switch left on after the reseal finished (#2486; L13, L523).
 *
 * WHERE IT COMES FROM. While OPS_RESEAL is set on the ops Worker during a
 * rotation of the ops key, the minute cron runs the reseal and keeps each run's
 * result in the ops database, and the minute tick judges how long the switch
 * has been on and what the runs last said (ops/reseal-watch.ts, which holds the
 * bounds and why: 2 hours either way). The tick's report carries the verdict;
 * recordOpsTickCompleted (ops-gateway.ts) keeps the report, and this reads it
 * on the bidding Worker, which the ops Worker's health cannot silence (L71).
 *
 * WHAT PAGES. Each paged verdict (OPS_RESEAL_PAGED_VERDICTS): logins_left,
 * preview_left_on, finished_left_on and switch_unknown, to every organization
 * with a Slack connection under its configuration alerts toggle, since the ops
 * key is the platform's, not one organization's. One platform incident, the
 * ops-key-reseal signal keyed on the ops key (incident-signals.ts); a change of
 * verdict is a new fact and posts at once (#1768), a repeat waits for the
 * shared reminder schedule, and the marker is armed only once a page reached
 * someone.
 *
 * THE ALL CLEAR. Sent on any other verdict once a page was delivered: the
 * switch removed (off), or a run that left nothing, or a fresh mode (running).
 * At once, with no re-arm wait: each verdict is a state the database holds,
 * not a sample that flaps, and a later relapse must wait out a whole bound
 * again before it pages. Its sentence names what cleared it
 * (opsKeyResealRecoveredPhrase). A report that is missing, older than
 * OPS_TICK_REPORT_FRESH_MS or unreadable, or a tick that could not judge
 * (no database, or the state read failed, which pages as the tick problem
 * reseal_state_failed), is UNJUDGED (L10, L11): no page, no all clear, the open
 * incident kept alive. A tick that stopped reporting is the ops-tick
 * heartbeat's to page.
 *
 * Never throws to the minute cron: every fault is in the summary's errors.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { announceRecovery, markAlerted, markSpikeSeen, pageTried, recordPageOutcome, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { backoffCooldownKey, clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'
import { minuteAllClearClaim, orgIdsToTell, postMinutePage, slackOrgIds } from './alert-fanout'
import type { AlertClaims } from './alert-claim'
import { formatErr } from './format-error'
import { OPS_RESEAL_PAGED_VERDICTS, parseOpsTickReport, type OpsResealReport } from './ops-gateway-contract'
import { OPS_TICK_REPORT_FRESH_MS, OPS_TICK_REPORT_KEY } from './ops-gateway'
import { opsKeyResealRecoveredPhrase, sendOpsKeyResealAlert, sendOpsKeyResealRecoveryAlert, type OpsKeyResealAlert } from './slack'

/** The incident record's signal (incident-signals.ts) and the prefix of its keys. */
export const OPS_KEY_RESEAL_SIGNAL = 'ops-key-reseal'
/** The incident's subject: the one ops key there is. */
export const OPS_KEY_RESEAL_SUBJECT = 'ops-key'
/** This check's minute job in the heartbeat registry, so a run that stops is paged as itself. Never rename it: it keys its KV state. */
export const OPS_KEY_RESEAL_JOB = 'ops-key-reseal'

const CONDITION_KEY = `${OPS_KEY_RESEAL_SIGNAL}:${OPS_KEY_RESEAL_SUBJECT}`

export type KeptReseal = { judged: true; report: OpsResealReport } | { judged: false; why: string }

/**
 * The verdict in the tick's last kept report, or why there is none to act on.
 * Never throws, and never answers off for a report it could not read.
 */
export async function readKeptReseal(kv: Pick<RecoveryKv, 'get'>, nowMs: number): Promise<KeptReseal> {
  let raw: string | null
  try {
    raw = await kv.get(OPS_TICK_REPORT_KEY)
  } catch (err) {
    return { judged: false, why: `the tick's report could not be read (${formatErr(err)})` }
  }
  if (raw === null) return { judged: false, why: 'there is no report from the ops tick' }
  let receivedMs: number
  let reseal: OpsResealReport | null
  try {
    const parsed: unknown = JSON.parse(raw)
    receivedMs = Date.parse(String((parsed as { received_at?: unknown } | null)?.received_at))
    if (!Number.isFinite(receivedMs)) throw new Error('it has no time it was received')
    reseal = parseOpsTickReport(parsed).reseal
  } catch (err) {
    return { judged: false, why: `the tick's report could not be read (${formatErr(err)})` }
  }
  if (nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return { judged: false, why: `the tick's report is ${Math.floor((nowMs - receivedMs) / 60_000)} minutes old` }
  if (reseal === null) return { judged: false, why: 'the tick did not judge the reseal' }
  return { judged: true, report: reseal }
}

export interface OpsKeyResealDeps {
  kv: RecoveryKv
  readReseal(): Promise<KeptReseal>
  /** The organizations to tell, or null when the list could not be read. */
  orgsToTell(): Promise<string[] | null>
  /** Pages one organization. Returns whether it reached Slack. */
  sendAlert(orgId: string, alert: OpsKeyResealAlert): Promise<boolean>
  /** The all clear to one organization. Returns whether it reached Slack. */
  sendRecovery(orgId: string, recovery: { phrase: string; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
  claims?: AlertClaims
  now(): number
}

export interface OpsKeyResealSummary {
  judged: boolean
  why?: string
  verdict?: OpsResealReport['verdict']
  paged: boolean
  allClear: boolean
  /** Faults in the check's own delivery or bookkeeping, reported rather than thrown. */
  errors: string[]
}

const incident = (errors: string[]): IncidentContext => ({
  scope: { kind: 'platform' },
  subjectLabel: 'Ops key reseal',
  onRecordError: (message) => errors.push(message),
})

const isPaged = (report: OpsResealReport) => (OPS_RESEAL_PAGED_VERDICTS as readonly string[]).includes(report.verdict)

/** Sends to every organization to tell, each its own boundary. True when any was told. */
async function fanOut(deps: OpsKeyResealDeps, what: string, send: (orgId: string) => Promise<boolean>, errors: string[]): Promise<boolean> {
  const orgs = await deps.orgsToTell()
  if (orgs === null) {
    errors.push(`the ${what} told nobody: the Slack organizations could not be read`)
    return false
  }
  let any = false
  for (const orgId of orgs) {
    try {
      if (await send(orgId)) any = true
    } catch (err) {
      errors.push(`the ${what} to org ${orgId} failed, the others go on: ${formatErr(err)}`)
    }
  }
  return any
}

async function page(deps: OpsKeyResealDeps, report: OpsResealReport, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  await markSpikeSeen(kv, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT, nowMs)
  const marker = await kv.get(recoveryKey(OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT))
  const standing = await readCondition(kv, CONDITION_KEY)
  // The verdict is the problem: a change of verdict is a new one and posts at once (#1768).
  const print = await fingerprintAlert({ title: OPS_KEY_RESEAL_SIGNAL, findings: [report.verdict], keys: [report.verdict] })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const repeat = reminderOf ? describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined : undefined
  const posted = await postMinutePage({
    claims: deps.claims,
    key: CONDITION_KEY,
    inCooldown: async () => !different && (await inCooldown(kv, CONDITION_KEY)),
    send: () => fanOut(deps, 'page', (orgId) => deps.sendAlert(orgId, { report, ...(repeat ? { repeat } : {}) }), errors),
  })
  const delivered = posted === 'sent'
  if (delivered) {
    await recordAlert(kv, CONDITION_KEY, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
    await markAlerted(kv, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT, incident(errors), nowMs)
  }
  // Delivered or not, a page this run tried is recorded (#3056).
  if (pageTried(posted)) await recordPageOutcome(kv, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT, incident(errors), nowMs, delivered)
  if (!delivered) {
    // Armed only on delivery, so a Slack outage does not buy silence, and an all clear never follows an unseen page.
    if (marker !== null) await refreshAlerted(kv, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT)
    return false
  }
  return true
}

async function clear(deps: OpsKeyResealDeps, report: OpsResealReport, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  if ((await kv.get(recoveryKey(OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT))) === null) {
    // Never paged (no page was delivered), or already settled: nothing is owed.
    await clearCondition(kv, CONDITION_KEY)
    return false
  }
  const phrase = opsKeyResealRecoveredPhrase(report)
  const delivered = await announceRecovery(
    kv,
    OPS_KEY_RESEAL_SIGNAL,
    OPS_KEY_RESEAL_SUBJECT,
    backoffCooldownKey(CONDITION_KEY),
    incident(errors),
    (alertedAt, endedAt, firstHealthyAt) => fanOut(deps, 'all clear', (orgId) => deps.sendRecovery(orgId, { phrase, alertedAt, endedAt, firstHealthyAt }), errors),
    { now: nowMs, rearmMinutes: 0, claim: minuteAllClearClaim(deps.claims, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT) },
  )
  if (delivered) await clearCondition(kv, CONDITION_KEY)
  return delivered
}

/** The minute check: page a paged verdict, stand an open page down on any other, keep it on none. Never throws. */
export async function runOpsKeyResealCheck(deps: OpsKeyResealDeps): Promise<OpsKeyResealSummary> {
  const nowMs = deps.now()
  const errors: string[] = []
  const summary: OpsKeyResealSummary = { judged: false, paged: false, allClear: false, errors }
  try {
    const read = await deps.readReseal()
    if (!read.judged) {
      summary.why = read.why
      await refreshAlerted(deps.kv, OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT)
      return summary
    }
    summary.judged = true
    summary.verdict = read.report.verdict
    if (isPaged(read.report)) summary.paged = await page(deps, read.report, nowMs, errors)
    else summary.allClear = await clear(deps, read.report, nowMs, errors)
  } catch (err) {
    errors.push(`the check failed: ${formatErr(err)}`)
  }
  return summary
}

/** The minute check wired to the bidding Worker: the kept report in KV, the Slack organizations, Slack. */
export function runOpsKeyResealCheckForEnv(supabase: SupabaseClient, kv: KVNamespace, claims?: AlertClaims): Promise<OpsKeyResealSummary> {
  return runOpsKeyResealCheck({
    kv,
    readReseal: () => readKeptReseal(kv, Date.now()),
    orgsToTell: async () => {
      const list = await slackOrgIds(supabase, OPS_KEY_RESEAL_JOB, 'tell-only')
      return list.kind === 'unreachable' ? null : orgIdsToTell(list)
    },
    sendAlert: (orgId, alert) => sendOpsKeyResealAlert(supabase, orgId, alert),
    sendRecovery: (orgId, recovery) => sendOpsKeyResealRecoveryAlert(supabase, orgId, recovery),
    claims,
    now: () => Date.now(),
  })
}
