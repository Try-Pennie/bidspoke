import { Hono } from 'hono'
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
import access from './access'
import servicePresets from './service-presets'
import stats from './stats'

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
api.route('/access', access)
api.route('/service-presets', servicePresets)
api.route('/stats', stats)
api.all('/connections/*', (c) => c.json({ error: 'not implemented (Phase 3)' }, 501))
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
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

export default api
