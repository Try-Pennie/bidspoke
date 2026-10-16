import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import workflows from './workflows'
import executions from './executions'
import env from './env'
import circuit from './circuit'
import integrations from './integrations'
import sources from './sources'
import partners from './partners'
import partnerBidConfigs from './partner-bid-configs'
import access from './access'
import servicePresets from './service-presets'
import stats from './stats'
import connections from './connections'
import endpointRoutes from './endpoints'
import partnerUuids from './partner-uuids'
import admin from './admin'
import settings from './settings'
import folders from './folders'
import envFolders from './env-folders'
import configWarnings from './config-warnings'
import fieldCoverage from './field-coverage'
import buyerProfiles from './buyer-profiles'
import buyerSales from './buyer-sales'
import heldClicks from './held-clicks'
import buyerSelectParity from './buyer-select-parity'
import mutedAlertRoutes from './muted-alerts'
import incidentRoutes from './incidents'
import partnerUsageRoutes from './partner-usage'

type Variables = AuthVariables

const api = new Hono<{ Bindings: Env; Variables: Variables }>()

// All API routes require JWT auth
api.use('*', jwtAuth)

api.route('/workflows', workflows)
api.route('/executions', executions)
api.route('/env', env)
api.route('/circuit', circuit)
api.route('/integrations', integrations)
api.route('/sources', sources)
api.route('/partners', partners)
api.route('/partner-bid-configs', partnerBidConfigs)
api.route('/access', access)
api.route('/service-presets', servicePresets)
api.route('/stats', stats)
api.route('/connections', connections)
api.route('/endpoints', endpointRoutes)
api.route('/partner-uuids', partnerUuids)
api.route('/admin', admin)
api.route('/settings', settings)
api.route('/folders', folders)
api.route('/env-folders', envFolders)
api.route('/config-warnings', configWarnings)
// Which alerts are currently muted and when they return (#1047).
api.route('/muted-alerts', mutedAlertRoutes)
// The incident record for the dashboard (#2101): the caller's organization's
// incidents and the platform's.
api.route('/incidents', incidentRoutes)
api.route('/field-coverage', fieldCoverage)
// Buyer profile routes share the /partners prefix (#1412); a Hono sub app
// matches only its own paths, so /partners/:id and /partners/:id/buyer-profile
// do not collide.
api.route('/partners', buyerProfiles)
api.route('/buyer-sales', buyerSales)
// Held click claims a person releases from the partner page (#1552).
api.route('/held-clicks', heldClicks)
// The Stage A parity record (#1413): read, refresh and sign off as three verbs
// under the admin prefix. Mounted before /admin's own routes cannot matter: a
// Hono sub app matches only its own paths.
api.route('/admin/buyer-select/parity', buyerSelectParity)
// Which workflow steps name a partner, per node kind (#2137): the partners page's
// Bid Group tab and confirmation window apply only where one does.
api.route('/partners', partnerUsageRoutes)
api.get('/audit-log', async (c) => {
  const { orgId } = c.get('user')
  const supabase = (await import('../../lib/supabase')).createSupabaseClient(c.env)
  const { entity_type, from, to } = c.req.query()

  let query = supabase
    .from('audit_log')
    .select('*')
    .eq('organization_id', orgId)
    .order('changed_at', { ascending: false })
    .limit(200)

  if (entity_type) query = query.eq('entity_type', entity_type)
  if (from) query = query.gte('changed_at', from)
  if (to) query = query.lte('changed_at', to)

  const { data, error } = await query
  if (error) return dbError(c, error)
  return c.json(data)
})

export default api
