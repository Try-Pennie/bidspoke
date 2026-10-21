/**
 * The daily check that the Salesforce bulkhead limit is still the one the ops
 * Salesforce lane was sized against (#2336, phase 6 of #1689, item 5).
 *
 * WHY. Money's BulkheadObject is untouched by the ops lane, so ops cannot see
 * money's live use of Salesforce. The protection is a fixed partition: the ops
 * pool's cap plus money's measured peak must fit the org's limit, and Dan's
 * lane decision (decision 11, 2026-10-19, recorded on #2336) set that cap with
 * the bidding Worker's bulkhead at 20. SALESFORCE_BULKHEAD_LIMIT can raise it
 * with no deploy (bulkhead-client.ts salesforceBulkheadLimit), and nothing on
 * the ops side would notice, so this pages, every day while it stands, when the
 * value bidding resolves differs from OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT. A
 * lower value pages too: the cap was sized against 20, and it is the
 * difference that must be re-checked, not only the direction.
 *
 * WHAT IT JUDGES. The value salesforceBulkheadLimit(env) resolves to, which is
 * what every Salesforce call on the bidding Worker takes, never the raw setting:
 * an unset or unreadable SALESFORCE_BULKHEAD_LIMIT resolves to the default, and
 * that is the limit that runs.
 *
 * WHO IS TOLD. Every organization with a Slack connection, under its
 * configuration alerts toggle: the setting is the Worker's, shared by every
 * organization's leads, so the incident is the platform's
 * (incident-signals.ts `salesforce-bulkhead-limit`). Its marker is armed only
 * once a page has reached someone, and the all clear is sent once the limit
 * matches again. An organization list that cannot be read is logged as
 * nobody could be told, never read as quiet; the open incident is kept.
 *
 * Who may run it: the bidding Worker's daily cron only. Whose data: none; it
 * reads one Worker setting and posts to each organization's own channel.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { salesforceBulkheadLimit } from './bulkhead-client'
import { formatErr } from './format-error'
import { sendSalesforceBulkheadLimitAlert, sendSalesforceBulkheadLimitRecoveryAlert, type SalesforceBulkheadLimitAlert } from './slack'
import type { Env } from '../index'

/**
 * The bidding Worker's Salesforce bulkhead limit that Dan's ops Salesforce lane
 * decision was sized against. #2336's scope (2026-10-17) has the cap proposal
 * record "the bulkhead limit value it was sized against", the bulkhead's 20;
 * Dan's answers on decision 11 (2026-10-19, on #2336) then set the trypennie
 * org cap to 3 and the workflow share to 2, from the Phase 0 measurement of
 * the org's limit of 25 long requests at once and bidding's peak of 12, taken
 * while this bulkhead was at 20. Change it only after the ops cap has been
 * re-checked against the new value.
 */
export const OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT = 20

/** The job's id in the heartbeat registry. Never rename it: it keys its KV state. */
export const SALESFORCE_BULKHEAD_CHECK_JOB = 'salesforce-bulkhead-check'

/** The incident record's signal (incident-signals.ts). */
export const SALESFORCE_BULKHEAD_SIGNAL = 'salesforce-bulkhead-limit'

/** The incident's subject: the bulkhead's own key, the one Salesforce bulkhead there is. */
export const SALESFORCE_BULKHEAD_SUBJECT = 'salesforce'

const LOG = `[${SALESFORCE_BULKHEAD_CHECK_JOB}]`

