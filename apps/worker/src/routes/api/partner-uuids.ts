import { Hono } from 'hono'
import { dbError, requireRowOr404 } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidatePartnerConstantsCache } from '../../lib/partner-constants-loader'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const partnerUuids = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── List ──────────────────────────────────────────────────────────────────────

partnerUuids.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_uuid_map')
    .select('id, partner_slug, uuid, created_at')
    .eq('org_id', orgId)
    .order('partner_slug', { ascending: true })

  if (error) return dbError(c, error)
  return c.json(data)
})

// ── Create ────────────────────────────────────────────────────────────────────

partnerUuids.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ partner_slug?: string; uuid?: string }>()

  if (!body.partner_slug) return c.json({ error: 'partner_slug is required' }, 400)
  if (!body.uuid) return c.json({ error: 'uuid is required' }, 400)

  const { data, error } = await supabase
    .from('partner_uuid_map')
    .insert({ org_id: orgId, partner_slug: body.partner_slug, uuid: body.uuid })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return c.json({ error: `UUID "${body.uuid}" already exists` }, 409)
    return dbError(c, error)
  }

  await writeAuditLog(supabase, orgId, 'partner_uuid', (data as { id: string }).id, 'created', userId, {
    partner_slug: body.partner_slug,
    uuid: body.uuid,
  })

  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  return c.json(data, 201)
})

// ── Delete ────────────────────────────────────────────────────────────────────

partnerUuids.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const blocked = await requireRowOr404(c, 'Partner UUID not found', () =>
    supabase.from('partner_uuid_map').delete().eq('id', id).eq('org_id', orgId).select('id')
  )
  if (blocked) return blocked

  await writeAuditLog(supabase, orgId, 'partner_uuid', id, 'deleted', userId)

  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  return c.json({ ok: true })
})

export default partnerUuids
