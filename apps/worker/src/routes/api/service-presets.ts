import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, requireRowOr404 } from '../../lib/api-error'
import { fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import type { Database } from '../../types/database'

type Variables = AuthVariables

const servicePresets = new Hono<{ Bindings: Env; Variables: Variables }>()

servicePresets.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('service_presets')
      .select('id, name, slug, auth_type, base_url, created_at')
      .eq('organization_id', orgId)
      .order('name')
      .limit(limit), CONFIG_LIST_BOUNDS.servicePresets, 'service presets list'))
  } catch (err) {
    return dbError(c, err)
  }
})

servicePresets.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string; slug: string; auth_type: string; base_url?: string }>()

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  if (!body.slug?.trim()) return c.json({ error: 'slug is required' }, 400)
  if (!['none', 'api_key', 'bearer', 'basic'].includes(body.auth_type)) {
    return c.json({ error: 'invalid auth_type' }, 400)
  }

  const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')

  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('service_presets')
    .insert({
      organization_id: orgId,
      name: body.name.trim(),
      slug,
      auth_type: body.auth_type,
      base_url: body.base_url?.trim() || null,
    })
    .select('id, name, slug, auth_type, base_url, created_at')
    .single()

  if (error) {
    if (error.code === '23505') return c.json({ error: `A service with slug "${slug}" already exists` }, 409)
    return dbError(c, error)
  }
  await writeAuditLog(supabase, orgId, 'service_preset', data.id, 'created', userId, { name: data.name, slug: data.slug })
  return c.json(data, 201)
})

servicePresets.put('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; auth_type?: string; base_url?: string }>()

  if (body.auth_type && !['none', 'api_key', 'bearer', 'basic'].includes(body.auth_type)) {
    return c.json({ error: 'invalid auth_type' }, 400)
  }

  const patch: Database['public']['Tables']['service_presets']['Update'] = {}
  if (body.name) patch.name = body.name.trim()
  if (body.auth_type) patch.auth_type = body.auth_type
  if ('base_url' in body) patch.base_url = body.base_url?.trim() || null

  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('service_presets')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, name, slug, auth_type, base_url, created_at')
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'not found' }, 404)
  await writeAuditLog(supabase, orgId, 'service_preset', id, 'updated', userId, patch)
  return c.json(data)
})

servicePresets.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const blocked = await requireRowOr404(c, 'Preset not found', () =>
    supabase.from('service_presets').delete().eq('id', id).eq('organization_id', orgId).select('id')
  )
  if (blocked) return blocked
  await writeAuditLog(supabase, orgId, 'service_preset', id, 'deleted', userId)
  return c.json({ ok: true })
})

export default servicePresets
