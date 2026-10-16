// Integrations management: the Slack connection (Phase 1.7).
// POST   /api/integrations/slack/resolve   validate a token, return the workspace name and channel list
// POST   /api/integrations/slack           save or replace the Slack connection
// GET    /api/integrations/slack           the current Slack connection (token never returned)
// GET    /api/integrations/slack/channels  search channels by name
// PATCH  /api/integrations/slack/settings  alert toggles and channels
// DELETE /api/integrations/slack           disconnect
//
// The saved Slack copy (#2060): alerts post from an encrypted copy of every
// org's connection while the database is down (lib/slack-copy.ts). POST, PATCH
// and DELETE each edit that org's entry in the copy with editSlackCopyEntry,
// after the database write and after the audit row, so an outage does not post
// to a connection just removed or a category just switched off. The audit row
// comes first because it records the change that happened in the database: a
// request cut off between the two loses at worst the copy edit, which the next
// healthy minute repairs, never the record of the change. The edit leaves the
// copy's save time alone (see editSlackCopyEntry).
//
// When KV refuses the edit, the change still answers 200, because it WAS saved
// and recorded, with stored_copy_warning beside it (lib/stored-copy.ts) and the
// failure logged; everything the edit needs (the key ring included) is read
// inside copyCleared, so nothing about the copy can fail the request. A copy no
// reader can decrypt is left alone without a warning, since nobody can post
// from it. The next minute the database probe's read answers rewrites the whole
// copy from the database (database-reachability.ts), which bounds how long a
// stale entry can last while the database is up. KV is eventually consistent,
// so a reader in another location can still see the old entry for up to about
// a minute.

import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, requireRowOr404, rowsTouched } from '../../lib/api-error'
import { fetchJson } from '../../lib/json'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { editSlackCopyEntry } from '../../lib/slack-copy'
import { parseSlackConnection } from '../../lib/slack-connection'
import { secretKeys } from '../../lib/secret-crypto'

type Variables = AuthVariables

const integrations = new Hono<{ Bindings: Env; Variables: Variables }>()

integrations.post('/slack/resolve', async (c) => {
  const body = await c.req.json<{ bot_token: string }>()
  if (!body.bot_token) return c.json({ error: 'bot_token is required' }, 400)

  const token = body.bot_token.trim()

  const authData = await fetchJson<{ ok: boolean; team?: string; error?: string }>(
    'https://slack.com/api/auth.test',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }
  )
  if (!authData.ok) {
    return c.json({ error: `Invalid token: ${authData.error ?? 'auth.test failed'}` }, 400)
  }

  const chanData = await fetchJson<{
    ok: boolean
    channels?: Array<{ id: string; name: string }>
    error?: string
  }>(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=1000',
    { headers: { Authorization: `Bearer ${token}` } }
  )

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

  if (error) return dbError(c, error)

  const isNew = upserted.created_at === upserted.updated_at
  await writeAuditLog(supabase, orgId, 'service_connection', upserted.id, isNew ? 'created' : 'updated', userId, {
    service_type: 'slack',
    workspace_name: config.workspace_name,
    default_channel: config.default_channel,
  })

  const copyEdited = await copyCleared(
    () => editSlackCopyEntry(c.env.IDEMPOTENCY, secretKeys(c.env), orgId, parseSlackConnection(config)).then(() => undefined),
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
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
    matrix_alerts_enabled: cfg?.matrix_alerts_enabled !== false,
    config_alerts_enabled: cfg?.config_alerts_enabled !== false,
    backup_alerts_enabled: cfg?.backup_alerts_enabled !== false,
    matrix_alerts_channel: (cfg?.matrix_alerts_channel as string | undefined) ?? null,
    // never return the token
    updated_at: data.updated_at,
    updated_by_email: data.updated_by_email,
  })
})

