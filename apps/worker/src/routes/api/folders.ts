// Folders — nested organizer for workflows
// GET    /api/folders        — list folders for the org (flat; client builds tree)
// POST   /api/folders        — create folder
// PATCH  /api/folders/:id    — rename or reparent (parent_id: null moves to root)
// DELETE /api/folders/:id    — delete if empty; 409 with child counts otherwise

import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, requireRowOr404 } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import type { Database } from '../../types/database'
import { formatErr } from '../../lib/format-error'
import { fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'

type Variables = AuthVariables

const folders = new Hono<{ Bindings: Env; Variables: Variables }>()

folders.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('folders')
      .select('id, organization_id, parent_id, name, created_at, updated_at')
      .eq('organization_id', orgId)
      .order('name')
      .limit(limit), CONFIG_LIST_BOUNDS.folders, 'folders list'))
  } catch (err) {
    return dbError(c, err)
  }
})

folders.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string; parent_id?: string | null }>()
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const supabase = createSupabaseClient(c.env)

  // Verify parent_id belongs to this org if provided
  if (body.parent_id) {
    const { data: parent, error: parentErr } = await supabase
      .from('folders')
      .select('id')
      .eq('id', body.parent_id)
      .eq('organization_id', orgId)
      .single()
    const parentBlocked = dbErrorUnlessNotFound(c, parentErr)
    if (parentBlocked) return parentBlocked
    if (!parent) return c.json({ error: 'parent folder not found' }, 404)
  }

  const { data, error } = await supabase
    .from('folders')
    .insert({
      organization_id: orgId,
      parent_id: body.parent_id ?? null,
      name,
    })
    .select('id, organization_id, parent_id, name, created_at, updated_at')
    .single()
  if (error) return dbError(c, error)

  await writeAuditLog(supabase, orgId, 'folder', data.id, 'created', userId, {
    name: data.name,
    parent_id: data.parent_id,
  })

  return c.json(data, 201)
})

folders.patch('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; parent_id?: string | null }>()

  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: existingErr } = await supabase
    .from('folders')
    .select('id, name, parent_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const existingBlocked = dbErrorUnlessNotFound(c, existingErr)
  if (existingBlocked) return existingBlocked
  if (!existing) return c.json({ error: 'folder not found' }, 404)

  const patch: Database['public']['Tables']['folders']['Update'] = {}
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) return c.json({ error: 'name cannot be empty' }, 400)
    patch.name = trimmed
  }
  if ('parent_id' in body) {
    if (body.parent_id === null) {
      patch.parent_id = null
    } else {
      const { data: parent, error: parentErr } = await supabase
        .from('folders')
        .select('id')
        .eq('id', body.parent_id as string)
        .eq('organization_id', orgId)
        .single()
      const parentBlocked = dbErrorUnlessNotFound(c, parentErr)
      if (parentBlocked) return parentBlocked
      if (!parent) return c.json({ error: 'parent folder not found' }, 404)
      patch.parent_id = body.parent_id
    }
  }

  if (Object.keys(patch).length === 0) return c.json(existing)

  const { data, error } = await supabase
    .from('folders')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, organization_id, parent_id, name, created_at, updated_at')
    .single()
  // Cycle trigger raises a SQLSTATE the supabase-js layer surfaces as message.
  // It is a real database error, so it is read before dbErrorUnlessNotFound
  // turns every non-PGRST116 error into a 500.
  if (error?.message?.includes('cycle')) return c.json({ error: 'cannot move a folder into one of its descendants' }, 400)
  const updateBlocked = dbErrorUnlessNotFound(c, error)
  if (updateBlocked) return updateBlocked
  if (!data) return c.json({ error: 'folder not found' }, 404)

  await writeAuditLog(supabase, orgId, 'folder', id, 'updated', userId, {
    before: { name: existing.name, parent_id: existing.parent_id },
    after: { name: data.name, parent_id: data.parent_id },
  })

  return c.json(data)
})

folders.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')

  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: existingErr } = await supabase
    .from('folders')
    .select('id, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const existingBlocked = dbErrorUnlessNotFound(c, existingErr)
  if (existingBlocked) return existingBlocked
  if (!existing) return c.json({ error: 'folder not found' }, 404)

  // The emptiness test that gates a destructive delete, so both halves have to
  // be true before it runs (#877).
  //
  // `deleted_at IS NULL` on the workflow count: `workflows` has been soft-deleted
  // for a long time, so counting tombstones meant a folder whose only remaining
  // contents were already-deleted workflows could never be deleted, and the page
  // said "folder not empty" about a folder that looked empty on screen. Nothing
  // is blocked by this in production today (0 of 33 soft-deleted workflows carry
  // a folder_id, measured 2026-08-21), which is why it went unnoticed. The
  // folders count gets the same filter the moment folders gain the column.
  const [childFolderCount, childWorkflowCount] = await Promise.all([
    supabase.from('folders').select('id', { count: 'exact', head: true }).eq('parent_id', id),
    supabase
      .from('workflows')
      .select('id', { count: 'exact', head: true })
      .eq('folder_id', id)
      .is('deleted_at', null),
  ])

  // Fail closed, and separately per count. `count` is null on a failed query and
  // `?? 0` read that as "no children", so a folder WITH contents was deleted
  // because the query that would have found them failed. An error state is not
  // an empty state (L10), and each count needs its own boundary or one answers
  // for the other (L73).
  for (const [what, result] of [
    ['child folders', childFolderCount],
    ['child workflows', childWorkflowCount],
  ] as const) {
    if (result.error || result.count === null || result.count === undefined) {
      console.error(`[folders] delete refused: ${what} count failed`, result.error)
      return c.json(
        {
          error: `Could not count ${what}, so this folder was not deleted. Nothing was changed.`,
          details: result.error ? formatErr(result.error) : 'the count came back empty',
        },
        500,
      )
    }
  }

  const childFolders = childFolderCount.count
  const childWorkflows = childWorkflowCount.count

  if ((childFolders ?? 0) > 0 || (childWorkflows ?? 0) > 0) {
    return c.json(
      {
        error: 'folder not empty',
        child_folders: childFolders ?? 0,
        child_workflows: childWorkflows ?? 0,
      },
      409
    )
  }

  const deleteBlocked = await requireRowOr404(c, 'folder not found', () =>
    supabase.from('folders').delete().eq('id', id).eq('organization_id', orgId).select('id')
  )
  if (deleteBlocked) return deleteBlocked

  await writeAuditLog(supabase, orgId, 'folder', id, 'deleted', userId, { name: existing.name })

  return c.json({ ok: true })
})

export default folders
