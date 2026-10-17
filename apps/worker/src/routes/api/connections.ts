// Service connection management and schema sync (PRD Section 2.8)
// GET    /api/connections                            list connections (no credentials)
// POST   /api/connections                            refused: connections_moving, 410 (#2331)
// DELETE /api/connections/:service_type              remove a connection
// POST   /api/connections/:service_type/sync-schema  trigger schema refresh

// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's rows, scoped by organization_id from
// the verified token. None of them changes a Cloudflare secret (#2331).
//
// The audit record (#2331, F119): the table's own trigger writes one audit_log
// row per change, naming the user from updated_by (every write here sets it) or,
// for a delete, from delete_service_connection's actor, as for partner_configs
// (#1409). So these routes write no audit row of their own.

import { Hono } from 'hono'
import { dbError, isNotFoundError, requireRowOr404 } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { fetchSalesforceSchema } from '../../lib/schema-sync/salesforce'
import { fetchSupabaseSchema } from '../../lib/schema-sync/supabase-schema'
import { fetchSnowflakeSchema } from '../../lib/schema-sync/snowflake'
import { asJson } from '../../lib/json'

type Variables = AuthVariables
type ServiceType = 'salesforce' | 'supabase' | 'snowflake'

const SERVICE_TYPES = new Set<string>(['salesforce', 'supabase', 'snowflake'])

const connections = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * The org's LEGACY row of a type (#2332, F124): one whose credential is a
 * Cloudflare secret (cf_secret_key set) and was never sealed (sealed_for null).
 * DELETE and sync-schema find their row by service type alone, so without this
 * they would reach an ops connection (sealed_for ops_key, cf_secret_key null)
 * and remove it while skipping what Phase 8's own delete does: refuse a
 * referenced connection, write the tombstone, revoke. With two rows of a type,
 * `.single()` answers PGRST116, which both routes read as not found (404).
 * delete_service_connection refuses an ops_key row too (migration
 * 20261017150000), so the store holds the line if a caller forgets this.
 * No legacy row exists (measured 2026-10-17); Phase 8 retires both routes.
 */
function legacyConnectionOf<Columns extends string>(
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  serviceType: string,
  columns: Columns,
) {
  return supabase
    .from('service_connections')
    .select(columns)
    .eq('organization_id', orgId)
    .eq('service_type', serviceType)
    .is('sealed_for', null)
    .not('cf_secret_key', 'is', null)
}

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

// POST /api/connections: refused (#2331, phase 1a). It stored the credentials
// as a CONN_ secret on the bidding Worker, and every secret put creates and
// deploys a new version of that Worker. No salesforce, supabase or snowflake
// connection exists, so nothing is lost; the sealed connections of #1689
// replace it. Refused before the body or the table is read.
const CONNECTIONS_MOVING_MESSAGE =
  'Salesforce, Supabase and Snowflake connections can no longer be saved here while they move to sealed connections.'

connections.post('/', (c) =>
  c.json({ error: 'connections_moving', message: CONNECTIONS_MOVING_MESSAGE }, 410),
)

// DELETE /api/connections/:service_type
connections.delete('/:service_type', async (c) => {
  const { orgId, userId } = c.get('user')
  const serviceType = c.req.param('service_type')
  // Only the types this route manages. Before #2060 any type was accepted, so
  // DELETE /api/connections/slack removed the Slack connection without taking
  // the org out of the saved Slack copy, which only its own route does
  // (integrations.ts).
  if (!SERVICE_TYPES.has(serviceType)) {
    return c.json({ error: `service_type must be one of: ${[...SERVICE_TYPES].join(', ')}` }, 400)
  }

  const supabase = createSupabaseClient(c.env)
  const { data: existing, error: existingError } = await legacyConnectionOf(supabase, orgId, serviceType, 'id').single()

  // PGRST116 = no connection for this org (→ 404); a real error must not look
  // like a 404, which would block a legitimate delete (#303).
  if (existingError && !isNotFoundError(existingError)) return dbError(c, existingError)
  if (!existing) return c.json({ error: 'Connection not found' }, 404)

  // The row's CONN_ secret is left in place (#2331, phase 1a): deleting a secret
  // is a secret change on the bidding Worker, deploying a new version of it just
  // as a put does. Removing any orphan CONN_ secret is Phase 9's signed off job.
  // None exists to orphan today (Phase 0 found 0 CONN_ secrets and no row of
  // these types), and POST can no longer create one.

  // Through delete_service_connection, so the table's trigger names this user.
  const deleteBlocked = await requireRowOr404(c, 'Connection not found', () =>
    supabase.rpc('delete_service_connection', { p_organization_id: orgId, p_service_type: serviceType, p_actor: userId })
  )
  if (deleteBlocked) return deleteBlocked

  return c.json({ ok: true })
})

// POST /api/connections/:service_type/sync-schema
connections.post('/:service_type/sync-schema', async (c) => {
  const { orgId, userId } = c.get('user')
  const serviceType = c.req.param('service_type') as ServiceType
  // Refused before the table is read, as DELETE does (#2060), so this route can
  // never write a Slack row the saved Slack copy describes.
  if (!SERVICE_TYPES.has(serviceType)) {
    return c.json({ error: `service_type must be one of: ${[...SERVICE_TYPES].join(', ')}` }, 400)
  }

  const supabase = createSupabaseClient(c.env)
  const { data: conn, error: connError } = await legacyConnectionOf(supabase, orgId, serviceType, 'id, cf_secret_key, service_type').single()

  if (connError && !isNotFoundError(connError)) return dbError(c, connError)
  // A row with no Cloudflare secret name is not a legacy connection (#2332).
  if (!conn || !conn.cf_secret_key) return c.json({ error: 'Connection not found' }, 404)

  const credsJson = (c.env as unknown as Record<string, string>)[conn.cf_secret_key]
  if (!credsJson) {
    // Not "re-save it": POST refuses since #2331 phase 1a, so that would name
    // an action nobody can take (L111).
    return c.json({ error: 'The credentials for this connection are missing, and it cannot be saved again while connections move to sealed connections.' }, 500)
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

  const syncBlocked = await requireRowOr404(c, 'Connection not found', () =>
    supabase
      .from('service_connections')
      .update({ schema_cache: asJson(schema), schema_synced_at: new Date().toISOString(), updated_by: userId })
      .eq('id', conn.id)
      .eq('organization_id', orgId)
      .select('id')
  )
  if (syncBlocked) return syncBlocked

  return c.json({ ok: true, object_count: schema.objects.length })
})

export default connections
