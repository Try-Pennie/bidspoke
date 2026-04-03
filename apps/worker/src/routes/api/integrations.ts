// Integrations management — Slack connection (Phase 1.7), others (Phase 3)
// POST   /api/integrations/slack        — save/update Slack connection
// GET    /api/integrations/slack        — get current Slack connection (token masked)
// DELETE /api/integrations/slack        — disconnect

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const integrations = new Hono<{ Bindings: Env; Variables: Variables }>()

integrations.post('/slack', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    bot_token: string
    default_channel: string
    workspace_name?: string
  }>()

  if (!body.bot_token) return c.json({ error: 'bot_token is required' }, 400)
  if (!body.default_channel) return c.json({ error: 'default_channel is required' }, 400)

  const config = {
    bot_token: body.bot_token,
    default_channel: body.default_channel,
    workspace_name: body.workspace_name ?? null,
  }

  // Upsert — one Slack connection per org
  const { data: upserted, error } = await supabase
    .from('service_connections')
    .upsert(
      {
        organization_id: orgId,
        service_type: 'slack',
        auth_type: 'oauth',
        cf_secret_key: '',  // token stored in config JSONB, not CF secrets
        config,
        updated_by: userId,
        updated_by_email: email,
      },
      { onConflict: 'organization_id,service_type' }
    )
    .select('id, created_at, updated_at')
    .single()

  if (error) return c.json({ error: error.message }, 500)

  const isNew = upserted.created_at === upserted.updated_at
  await writeAuditLog(supabase, orgId, 'service_connection', upserted.id, isNew ? 'created' : 'updated', userId, {
    service_type: 'slack',
    workspace_name: config.workspace_name,
    default_channel: config.default_channel,
  })

  return c.json({ ok: true })
})

integrations.get('/slack', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data } = await supabase
    .from('service_connections')
    .select('config, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

  if (!data) return c.json({ connected: false })

  const cfg = data.config as Record<string, string> | null
  return c.json({
    connected: true,
    workspace_name: cfg?.workspace_name ?? null,
    default_channel: cfg?.default_channel ?? null,
    // never return the token
    updated_at: data.updated_at,
    updated_by_email: data.updated_by_email,
  })
})

integrations.delete('/slack', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data: existing } = await supabase
    .from('service_connections')
    .select('id')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

  const { error } = await supabase
    .from('service_connections')
    .delete()
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')

  if (error) return c.json({ error: error.message }, 500)

  if (existing) {
    await writeAuditLog(supabase, orgId, 'service_connection', existing.id, 'deleted', userId, { service_type: 'slack' })
  }

  return c.json({ ok: true })
})

export default integrations
