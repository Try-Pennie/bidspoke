/**
 * Paging a lead validation step that cannot read its configuration (#2589).
 *
 * A Constants key or env value a check reads that is missing is the workflow's
 * fault, the same on every lead: every lead reaching the step fails the run the
 * same way. Its per run page is suppressed (LeadValidationConfigFault carries
 * suppressAlert), so this is the one page: once per incident, keyed on the
 * workflow and the step, with an all clear once the step reads its
 * configuration whole again.
 *
 * Events arrive from the engine's run (ctx.reportLeadValidation), at the lead
 * rate, so the gates are ordered by cost, as the partner block reporter's are
 * (partner-block-alert.ts): the event line is always written; an open incident
 * is one KV read and, at most once a minute, the running end; only a fault with
 * no open incident asks the alert claim, so two isolates seeing it at once page
 * once, and then Slack. The incident record (opened, paged, ended) goes through
 * alert-recovery, under the registered signal `lead-validation-config`.
 *
 * A clean read costs one KV read of the incident marker, and an all clear is
 * held until the fault has not been seen for the re-arm window (30 minutes), as
 * every other all clear is, so a step that faults only on some runs does not
 * flap. Test runs and local dev log the event and touch nothing (#547).
 */
import type { AlertClaims } from './alert-claim'
import { releaseClaimQuietly } from './alert-claim'
import { activeKey, announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { sendLeadValidationConfigAlert, sendRecoveryAlert, type LeadValidationConfigAlertPayload } from './slack'
import { formatErr } from './format-error'
import type { LeadValidationEvent } from '../engine/nodes/lead-validation'

/** The incident record's signal. */
export const LEAD_VALIDATION_CONFIG_SIGNAL = 'lead-validation-config'
/** The words the all clear names the alert by, which the incident record's label repeats (L118). */
export const LEAD_VALIDATION_RECOVERY_WORDS = 'lead validation setting'
/**
 * How often an open incident's running end is written. Faults arrive at the
 * lead rate and KV takes one write a second per key, so the running end is
 * kept to the minute, well inside the 30 minute re-arm window it feeds.
 */
export const SIGHTING_REFRESH_MS = 60_000

/** The incident subject: the workflow id first, as a workflow keyed signal's must be, then the step. */
export function leadValidationSubject(workflowId: string, namespace: string): string {
  return `${workflowId}:${namespace}`
}

type SlackTarget = { bot_token: string; default_channel: string }

export interface LeadValidationAlertDeps {
  kv: RecoveryKv
  claims: AlertClaims | undefined
  /** The organization's Slack connection, or null when it has none. */
  resolveSlack: () => Promise<SlackTarget | null>
  sendPage?: (slack: SlackTarget, channel: string, payload: LeadValidationConfigAlertPayload) => Promise<boolean>
  sendAllClear?: typeof sendRecoveryAlert
  now?: () => number
  /** Test run or local dev: write the event line, touch nothing else. */
  silent: boolean
  appUrl: string
  log?: (line: string) => void
}

export interface LeadValidationRun {
  orgId: string
  workflowId: string
  workflowName: string
  slackChannel: string | null
}

export type LeadValidationAlertOutcome =
  | 'logged'
  | 'incident_open'
  | 'claimed_elsewhere'
  | 'no_slack'
  | 'post_failed'
  | 'paged'
  | 'nothing_due'
  | 'all_clear'

const pageClaimKey = (subject: string) => `${LEAD_VALIDATION_CONFIG_SIGNAL}:page:${subject}`
const allClearClaimKey = (subject: string) => `${LEAD_VALIDATION_CONFIG_SIGNAL}:all-clear:${subject}`

function eventLine(run: LeadValidationRun, event: LeadValidationEvent, silent: boolean): string {
  const faults = event.kind === 'config_fault'
    ? ` faults=${event.faults.map((f) => `${f.check_id ?? '-'}:${f.reference ?? '-'}:${f.problem}`).join(',')}`
    : ''
  return `[lead-validation] event=${event.kind} workflow=${run.workflowId} step=${event.namespace}${faults}${silent ? ' silent=true' : ''}`
}

export async function reportLeadValidationEvent(
  deps: LeadValidationAlertDeps,
  run: LeadValidationRun,
  event: LeadValidationEvent,
): Promise<LeadValidationAlertOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const now = deps.now ?? Date.now
  // A clean read is the common case and says nothing worth a line; a fault always does.
  if (event.kind === 'config_fault' || deps.silent) log(eventLine(run, event, deps.silent))
  if (deps.silent) return 'logged'

  const subject = leadValidationSubject(run.workflowId, event.namespace)
  const incident: IncidentContext = { scope: { kind: 'org', organizationId: run.orgId }, subjectLabel: `${run.workflowName}: ${event.namespace}` }

  if (event.kind === 'evaluated') {
    const nowMs = now()
    const cleared = await announceRecovery(
      deps.kv,
      LEAD_VALIDATION_CONFIG_SIGNAL,
      subject,
      null,
      incident,
      async (alertedAt, endedAt) => {
        const slack = await deps.resolveSlack()
        if (!slack) return false
        return (deps.sendAllClear ?? sendRecoveryAlert)(slack, run.slackChannel ?? slack.default_channel, {
          signal: LEAD_VALIDATION_RECOVERY_WORDS,
          subject: incident.subjectLabel ?? subject,
          alertedAt,
          endedAt,
          recoveredPhrase: 'reads every setting its checks need again',
          url: `${deps.appUrl}/workflows/${run.workflowId}`,
        })
      },
      { now: nowMs, claim: { claims: deps.claims, key: allClearClaimKey(subject), ttlSeconds: ALERT_CLAIM_TTL_SECONDS } },
    )
    return cleared ? 'all_clear' : 'nothing_due'
  }

  const nowMs = now()
  if ((await deps.kv.get(recoveryKey(LEAD_VALIDATION_CONFIG_SIGNAL, subject))) !== null) {
    // Open: keep its running end and its marker alive, at most once a minute.
    try {
      const last = await deps.kv.get(activeKey(LEAD_VALIDATION_CONFIG_SIGNAL, subject))
      const lastMs = last ? Date.parse(last) : NaN
      if (!Number.isFinite(lastMs) || nowMs - lastMs >= SIGHTING_REFRESH_MS) {
        await markSpikeSeen(deps.kv, LEAD_VALIDATION_CONFIG_SIGNAL, subject, nowMs)
        await refreshAlerted(deps.kv, LEAD_VALIDATION_CONFIG_SIGNAL, subject)
      }
    } catch (e) {
      // Two isolates refreshing in the same second can be refused by KV; the
      // next sighting writes it.
      log(`[lead-validation] running end not refreshed for ${subject}: ${formatErr(e)}`)
    }
    return 'incident_open'
  }

  if (deps.claims && !(await deps.claims.claim(pageClaimKey(subject), ALERT_CLAIM_TTL_SECONDS))) return 'claimed_elsewhere'
  const release = () => releaseClaimQuietly(deps.claims, pageClaimKey(subject))

  const slack = await deps.resolveSlack()
  if (!slack) {
    log(`[lead-validation] no Slack connection for org ${run.orgId}, so the setting fault on ${subject} was logged but not paged`)
    await release()
    return 'no_slack'
  }

  let delivered: boolean
  try {
    delivered = await (deps.sendPage ?? sendLeadValidationConfigAlert)(slack, run.slackChannel ?? slack.default_channel, {
      workflow_id: run.workflowId,
      workflow_name: run.workflowName,
      namespace: event.namespace,
      faults: event.faults,
      app_url: deps.appUrl,
    })
  } catch (e) {
    // A throw cannot say whether Slack took it, so the claim is kept for its TTL:
    // at worst the page is repeated once it lapses, never sent by every lead.
    log(`[lead-validation] page threw for ${subject}, keeping its claim: ${formatErr(e)}`)
    return 'post_failed'
  }
  if (!delivered) {
    await release()
    return 'post_failed'
  }

  // The marker before anything else (#2058): a cut after the page costs at worst a
  // repeated page once the claim lapses, never a lost all clear.
  await markAlerted(deps.kv, LEAD_VALIDATION_CONFIG_SIGNAL, subject, incident, nowMs)
  await recordPaged(deps.kv, LEAD_VALIDATION_CONFIG_SIGNAL, subject, incident, nowMs)
  await markSpikeSeen(deps.kv, LEAD_VALIDATION_CONFIG_SIGNAL, subject, nowMs)
  return 'paged'
}
