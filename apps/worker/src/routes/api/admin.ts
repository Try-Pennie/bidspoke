// Admin-only endpoints for one-shot maintenance operations.
// All endpoints are scoped to the caller's org — no cross-org access.

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { deployCodeNodes } from '../../lib/code-node-deployer'
import type { WorkflowDefinition } from '../../types'

const admin = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/**
 * Force-redeploys every active workflow's code nodes under the current
 * deployer layout (bundled worker per workflow). Used once after rolling out
 * 4B to migrate all workflows off per-node workers.
 */
admin.post('/migrate-code-workers', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data: workflows, error } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)

  if (error) return c.json({ error: error.message }, 500)
  if (!workflows) return c.json({ migrated: 0, results: [] })

  const results = await Promise.all(
    workflows.map(async (w) => {
      const definition = w.definition as WorkflowDefinition | null
      if (!definition) return { id: w.id, name: w.name, status: 'skipped', reason: 'no definition' }
      try {
        const deployResults = await deployCodeNodes(
          w.id as string,
          definition,
          c.env.CLOUDFLARE_ACCOUNT_ID,
          c.env.CLOUDFLARE_API_TOKEN
        )
        const errors = deployResults.filter((r) => r.error)
        if (errors.length > 0) {
          return { id: w.id, name: w.name, status: 'error', error: errors[0].error, node_count: deployResults.length }
        }
        return { id: w.id, name: w.name, status: 'migrated', node_count: deployResults.length }
      } catch (e) {
        return { id: w.id, name: w.name, status: 'error', error: e instanceof Error ? e.message : String(e) }
      }
    })
  )

  const migrated = results.filter((r) => r.status === 'migrated').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const errored = results.filter((r) => r.status === 'error').length

  return c.json({ migrated, skipped, errored, results })
})

export default admin
