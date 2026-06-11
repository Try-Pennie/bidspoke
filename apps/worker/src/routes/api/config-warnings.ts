import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { getOrgTimeoutWarnings, getOrgHistoryWarnings } from '../../lib/timeout-audit'

type Variables = AuthVariables

const configWarnings = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/config-warnings
// Powers the dashboard "Configuration warnings" panel. Three parts, all live
// scans of each active workflow's current definition (no caching):
//   workflows         — steps whose timeout is BELOW the node-type floor
//                       (cold-run failure risk; also drives the Slack cron).
//   under_provisioned — steps whose timeout is below the history-based suggested
//                       value (slow runs time out; also in the Slack cron).
//   over_provisioned  — steps whose timeout is far ABOVE what their run history
//                       needs (low-urgency cleanup; dashboard only).
configWarnings.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const [workflows, history] = await Promise.all([
    getOrgTimeoutWarnings(supabase, orgId),
    getOrgHistoryWarnings(supabase, orgId),
  ])
  return c.json({
    workflows,
    under_provisioned: history.under_provisioned,
    over_provisioned: history.over_provisioned,
  })
})

export default configWarnings
