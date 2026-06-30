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
api.route('/field-coverage', fieldCoverage)
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
