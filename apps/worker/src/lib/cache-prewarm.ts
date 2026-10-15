// Scheduled cache pre-warm — keeps KV hot for all active workflows so cold-path
// execution latency stays low even when no traffic has arrived for a while.
// Runs every minute (the '* * * * *' cron, well under the 5 minute TTLs) via the
// scheduled handler in src/index.ts. The buyer profile copy is rebuilt outright
// rather than read, because a read of a held copy extends nothing (#1632).

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadWorkflowDefinition } from '../engine/definition-loader'
import { keepBuyerProfilesWarm } from './buyer-profile-loader'
import { loadEnvVars } from './env-loader'
import { resolveSalesforceCredsFor } from './salesforce-creds'
import { keepPartnerConstantsConfirmed, loadPartnerConstants } from './partner-constants-loader'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import type { Env } from '../index'
import { secretKeys } from './secret-crypto'
import { checkReconfirmFailures, recordReconfirmOutcomes, type ReconfirmOutcome } from './partner-constants-reconfirm'
import type { notifyExportFailure } from './export-alerts'
import { formatErr } from './format-error'

export interface PrewarmResult {
  /** The read of the active workflows failed, so no organization was warmed or reconfirmed. */
  workflowsReadError: string | null
  /** What keepPartnerConstantsConfirmed answered, per organization (#2132). */
  reconfirms: Record<string, ReconfirmOutcome>
}

export interface PrewarmOptions {
  /** The shared alerter, replaced in tests. */
  notify?: typeof notifyExportFailure
}

export async function prewarmKvCaches(supabase: SupabaseClient, env: Env, opts: PrewarmOptions = {}): Promise<PrewarmResult> {
  const start = Date.now()

  const { data: workflows, error } = await supabase
    .from('workflows')
    .select('id, organization_id')
    .eq('is_active', true)
    .is('deleted_at', null)

  if (error) {
    // Not a quiet return (#2132): no organization's partner constants are
    // reconfirmed while this fails, so the bidding pickup bound stops holding.
    console.error(`[prewarm] could not read the active workflows, so nothing was warmed or reconfirmed: ${error.message}`)
    const result: PrewarmResult = { workflowsReadError: error.message, reconfirms: {} }
    await recordAndCheck(supabase, env, result, opts)
    return result
  }
  if (!workflows || workflows.length === 0) {
    console.log('[prewarm] no active workflows found')
    // No organization bids, so none is owed a reconfirm: recording this clears
    // any standing failure and lets its page clear (L152).
    const result: PrewarmResult = { workflowsReadError: null, reconfirms: {} }
    await recordAndCheck(supabase, env, result, opts)
    return result
  }

  const orgIds = Array.from(new Set(workflows.map((w) => w.organization_id as string)))
  const reconfirms: Record<string, ReconfirmOutcome> = {}

  // The comment that stood here said "SF creds are currently CF secrets
  // (single-tenant)", and that was measurably wrong: only CLIENT_SECRET is a
  // Worker secret, so `canWarmSalesforce` was ALWAYS false and the Salesforce
  // token has never once been prewarmed (#1174). Resolved per organization now,
  // through the one implementation, because the credentials are per organization.

  const perOrg = orgIds.flatMap((orgId) => {
    const tasks: Promise<unknown>[] = [
      // One load warms the org values and every workflow's own (#1681).
      loadEnvVars(orgId, env.WORKFLOW_CACHE, supabase, secretKeys(env), 'global-only').catch(() => undefined),
      // Warm the 30 day cache, then confirm the last-good copy against the
      // database once it is due, which no lead does while that cache is a hit,
      // so it never ages past the maximum on a healthy day (#1847). Never throws.
      // Its answer is kept and recorded (#2132): this reconfirm is what bounds how
      // soon bidding sees a change the partners page did not make.
      loadPartnerConstants(orgId, env.WORKFLOW_CACHE, supabase)
        .catch(() => undefined)
        .then(() => keepPartnerConstantsConfirmed(orgId, env.WORKFLOW_CACHE, supabase))
        .then((outcome) => {
          reconfirms[orgId] = outcome
          if (outcome === 'failed') console.error(`[prewarm] the partner constants reconfirm for org ${orgId} failed; bidding keeps the copy it holds`)
        }),
      // Never throws; a failure is logged inside and the held copy is kept.
      keepBuyerProfilesWarm(orgId, env.WORKFLOW_CACHE, supabase),
    ]
    // Declines quietly for an organization with no credentials: a prewarm is an
    // optimisation and must not fail the run, and the jobs that NEED them report
    // their absence loudly themselves.
    tasks.push(
      resolveSalesforceCredsFor(env, supabase, orgId)
        .then((r) => (r.creds
          ? getSalesforceToken(env, orgId, r.creds.instanceUrl, r.creds.clientId, r.creds.clientSecret)
          : undefined))
        .catch(() => undefined)
    )
    return tasks
  })

  const perWorkflow = workflows.map((w) =>
    loadWorkflowDefinition(w.id as string, env.WORKFLOW_CACHE, supabase).catch(() => undefined)
  )

  await Promise.all([...perOrg, ...perWorkflow])

  const durationMs = Date.now() - start
  console.log(
    `[prewarm] refreshed ${workflows.length} workflow defs, ${orgIds.length} orgs (env + partner constants + SF token where configured) in ${durationMs}ms`
  )
  const result: PrewarmResult = { workflowsReadError: null, reconfirms }
  await recordAndCheck(supabase, env, result, opts)
  return result
}

/**
 * Record this run's reconfirm outcomes and judge them (#2132). Never throws: a
 * record that cannot be written is logged, and the prewarm's own work stands.
 */
async function recordAndCheck(supabase: SupabaseClient, env: Env, result: PrewarmResult, opts: PrewarmOptions): Promise<void> {
  if (!env.IDEMPOTENCY) {
    console.error('[prewarm] no IDEMPOTENCY binding, so the partner constants reconfirm outcomes were not recorded')
    return
  }
  try {
    const nowMs = Date.now()
    const state = await recordReconfirmOutcomes(env.IDEMPOTENCY, result, nowMs)
    await checkReconfirmFailures({ kv: env.IDEMPOTENCY, supabase, state, nowMs, notify: opts.notify })
  } catch (e) {
    console.error(`[prewarm] could not record or judge the partner constants reconfirm outcomes: ${formatErr(e)}`)
  }
}
