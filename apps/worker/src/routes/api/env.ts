import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { setCfSecret, deleteCfSecret } from '../../lib/cf-secrets'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const env = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/env — list vars; secret values omitted
env.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('environment_variables')
    .select('id, key, value, is_secret, scope, workflow_id, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .order('key', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  // Mask secret values
  const masked = (data ?? []).map((row) => ({
    ...row,
    value: row.is_secret ? null : row.value,
  }))

  return c.json(masked)
})

// POST /api/env
env.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    key: string
    value?: string
    is_secret?: boolean
    scope?: string
    workflow_id?: string
  }>()

  if (!body.key) return c.json({ error: 'key is required' }, 400)
  if (body.is_secret && !body.value) return c.json({ error: 'value is required for secrets' }, 400)

  // Sync to Cloudflare if secret
  if (body.is_secret && body.value) {
    await setCfSecret(body.key, body.value, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  }

  const { data, error } = await supabase
    .from('environment_variables')
    .insert({
      organization_id: orgId,
      key: body.key,
      value: body.is_secret ? null : (body.value ?? null),
      is_secret: body.is_secret ?? false,
      scope: body.scope ?? 'global',
      workflow_id: body.workflow_id ?? null,
      created_by: userId,
      updated_by: userId,
      updated_by_email: email,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(
    supabase, orgId, 'environment_variable', data.id,
    body.is_secret ? 'secret_rotated' : 'created',
    userId,
    { key: body.key }
  )

  return c.json({ ...data, value: body.is_secret ? null : data.value }, 201)
})

// PUT /api/env/:id
env.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ key?: string; value?: string }>()

  const { data: existing, error: fetchError } = await supabase
    .from('environment_variables')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (fetchError || !existing) return c.json({ error: 'Variable not found' }, 404)

  if (existing.is_secret && body.value) {
    await setCfSecret(existing.key, body.value, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  }

  const { data, error } = await supabase
    .from('environment_variables')
    .update({
      key: body.key ?? existing.key,
      value: existing.is_secret ? null : (body.value ?? existing.value),
      updated_by: userId,
      updated_by_email: email,
    })
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(
    supabase, orgId, 'environment_variable', id,
    existing.is_secret ? 'secret_rotated' : 'updated',
    userId,
    { key: existing.key }
  )

  return c.json({ ...data, value: existing.is_secret ? null : data.value })
})

// DELETE /api/env/:id
env.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: fetchError } = await supabase
    .from('environment_variables')
    .select('key, is_secret')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (fetchError || !existing) return c.json({ error: 'Variable not found' }, 404)

  if (existing.is_secret) {
    await deleteCfSecret(existing.key, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  }

  await supabase.from('environment_variables').delete().eq('id', id)

  await writeAuditLog(supabase, orgId, 'environment_variable', id, 'deleted', userId, { key: existing.key })

  return c.json({ ok: true })
})

export default env
