// Scheduled cache pre-warm — keeps KV hot for all active workflows so cold-path
// execution latency stays low even when no traffic has arrived for a while.
// Runs every 4 minutes (under the 5-min TTL on all three caches) via the
// scheduled handler in src/index.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadWorkflowDefinition } from '../engine/definition-loader'
import { loadEnvVars } from './env-loader'
import { resolveSalesforceCredsFor } from './salesforce-creds'
import { loadPartnerConstants } from './partner-constants-loader'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import type { Env } from '../index'
import { secretKeys } from './secret-crypto'

export async function prewarmKvCaches(supabase: SupabaseClient, env: Env): Promise<void> {
  const start = Date.now()

  const { data: workflows, error } = await supabase
    .from('workflows')
    .select('id, organization_id')
    .eq('is_active', true)
    .is('deleted_at', null)

  if (error || !workflows || workflows.length === 0) {
    console.log(`[prewarm] no active workflows found (error: ${error?.message ?? 'none'})`)
    return
  }

  const orgIds = Array.from(new Set(workflows.map((w) => w.organization_id as string)))

  // The comment that stood here said "SF creds are currently CF secrets
  // (single-tenant)", and that was measurably wrong: only CLIENT_SECRET is a
  // Worker secret, so `canWarmSalesforce` was ALWAYS false and the Salesforce
  // token has never once been prewarmed (#1174). Resolved per organization now,
  // through the one implementation, because the credentials are per organization.

  const perOrg = orgIds.flatMap((orgId) => {
    const tasks: Promise<unknown>[] = [
      loadEnvVars(orgId, env.WORKFLOW_CACHE, supabase, secretKeys(env)).catch(() => undefined),
      loadPartnerConstants(orgId, env.WORKFLOW_CACHE, supabase).catch(() => undefined),
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
}