// GET /api/integrations/slack/channels?q=foo — search channels by name substring.
// Requires q (>= 3 chars). Slack's conversations.list has no native query param,
// so we paginate through the workspace and filter server-side. Capped at 50 matches
// to keep the UI responsive on large workspaces.
integrations.get('/slack/channels', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (q.length < 3) return c.json({ channels: [] })

  const { data } = await supabase
    .from('service_connections')
    .select('config')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

  const cfg = data?.config as Record<string, unknown> | null
  const token = typeof cfg?.bot_token === 'string' ? cfg.bot_token : null
  if (!token) return c.json({ error: 'Slack is not connected' }, 404)

  const matches: Array<{ id: string; name: string }> = []
  const MAX_MATCHES = 50
  const MAX_PAGES = 20  // 20 pages × 1000 = 20k channels ceiling
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://slack.com/api/conversations.list')
    url.searchParams.set('types', 'public_channel,private_channel')
    url.searchParams.set('exclude_archived', 'true')
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)

    const chanData = await fetchJson<{
      ok: boolean
      channels?: Array<{ id: string; name: string }>
      response_metadata?: { next_cursor?: string }
      error?: string
    }>(url.toString(), { headers: { Authorization: `Bearer ${token}` } })

    if (!chanData.ok) return c.json({ error: `Slack API error: ${chanData.error ?? 'unknown'}` }, 502)

    for (const ch of chanData.channels ?? []) {
      if (ch.name.toLowerCase().includes(q)) {
        matches.push({ id: ch.id, name: ch.name })
        if (matches.length >= MAX_MATCHES) break
      }
    }

    if (matches.length >= MAX_MATCHES) break
    cursor = chanData.response_metadata?.next_cursor
    if (!cursor) break
  }

  matches.sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ channels: matches })
})

// PATCH /api/integrations/slack/settings — toggle alert preferences or change the
// default channel without re-uploading the bot token.
integrations.patch('/slack/settings', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ volume_alerts_enabled?: boolean; default_channel?: string; matrix_alerts_enabled?: boolean; matrix_alerts_channel?: string | null; config_alerts_enabled?: boolean; backup_alerts_enabled?: boolean }>()

  const { data: existing, error: existingErr } = await supabase
    .from('service_connections')
    .select('id, config')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

  const existingBlocked = dbErrorUnlessNotFound(c, existingErr)
  if (existingBlocked) return existingBlocked
  if (!existing) return c.json({ error: 'Slack is not connected' }, 404)

  const nextConfig = {
    ...((existing.config as Record<string, unknown> | null) ?? {}),
    ...(body.volume_alerts_enabled !== undefined ? { volume_alerts_enabled: body.volume_alerts_enabled } : {}),
    ...(body.default_channel ? { default_channel: body.default_channel } : {}),
    ...(body.matrix_alerts_enabled !== undefined ? { matrix_alerts_enabled: body.matrix_alerts_enabled } : {}),
    ...(body.matrix_alerts_channel !== undefined ? { matrix_alerts_channel: body.matrix_alerts_channel || null } : {}),
    ...(body.config_alerts_enabled !== undefined ? { config_alerts_enabled: body.config_alerts_enabled } : {}),
    ...(body.backup_alerts_enabled !== undefined ? { backup_alerts_enabled: body.backup_alerts_enabled } : {}),
  }

  const updateBlocked = await requireRowOr404(c, 'Slack is not connected', () =>
    supabase
      .from('service_connections')
      .update({ config: nextConfig, updated_by: userId })
      .eq('id', existing.id)
      .eq('organization_id', orgId)
      .select('id')
  )
  if (updateBlocked) return updateBlocked

  await writeAuditLog(supabase, orgId, 'service_connection', existing.id, 'updated', userId, {
    service_type: 'slack',
    volume_alerts_enabled: body.volume_alerts_enabled,
    default_channel: body.default_channel,
    matrix_alerts_enabled: body.matrix_alerts_enabled,
    matrix_alerts_channel: body.matrix_alerts_channel,
    config_alerts_enabled: body.config_alerts_enabled,
    backup_alerts_enabled: body.backup_alerts_enabled,
  })

  const copyEdited = await copyCleared(
    () => editSlackCopyEntry(c.env.IDEMPOTENCY, secretKeys(c.env), orgId, parseSlackConnection(nextConfig)).then(() => undefined),
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
})

integrations.delete('/slack', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  // Disconnecting a Slack that was never connected is a no-op, not an error, so
  // this stays 200. The audit row is gated on the rows the delete actually
  // removed rather than on a prior read that can race it, which also lets that
  // read go away entirely (#588).
  const { rows, blocked } = await rowsTouched<{ id: string }>(c, 'service_connections.slack_disconnect', () =>
    supabase.from('service_connections').delete().eq('organization_id', orgId).eq('service_type', 'slack').select('id')
  )
  if (blocked) return blocked

  const removed = rows[0]
  if (removed) {
    await writeAuditLog(supabase, orgId, 'service_connection', removed.id, 'deleted', userId, { service_type: 'slack' })
  }

  // Removed from the copy even when the delete matched no row: the database now
  // holds no connection for this org, so neither should the copy.
  const copyEdited = await copyCleared(
    () => editSlackCopyEntry(c.env.IDEMPOTENCY, secretKeys(c.env), orgId, null).then(() => undefined),
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
})

export default integrations
