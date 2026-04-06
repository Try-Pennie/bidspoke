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

// GET /api/sources — return list of {name, key_preview} sorted by name
sources.get('/', (c) => {
  const map = parseKeyMap(c.env.API_KEY_MAP)
  // Invert: source name → list of masked keys
  const byName: Record<string, string[]> = {}
  for (const [key, name] of Object.entries(map)) {
    if (!byName[name]) byName[name] = []
    byName[name].push(key.slice(0, 8) + '…')
  }
  const result = Object.entries(byName)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, key_previews]) => ({ name, key_previews }))
  return c.json(result)
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
  await writeAuditLog(supabase, orgId, 'environment_variable', crypto.randomUUID(), 'created', userId, {
    source_name: name,
    action: 'api_key_created',
  })

  // Return the key once — it cannot be retrieved again
  return c.json({ name, api_key: apiKey }, 201)
})

// DELETE /api/sources/:name — revoke all keys for a source
sources.delete('/:name', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')

  const map = parseKeyMap(c.env.API_KEY_MAP)
  const before = Object.keys(map).length

  for (const [key, src] of Object.entries(map)) {
    if (src === name) delete map[key]
  }

  if (Object.keys(map).length === before) {
    return c.json({ error: 'Source not found' }, 404)
  }

  await setCfSecret('API_KEY_MAP', JSON.stringify(map), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)

  const supabase = createSupabaseClient(c.env)
  await writeAuditLog(supabase, orgId, 'environment_variable', crypto.randomUUID(), 'deleted', userId, {
    source_name: name,
    action: 'api_key_revoked',
  })

  return c.json({ ok: true })
})

export default sources
