// Integrations management — Slack connection (Phase 1.7), others (Phase 3)
// POST   /api/integrations/slack/resolve — validate token, return workspace name + channel list
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

integrations.post('/slack/resolve', async (c) => {
  const body = await c.req.json<{ bot_token: string }>()
  if (!body.bot_token) return c.json({ error: 'bot_token is required' }, 400)

  const token = body.bot_token.trim()

  const authRes = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const authData = await authRes.json() as { ok: boolean; team?: string; error?: string }
  if (!authData.ok) {
    return c.json({ error: `Invalid token: ${authData.error ?? 'auth.test failed'}` }, 400)
  }

  const chanRes = await fetch(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=1000',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const chanData = await chanRes.json() as {
    ok: boolean
    channels?: Array<{ id: string; name: string }>
    error?: string
  }

  const channels = chanData.ok
    ? (chanData.channels ?? []).map((ch) => ({ id: ch.id, name: ch.name })).sort((a, b) => a.name.localeCompare(b.name))
    : []

  return c.json({ workspace_name: authData.team ?? '', channels })
})

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

  const cfg = data.config as Record<string, unknown> | null
  return c.json({
    connected: true,
    workspace_name: (cfg?.workspace_name as string | undefined) ?? null,
    default_channel: (cfg?.default_channel as string | undefined) ?? null,
    // Default true so existing connections keep getting volume alerts.
    volume_alerts_enabled: cfg?.volume_alerts_enabled !== false,
    // never return the token
    updated_at: data.updated_at,
    updated_by_email: data.updated_by_email,
  })
})

// PATCH /api/integrations/slack/settings — toggle alert preferences without re-uploading the bot token
integrations.patch('/slack/settings', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ volume_alerts_enabled?: boolean }>()

  const { data: existing } = await supabase
    .from('service_connections')
    .select('id, config')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

  if (!existing) return c.json({ error: 'Slack is not connected' }, 404)

  const nextConfig = {
    ...((existing.config as Record<string, unknown> | null) ?? {}),
    ...(body.volume_alerts_enabled !== undefined ? { volume_alerts_enabled: body.volume_alerts_enabled } : {}),
  }

  const { error } = await supabase
    .from('service_connections')
    .update({ config: nextConfig, updated_by: userId })
    .eq('id', existing.id)

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'service_connection', existing.id, 'updated', userId, {
    service_type: 'slack',
    volume_alerts_enabled: body.volume_alerts_enabled,
  })

  return c.json({ ok: true })
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
