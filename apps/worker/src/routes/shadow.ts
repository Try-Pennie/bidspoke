import { Hono } from 'hono'
import type { Env } from '../index'
import { apiKeyAuth, type Variables } from '../middleware/api-key-auth'
import { executeWorkflow } from '../engine/index'
import { createSupabaseClient } from '../lib/supabase'

// Shadow mirror endpoint (Phase 4.3). Pipedream fires a fire-and-forget copy of
// each real engine request here. We acknowledge with 204 immediately so the
// mirror step never blocks Pipedream, then run the workflow in the background as
// a dry-run shadow: all logic runs, every outbound call is stubbed. Marked
// isTest so it reuses the existing suppression (no sightings, no Slack alerts)
// and stays out of prod dashboards; a __shadow source suffix keeps shadow runs
// filterable apart from manual test runs. Separate route from the eventual
// cutover endpoint so removing the mirror at cutover touches nothing real.
// See docs/engine-cutover-scope.md section 3.3.
const shadow = new Hono<{ Bindings: Env; Variables: Variables }>()

shadow.post('/:workflow_id', apiKeyAuth, async (c) => {
  const workflowId = c.req.param('workflow_id') as string
  const source = c.get('source') as string

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    payload = {}
  }

  const supabase = createSupabaseClient(c.env)

  c.executionCtx.waitUntil(
    executeWorkflow(
      {
        workflowId,
        payload,
        source: `${source}__shadow`,
        isTest: true,
        shadowMode: 'dry_run',
        enforceSourceAssignment: false,
      },
      c.env,
      supabase,
      c.executionCtx
    ).catch((err) => console.error('[shadow] execution failed:', err))
  )

  return c.body(null, 204)
})

export default shadow
