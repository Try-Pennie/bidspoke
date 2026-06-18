// Service connection management + schema sync — PRD Section 2.8
// GET    /api/connections                       — list connections (no credentials)
// POST   /api/connections                       — create or replace a connection
// DELETE /api/connections/:service_type         — remove a connection
// POST   /api/connections/:service_type/sync-schema — trigger schema refresh

import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { setCfSecret, deleteCfSecret } from '../../lib/cf-secrets'
import { writeAuditLog } from '../../lib/audit'
import { fetchSalesforceSchema } from '../../lib/schema-sync/salesforce'
import { fetchSupabaseSchema } from '../../lib/schema-sync/supabase-schema'
import { fetchSnowflakeSchema } from '../../lib/schema-sync/snowflake'

type Variables = AuthVariables
type ServiceType = 'salesforce' | 'supabase' | 'snowflake'

const SERVICE_TYPES = new Set<string>(['salesforce', 'supabase', 'snowflake'])
const AUTH_TYPE: Record<ServiceType, string> = {
  salesforce: 'oauth',
  supabase: 'api_key',
  snowflake: 'credentials',
}

const connections = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/connections
connections.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('service_connections')
    .select('id, service_type, auth_type, schema_cache, schema_synced_at, created_at, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .in('service_type', ['salesforce', 'supabase', 'snowflake'])
    .order('service_type')
  if (error) return dbError(c, error)
  return c.json(data ?? [])
})

// POST /api/connections — upsert by (org, service_type)
connections.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const body = await c.req.json<{ service_type: string; credentials: Record<string, unknown> }>()

  if (!SERVICE_TYPES.has(body.service_type)) {
    return c.json({ error: `service_type must be one of: ${[...SERVICE_TYPES].join(', ')}` }, 400)
  }
  if (!body.credentials || typeof body.credentials !== 'object') {
    return c.json({ error: 'credentials required' }, 400)
  }

  const serviceType = body.service_type as ServiceType
  const supabase = createSupabaseClient(c.env)

  // Reuse existing secret key if connection already exists
  const { data: existing } = await supabase
    .from('service_connections')
    .select('id, cf_secret_key')
    .eq('organization_id', orgId)
    .eq('service_type', serviceType)
    .single()

  const cfSecretKey = existing?.cf_secret_key
    ?? `CONN_${crypto.randomUUID().replace(/-/g, '_').toUpperCase()}`

  await setCfSecret(
    cfSecretKey,
    JSON.stringify(body.credentials),
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN
  )

  const { data, error } = await supabase
    .from('service_connections')
    .upsert({
      organization_id: orgId,
      service_type: serviceType,
      auth_type: AUTH_TYPE[serviceType],
      cf_secret_key: cfSecretKey,
      updated_by: userId,
      updated_by_email: email,
    }, { onConflict: 'organization_id,service_type' })
    .select('id, service_type, auth_type, schema_cache, schema_synced_at, created_at, updated_at, updated_by_email')
    .single()

  if (error) return dbError(c, error)

  await writeAuditLog(supabase, orgId, 'service_connection', data.id, existing ? 'updated' : 'created', userId, {
    service_type: serviceType,
  })

  return c.json(data, existing ? 200 : 201)
})

// DELETE /api/connections/:service_type
connections.delete('/:service_type', async (c) => {
  const { orgId, userId } = c.get('user')
  const serviceType = c.req.param('service_type')

  const supabase = createSupabaseClient(c.env)
  const { data: existing } = await supabase
    .from('service_connections')
    .select('id, cf_secret_key')
    .eq('organization_id', orgId)
    .eq('service_type', serviceType)
    .single()

  if (!existing) return c.json({ error: 'Connection not found' }, 404)

  await deleteCfSecret(
    existing.cf_secret_key,
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN
  ).catch(() => {}) // best-effort — secret may already be gone

  await supabase.from('service_connections').delete().eq('id', existing.id)

  await writeAuditLog(supabase, orgId, 'service_connection', existing.id, 'deleted', userId, {
    service_type: serviceType,
  })

  return c.json({ ok: true })
})

// POST /api/connections/:service_type/sync-schema
connections.post('/:service_type/sync-schema', async (c) => {
  const { orgId, userId } = c.get('user')
  const serviceType = c.req.param('service_type') as ServiceType

  const supabase = createSupabaseClient(c.env)
  const { data: conn } = await supabase
    .from('service_connections')
    .select('id, cf_secret_key, service_type')
    .eq('organization_id', orgId)
    .eq('service_type', serviceType)
    .single()

  if (!conn) return c.json({ error: 'Connection not found' }, 404)

  const credsJson = (c.env as unknown as Record<string, string>)[conn.cf_secret_key]
  if (!credsJson) {
    return c.json({ error: 'Credentials not available — re-save the connection to refresh' }, 500)
  }

  let schema
  try {
    if (serviceType === 'salesforce') schema = await fetchSalesforceSchema(credsJson)
    else if (serviceType === 'supabase') schema = await fetchSupabaseSchema(credsJson)
    else if (serviceType === 'snowflake') schema = await fetchSnowflakeSchema(credsJson)
    else return c.json({ error: 'Unsupported service type' }, 400)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Schema fetch failed' }, 502)
  }

  const { error } = await supabase
    .from('service_connections')
    .update({ schema_cache: schema, schema_synced_at: new Date().toISOString() })
    .eq('id', conn.id)

  if (error) return dbError(c, error)

  await writeAuditLog(supabase, orgId, 'service_connection', conn.id, 'schema_synced', userId, {
    service_type: serviceType,
    object_count: schema.objects.length,
  })

  return c.json({ ok: true, object_count: schema.objects.length })
})

export default connections
