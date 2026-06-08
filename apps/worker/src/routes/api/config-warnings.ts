import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { getOrgTimeoutWarnings } from '../../lib/timeout-audit'

type Variables = AuthVariables

const configWarnings = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/config-warnings
// Active workflows in the caller's org that have a step whose timeout is below
// the node-type reliability floor. Powers the dashboard "Configuration warnings"
// panel. Live scan of each workflow's current definition (no caching) so a fix
// shows up on the next dashboard refresh.
configWarnings.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const workflows = await getOrgTimeoutWarnings(supabase, orgId)
  return c.json({ workflows })
})

export default configWarnings