export interface SalesforceBulkheadCheckDeps {
  kv: RecoveryKv
  /** What salesforceBulkheadLimit resolves to on this Worker. */
  resolvedLimit(): number
  /** The organizations to tell, or null when the list could not be read. */
  orgsToTell(): Promise<string[] | null>
  /** Pages one organization. Returns whether it reached Slack. */
  sendAlert(orgId: string, alert: SalesforceBulkheadLimitAlert): Promise<boolean>
  /** The all clear to one organization. Returns whether it reached Slack. */
  sendRecovery(orgId: string, recovery: { sizedFor: number; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
  now(): number
}

export interface SalesforceBulkheadCheckSummary {
  limit: number
  sizedFor: number
  verdict: 'matches' | 'differs'
  /** Organizations the page reached. */
  paged: number
  /** True when the organization list could not be read, so nobody was told. */
  toldNobody: boolean
  allClear: boolean
  /** Faults in the check's own bookkeeping, logged rather than thrown. */
  errors: string[]
}

const incident = (errors: string[]): IncidentContext => ({
  scope: { kind: 'platform' },
  subjectLabel: 'Salesforce bulkhead limit',
  onRecordError: (message) => errors.push(message),
})

export async function runSalesforceBulkheadCheck(deps: SalesforceBulkheadCheckDeps): Promise<SalesforceBulkheadCheckSummary> {
  const nowMs = deps.now()
  const limit = deps.resolvedLimit()
  const sizedFor = OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT
  const errors: string[] = []
  const summary: SalesforceBulkheadCheckSummary = { limit, sizedFor, verdict: limit === sizedFor ? 'matches' : 'differs', paged: 0, toldNobody: false, allClear: false, errors }
  const { kv } = deps

  if (summary.verdict === 'matches') {
    summary.allClear = await announceRecovery(
      kv,
      SALESFORCE_BULKHEAD_SIGNAL,
      SALESFORCE_BULKHEAD_SUBJECT,
      null,
      incident(errors),
      async (alertedAt, endedAt, firstHealthyAt) => {
        const orgs = await deps.orgsToTell()
        if (orgs === null) {
          console.error(`${LOG} the limit matches ${sizedFor} again, but nobody could be told: the Slack organizations could not be read, so the all clear is tried tomorrow`)
          return false
        }
        let any = false
        for (const orgId of orgs) {
          try {
            if (await deps.sendRecovery(orgId, { sizedFor, alertedAt, endedAt, firstHealthyAt })) any = true
          } catch (err) {
            console.error(`${LOG} the all clear to org ${orgId} failed, the others go on: ${formatErr(err)}`)
          }
        }
        return any
      },
      { now: nowMs },
    )
    return summary
  }

  // The condition stands: its running end moves on every day it is seen.
  await markSpikeSeen(kv, SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT, nowMs)
  const firstReportedAt = await kv.get(recoveryKey(SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT))
  const orgs = await deps.orgsToTell()
  if (orgs === null) {
    summary.toldNobody = true
    console.error(`${LOG} the Salesforce bulkhead limit resolves to ${limit}, not the ${sizedFor} the ops lane was sized for, and nobody could be told: the Slack organizations could not be read`)
    await refreshAlerted(kv, SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT)
    return summary
  }
  for (const orgId of orgs) {
    try {
      if (await deps.sendAlert(orgId, { limit, sizedFor, firstReportedAt })) summary.paged++
    } catch (err) {
      console.error(`${LOG} the page to org ${orgId} failed, the others go on: ${formatErr(err)}`)
    }
  }
  if (summary.paged === 0) {
    console.error(`${LOG} the Salesforce bulkhead limit resolves to ${limit}, not ${sizedFor}, and the page reached no organization`)
    // Armed only on delivery, so an all clear never follows an unseen page.
    if (firstReportedAt !== null) await refreshAlerted(kv, SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT)
    return summary
  }
  // One delivered round is one page, however many organizations it reached.
  await markAlerted(kv, SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT, incident(errors), nowMs)
  await recordPaged(kv, SALESFORCE_BULKHEAD_SIGNAL, SALESFORCE_BULKHEAD_SUBJECT, incident(errors), nowMs)
  return summary
}

/** The daily check wired to the bidding Worker: its own env, the Slack organizations, Slack. */
export function runSalesforceBulkheadCheckForEnv(supabase: SupabaseClient, env: Env): Promise<SalesforceBulkheadCheckSummary> {
  return runSalesforceBulkheadCheck({
    kv: env.IDEMPOTENCY,
    resolvedLimit: () => salesforceBulkheadLimit(env),
    orgsToTell: async () => {
      const list = await slackOrgIds(supabase, SALESFORCE_BULKHEAD_CHECK_JOB, 'tell-only')
      return list.kind === 'unreachable' ? null : orgIdsToTell(list)
    },
    sendAlert: (orgId, alert) => sendSalesforceBulkheadLimitAlert(supabase, orgId, alert),
    sendRecovery: (orgId, recovery) => sendSalesforceBulkheadLimitRecoveryAlert(supabase, orgId, recovery),
    now: () => Date.now(),
  })
}
