// Env var folders — nested organizer for environment_variables
// GET    /api/env-folders        — list folders for the org
// POST   /api/env-folders        — create folder
// PATCH  /api/env-folders/:id    — rename or reparent (parent_id: null moves to root)
// DELETE /api/env-folders/:id    — delete if empty; 409 with child counts otherwise

import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const envFolders = new Hono<{ Bindings: Env; Variables: Variables }>()

envFolders.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('env_var_folders')
    .select('id, organization_id, parent_id, name, created_at, updated_at')
    .eq('organization_id', orgId)
    .order('name')
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

envFolders.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string; parent_id?: string | null }>()
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const supabase = createSupabaseClient(c.env)

  if (body.parent_id) {
    const { data: parent } = await supabase
      .from('env_var_folders')
      .select('id')
      .eq('id', body.parent_id)
      .eq('organization_id', orgId)
      .single()
    if (!parent) return c.json({ error: 'parent folder not found' }, 404)
  }

  const { data, error } = await supabase
    .from('env_var_folders')
    .insert({
      organization_id: orgId,
      parent_id: body.parent_id ?? null,
      name,
    })
    .select('id, organization_id, parent_id, name, created_at, updated_at')
    .single()
  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'env_var_folder', data.id, 'created', userId, {
    name: data.name,
    parent_id: data.parent_id,
  })

  return c.json(data, 201)
})

envFolders.patch('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; parent_id?: string | null }>()

  const supabase = createSupabaseClient(c.env)

  const { data: existing } = await supabase
    .from('env_var_folders')
    .select('id, name, parent_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!existing) return c.json({ error: 'folder not found' }, 404)

  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) return c.json({ error: 'name cannot be empty' }, 400)
    patch.name = trimmed
  }
  if ('parent_id' in body) {
    if (body.parent_id === null) {
      patch.parent_id = null
    } else {
      const { data: parent } = await supabase
        .from('env_var_folders')
        .select('id')
        .eq('id', body.parent_id)
        .eq('organization_id', orgId)
        .single()
      if (!parent) return c.json({ error: 'parent folder not found' }, 404)
      patch.parent_id = body.parent_id
    }
  }

  if (Object.keys(patch).length === 0) return c.json(existing)

  const { data, error } = await supabase
    .from('env_var_folders')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, organization_id, parent_id, name, created_at, updated_at')
    .single()
  if (error) {
    if (error.message?.includes('cycle')) return c.json({ error: 'cannot move a folder into one of its descendants' }, 400)
    return c.json({ error: error.message }, 500)
  }

  await writeAuditLog(supabase, orgId, 'env_var_folder', id, 'updated', userId, {
    before: { name: existing.name, parent_id: existing.parent_id },
    after: { name: data.name, parent_id: data.parent_id },
  })

  return c.json(data)
})

envFolders.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')

  const supabase = createSupabaseClient(c.env)

  const { data: existing } = await supabase
    .from('env_var_folders')
    .select('id, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!existing) return c.json({ error: 'folder not found' }, 404)

  const [{ count: childFolders }, { count: childVars }] = await Promise.all([
    supabase.from('env_var_folders').select('id', { count: 'exact', head: true }).eq('parent_id', id),
    supabase.from('environment_variables').select('id', { count: 'exact', head: true }).eq('folder_id', id),
  ])

  if ((childFolders ?? 0) > 0 || (childVars ?? 0) > 0) {
    return c.json(
      {
        error: 'folder not empty',
        child_folders: childFolders ?? 0,
        child_variables: childVars ?? 0,
      },
      409
    )
  }

  const { error } = await supabase.from('env_var_folders').delete().eq('id', id).eq('organization_id', orgId)
  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'env_var_folder', id, 'deleted', userId, { name: existing.name })

  return c.json({ ok: true })
})

export default envFolders
