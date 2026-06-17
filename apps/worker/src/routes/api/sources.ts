// Source API key management
// GET    /api/sources        — list sources, including the full api_key. Keys are
//                              org-scoped (a user only sees their own org's) and
//                              power the Sources page reveal/copy + curl example.
//                              Intra-org visibility is acceptable for this team.
// POST   /api/sources        — create new source, returns the new api_key
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

// Rebuild the global API_KEY_MAP from the api_sources table (the authoritative
// record of every UI-managed key) rather than read-modify-writing the c.env
// snapshot. The snapshot is point-in-time, so two concurrent mutations — or one
// issued before a prior setCfSecret reaches the isolate — would clobber each
// other and silently drop an unrelated source's key. Deriving from the table on
// every mutation makes each write reflect the current DB state.
//
// Keys present in the live secret but NOT in the table (manually-seeded keys,
// which have no org association and can't live in api_sources) are preserved.
// `removeKeys` drops specific keys from the result even though they may still be
// in the table — used on delete to revoke the key before the row is removed.
async function rebuildKeyMap(
  supabase: ReturnType<typeof createSupabaseClient>,
  currentEnvMap: Record<string, string>,
  removeKeys: Set<string> = new Set(),
): Promise<Record<string, string>> {
  const { data } = await supabase.from('api_sources').select('name, api_key')
  const rows = (data ?? []) as { name: string; api_key: string }[]
  const dbMap: Record<string, string> = {}
  const dbKeys = new Set<string>()
  for (const r of rows) {
    dbMap[r.api_key] = r.name
    dbKeys.add(r.api_key)
  }
  const preserved: Record<string, string> = {}
  for (const [k, v] of Object.entries(currentEnvMap)) {
    if (!dbKeys.has(k)) preserved[k] = v
  }
  const merged: Record<string, string> = { ...preserved, ...dbMap }
  for (const k of removeKeys) delete merged[k]
  return merged
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

// POST /api/sources — body: { name: string, assign_workflow_id?: string }
sources.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string; assign_workflow_id?: string }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)
  // Enforce the charset (lowercase, numbers, underscores). Source names are
  // interpolated into API paths and used as trigger.source, so URL-breaking
  // characters must never reach the DB (#100). Mirror of web sanitizeSourceName.
  const name = body.name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!name) return c.json({ error: 'name must contain a letter, number, or underscore' }, 400)

  // Generate a 32-char hex key
  const keyBytes = crypto.getRandomValues(new Uint8Array(16))
  const apiKey = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  const supabase = createSupabaseClient(c.env)

  // Insert first so the rebuilt map (derived from the table) includes the new
  // source. UNIQUE(organization_id, name) enforces uniqueness race-free.
  const { data: created, error: insertError } = await supabase
    .from('api_sources')
    .insert({ organization_id: orgId, name, api_key: apiKey })
    .select('id')
    .single()
  if (insertError) {
    if (insertError.code === '23505') return c.json({ error: `Source "${name}" already exists` }, 409)
    return c.json({ error: insertError.message }, 500)
  }

  const newMap = await rebuildKeyMap(supabase, parseKeyMap(c.env.API_KEY_MAP ?? '{}'))
  try {
    await setCfSecret('API_KEY_MAP', JSON.stringify(newMap), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  } catch (err) {
    // Roll back so a half-created source (in the table but not the auth map)
    // doesn't linger and block re-creation with a 409.
    await supabase.from('api_sources').delete().eq('organization_id', orgId).eq('name', name)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update API_KEY_MAP secret' }, 500)
  }

  await writeAuditLog(supabase, orgId, 'api_source', (created as { id: string }).id, 'created', userId, {
    source_name: name,
    action: 'api_key_created',
  })

  // Optional one-shot assignment — used by the trigger panel so a new key
  // is immediately scoped to the workflow the user is configuring.
  if (body.assign_workflow_id) {
    await supabase.from('source_workflow_assignments').upsert(
      { organization_id: orgId, source_name: name, workflow_id: body.assign_workflow_id },
      { onConflict: 'organization_id,source_name,workflow_id' }
    )
  }

  return c.json({ name, api_key: apiKey }, 201)
})

