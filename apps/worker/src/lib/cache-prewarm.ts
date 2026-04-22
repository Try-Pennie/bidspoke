// Scheduled cache pre-warm — keeps KV hot for all active workflows so cold-path
// execution latency stays low even when no traffic has arrived for a while.
// Runs every 4 minutes (under the 5-min TTL on all three caches) via the
// scheduled handler in src/index.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadWorkflowDefinition } from '../engine/definition-loader'
import { loadEnvVars } from './env-loader'
import { loadPartnerConstants } from './partner-constants-loader'
import type { Env } from '../index'

export async function prewarmKvCaches(supabase: SupabaseClient, env: Env): Promise<void> {
  const start = Date.now()

  const { data: workflows, error } = await supabase
    .from('workflows')
    .select('id, organization_id')
    .eq('is_active', true)

  if (error || !workflows || workflows.length === 0) {
    console.log(`[prewarm] no active workflows found (error: ${error?.message ?? 'none'})`)
    return
  }

  const orgIds = Array.from(new Set(workflows.map((w) => w.organization_id as string)))

  const perOrg = orgIds.flatMap((orgId) => [
    loadEnvVars(orgId, env.WORKFLOW_CACHE, supabase).catch(() => undefined),
    loadPartnerConstants(orgId, env.WORKFLOW_CACHE, supabase).catch(() => undefined),
  ])

  const perWorkflow = workflows.map((w) =>
    loadWorkflowDefinition(w.id as string, env.WORKFLOW_CACHE, supabase).catch(() => undefined)
  )

  await Promise.all([...perOrg, ...perWorkflow])

  const durationMs = Date.now() - start
  console.log(
    `[prewarm] refreshed ${workflows.length} workflow defs, ${orgIds.length} orgs (env + partner constants) in ${durationMs}ms`
  )
}
