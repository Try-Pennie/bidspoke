// Source API key management
// GET    /api/sources        — list sources (keys masked)
// POST   /api/sources        — create new source, returns key once
// DELETE /api/sources/:name  — revoke all keys for a source

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { setCfSecret } from '../../lib/cf-secrets'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const sources = new Hono<{ Bindings: Env; Variables: Variables }>()

function parseKeyMap(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

// GET /api/sources — return list of {name, api_key} from Supabase
sources.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('api_sources')
    .select('name, api_key, created_at')
    .eq('organization_id', orgId)
    .order('name')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// POST /api/sources — body: { name: string }
sources.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)
  const name = body.name.trim().toLowerCase().replace(/\s+/g, '_')

  const map = parseKeyMap(c.env.API_KEY_MAP)

  // Check name not already in use
  if (Object.values(map).includes(name)) {
    return c.json({ error: `Source "${name}" already exists` }, 409)
  }

  // Generate a 32-char hex key
  const keyBytes = crypto.getRandomValues(new Uint8Array(16))
  const apiKey = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  map[apiKey] = name
  try {
    await setCfSecret('API_KEY_MAP', JSON.stringify(map), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update API_KEY_MAP secret' }, 500)
  }

  const supabase = createSupabaseClient(c.env)
  const { error: insertError } = await supabase
    .from('api_sources')
    .insert({ organization_id: orgId, name, api_key: apiKey })
  if (insertError) return c.json({ error: insertError.message }, 500)

  await writeAuditLog(supabase, orgId, 'environment_variable', crypto.randomUUID(), 'created', userId, {
    source_name: name,
    action: 'api_key_created',
  })

  return c.json({ name, api_key: apiKey }, 201)
})

// DELETE /api/sources/:name — revoke all keys for a source
sources.delete('/:name', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')

  const supabase = createSupabaseClient(c.env)

  // Use Supabase as the authoritative existence check
  const { data: existing } = await supabase
    .from('api_sources')
    .select('name')
    .eq('organization_id', orgId)
    .eq('name', name)
    .single()

  if (!existing) return c.json({ error: 'Source not found' }, 404)

  // Best-effort: remove from API_KEY_MAP secret (no-op locally if credentials not set)
  const map = parseKeyMap(c.env.API_KEY_MAP ?? '{}')
  for (const [key, src] of Object.entries(map)) {
    if (src === name) delete map[key]
  }
  await setCfSecret('API_KEY_MAP', JSON.stringify(map), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)

  await supabase.from('api_sources').delete().eq('organization_id', orgId).eq('name', name)

  await writeAuditLog(supabase, orgId, 'environment_variable', crypto.randomUUID(), 'deleted', userId, {
    source_name: name,
    action: 'api_key_revoked',
  })

  return c.json({ ok: true })
})

export default sources
