import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { getOrgTimeoutWarnings, getOrgOverProvisionedWarnings } from '../../lib/timeout-audit'

type Variables = AuthVariables

const configWarnings = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/config-warnings
// Powers the dashboard "Configuration warnings" panel. Two parts, both live
// scans of each active workflow's current definition (no caching):
//   workflows        — steps whose timeout is BELOW the node-type floor
//                      (cold-run failure risk; also drives the Slack cron).
//   over_provisioned — steps whose timeout is far ABOVE what their run history
//                      needs (low-urgency cleanup; dashboard only).
configWarnings.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const [workflows, over_provisioned] = await Promise.all([
    getOrgTimeoutWarnings(supabase, orgId),
    getOrgOverProvisionedWarnings(supabase, orgId),
  ])
  return c.json({ workflows, over_provisioned })
})

export default configWarnings
