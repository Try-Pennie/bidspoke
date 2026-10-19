import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidatePartnerConstantsCache } from '../../lib/partner-constants-loader'

type Variables = AuthVariables

/**
 * Sub-account ID mappings. Who may call: any allowlisted member of the
 * organization (jwtAuth). Whose rows: only this organization's, since orgId
 * comes from the token and every read and the RPC carry it.
 *
 * Both writes go through change_partner_uuid (#2135), which sets
 * bidspoke.actor_* before writing: a trigger cannot see who made a single
 * PostgREST insert or delete, and the partners page notice those triggers send
 * says whether a change had an editor. The same actor names the person on the
 * audit row, which the partner_uuid_map_audit trigger writes once per change
 * (#2141), so this route writes none of its own.
 */
const partnerUuids = new Hono<{ Bindings: Env; Variables: Variables }>()

interface UuidRow {
  id: string
  partner_slug: string
  uuid: string
}

// ── List ──────────────────────────────────────────────────────────────────────

partnerUuids.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('partner_uuid_map')
      .select('id, partner_slug, uuid, created_at')
      .eq('org_id', orgId)
      .order('partner_slug', { ascending: true })
      .limit(limit), CONFIG_LIST_BOUNDS.partnerUuids, 'partner uuids list'))
  } catch (err) {
    return dbError(c, err)
  }
})

// ── Create ────────────────────────────────────────────────────────────────────

partnerUuids.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ partner_slug?: string; uuid?: string }>()

  if (!body.partner_slug) return c.json({ error: 'partner_slug is required' }, 400)
  if (!body.uuid) return c.json({ error: 'uuid is required' }, 400)

  const { data, error } = await supabase.rpc('change_partner_uuid', {
    p_org: orgId,
    p_slug: body.partner_slug,
    p_uuid: body.uuid,
    p_action: 'add',
    p_actor: userId,
    p_actor_email: email,
    p_actor_name: c.get('user').name ?? '',
  })

  if (error) {
    if (error.code === '23505') return c.json({ error: `UUID "${body.uuid}" already exists` }, 409)
    if (error.code === 'P0002') return c.json({ error: `No partner with slug "${body.partner_slug}" in this organization` }, 404) // db-guard-ok: P0002 is change_partner_uuid's own named refusal for a slug no partner of this org holds, never a transport or query error
    return dbError(c, error)
  }
  const row = data as unknown as UuidRow

  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  return c.json(row, 201)
})

// ── Delete ────────────────────────────────────────────────────────────────────

partnerUuids.delete('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // The mapping as this organization holds it (#588): an id that never existed,
  // or another organization's, is a 404 and never reads as a deletion.
  const { data: found, error: readError } = await supabase
    .from('partner_uuid_map')
    .select('id, partner_slug, uuid')
    .eq('id', id)
    .eq('org_id', orgId)
    .single()
  const readBlocked = dbErrorUnlessNotFound(c, readError)
  if (readBlocked) return readBlocked
  if (!found) return c.json({ error: 'Partner UUID not found' }, 404)
  const row: UuidRow = found

  const { error } = await supabase.rpc('change_partner_uuid', {
    p_org: orgId,
    p_slug: row.partner_slug,
    p_uuid: row.uuid,
    p_action: 'remove',
    p_actor: userId,
    p_actor_email: email,
    p_actor_name: c.get('user').name ?? '',
  })
  if (error) {
    if (error.code === 'P0002') return c.json({ error: 'Partner UUID not found' }, 404) // db-guard-ok: P0002 is change_partner_uuid's own named refusal for a mapping that went between the read and the remove
    return dbError(c, error)
  }

  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  return c.json({ ok: true })
})

export default partnerUuids
