/**
 * GET /partners/:id/usage (#2137): which of the organization's workflow steps
 * name this partner, per node kind (lib/partner-usage.ts), so the partners page
 * shows the Bid Group tab and the confirmation window only where they apply.
 *
 * Who may call it: any allowlisted member of the organization (jwtAuth, applied
 * to every /api route). Whose data it touches: only the caller's organization.
 * The Worker is service_role, so row level security does not apply: the partner
 * is read by id AND organization_id (another organization's id is a 404, and no
 * workflow is read), and the workflows through readOrgWorkflows, the one read
 * scoped by organization_id and deleted_at that drops any row the scoping let
 * through. Read only, so running it twice is harmless.
 *
 * A failed read answers an error, never an empty usage (L10): an empty answer
 * would read as "no workflow names this partner" and hide the tab.
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { readOrgWorkflows } from '../../lib/org-workflows'
import { partnerUsage } from '../../lib/partner-usage'
import { isUuid } from '../../lib/query-validators'

const partnerUsageRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

partnerUsageRoutes.get('/:id/usage', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  // An id that is not a uuid names no partner: a 404, never the database's
  // malformed input error answered as a 500.
  if (!isUuid(id)) return c.json({ error: 'Partner not found' }, 404)
  const supabase = createSupabaseClient(c.env)

  const { data: partner, error } = await supabase
    .from('partner_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  let workflows
  try {
    workflows = await readOrgWorkflows(supabase, orgId)
  } catch (err) {
    return dbError(c, err)
  }
  return c.json(partnerUsage(workflows, id))
})

export default partnerUsageRoutes