// GET /api/sources/assignments — bulk list of all (source_name, workflow_id) assignments in org
sources.get('/assignments', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('source_workflow_assignments')
    .select('source_name, workflow_id')
    .eq('organization_id', orgId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

// GET /api/sources/:name/workflows — list workflow_ids assigned to this source
sources.get('/:name/workflows', async (c) => {
  const { orgId } = c.get('user')
  const name = c.req.param('name')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('source_workflow_assignments')
    .select('workflow_id')
    .eq('organization_id', orgId)
    .eq('source_name', name)
  if (error) return c.json({ error: error.message }, 500)
  return c.json((data ?? []).map((r) => r.workflow_id))
})

// POST /api/sources/:name/workflows — body: { workflow_id }
sources.post('/:name/workflows', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')
  const body = await c.req.json<{ workflow_id: string }>()
  if (!body.workflow_id) return c.json({ error: 'workflow_id is required' }, 400)

  const supabase = createSupabaseClient(c.env)

  // Verify the source exists in this org
  const { data: src } = await supabase
    .from('api_sources')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('name', name)
    .single()
  if (!src) return c.json({ error: 'Source not found' }, 404)

  // Verify the workflow belongs to this org
  const { data: wf } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', body.workflow_id)
    .eq('organization_id', orgId)
    .single()
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  const { error: insertError } = await supabase
    .from('source_workflow_assignments')
    .upsert(
      { organization_id: orgId, source_name: name, workflow_id: body.workflow_id },
      { onConflict: 'organization_id,source_name,workflow_id' }
    )
  if (insertError) return c.json({ error: insertError.message }, 500)

  await writeAuditLog(supabase, orgId, 'api_source', (src as { id: string }).id, 'updated', userId, {
    source_name: name,
    workflow_id: body.workflow_id,
    action: 'source_assigned_to_workflow',
  })

  return c.json({ ok: true }, 201)
})

// DELETE /api/sources/:name/workflows/:workflow_id — unassign
sources.delete('/:name/workflows/:workflow_id', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')
  const workflowId = c.req.param('workflow_id')

  const supabase = createSupabaseClient(c.env)
  const { error } = await supabase
    .from('source_workflow_assignments')
    .delete()
    .eq('organization_id', orgId)
    .eq('source_name', name)
    .eq('workflow_id', workflowId)
  if (error) return c.json({ error: error.message }, 500)

  const { data: src } = await supabase
    .from('api_sources')
    .select('id')
    .eq('organization_id', orgId)
    .eq('name', name)
    .single()
  await writeAuditLog(supabase, orgId, 'api_source', (src as { id: string } | null)?.id ?? workflowId, 'updated', userId, {
    source_name: name,
    workflow_id: workflowId,
    action: 'source_unassigned_from_workflow',
  })

  return c.json({ ok: true })
})

// DELETE /api/sources/:name — revoke all keys for a source
sources.delete('/:name', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')

  const supabase = createSupabaseClient(c.env)

  // Authoritative existence check + grab the id and key(s) being revoked.
  const { data: existingRows } = await supabase
    .from('api_sources')
    .select('id, api_key')
    .eq('organization_id', orgId)
    .eq('name', name)

  if (!existingRows || existingRows.length === 0) return c.json({ error: 'Source not found' }, 404)
  const rows = existingRows as { id: string; api_key: string }[]
  const deletedKeys = new Set(rows.map((r) => r.api_key))
  const sourceId = rows[0].id

  // Revoke first: rebuild the map from the table minus the deleted key(s), so
  // auth is cut before the row is removed and a stale-snapshot read-modify-write
  // can't drop an unrelated source's key. Manual keys are preserved.
  const newMap = await rebuildKeyMap(supabase, parseKeyMap(c.env.API_KEY_MAP ?? '{}'), deletedKeys)
  await setCfSecret('API_KEY_MAP', JSON.stringify(newMap), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)

  await supabase.from('api_sources').delete().eq('organization_id', orgId).eq('name', name)

  await writeAuditLog(supabase, orgId, 'api_source', sourceId, 'deleted', userId, {
    source_name: name,
    action: 'api_key_revoked',
  })

  return c.json({ ok: true })
})

export default sources
