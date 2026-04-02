import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidateWorkflowCache } from '../../engine/definition-loader'
import { writeAuditLog } from '../../lib/audit'
import { executeWorkflow } from '../../engine/index'

type Variables = AuthVariables

const workflows = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/workflows
workflows.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, description, is_active, created_at, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// POST /api/workflows
workflows.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name: string; description?: string; definition?: unknown }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)

  const { data, error } = await supabase
    .from('workflows')
    .insert({
      organization_id: orgId,
      name: body.name,
      description: body.description ?? null,
      definition: body.definition ?? { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } },
      is_active: true,
      created_by: userId,
      updated_by: userId,
      updated_by_email: c.get('user').email,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'workflow', data.id, 'created', userId)
  return c.json(data, 201)
})

// GET /api/workflows/:id
workflows.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', c.req.param('id') as string)
    .eq('organization_id', orgId)
    .single()

  if (error) return c.json({ error: 'Workflow not found' }, 404)
  return c.json(data)
})

// PUT /api/workflows/:id — save definition, create version snapshot, invalidate KV cache
workflows.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name?: string; description?: string; definition?: unknown; message?: string }>()

  // Verify ownership
  const { data: existing, error: fetchError } = await supabase
    .from('workflows')
    .select('id, definition')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (fetchError || !existing) return c.json({ error: 'Workflow not found' }, 404)

  // Get next version number
  const { data: lastVersion } = await supabase
    .from('workflow_versions')
    .select('version_number')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single()

  const nextVersion = ((lastVersion?.version_number as number) ?? 0) + 1

  // Create version snapshot
  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .insert({
      workflow_id: id,
      version_number: nextVersion,
      definition: body.definition ?? existing.definition,
      created_by: userId,
      message: body.message ?? null,
    })
    .select()
    .single()

  if (versionError) return c.json({ error: versionError.message }, 500)

  // Update workflow
  const updates: Record<string, unknown> = {
    updated_by: userId,
    updated_by_email: email,
  }
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.definition !== undefined) updates.definition = body.definition

  const { data: updated, error: updateError } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (updateError) return c.json({ error: updateError.message }, 500)

  // Invalidate KV cache
  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)

  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    version: nextVersion,
    changed_by_name: email,
  })

  return c.json({ ...updated, version_id: version.id })
})

// DELETE /api/workflows/:id
workflows.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { error } = await supabase
    .from('workflows')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return c.json({ error: error.message }, 500)

  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'deleted', userId)
  return c.json({ ok: true })
})

// GET /api/workflows/:id/versions
workflows.get('/:id/versions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  // Verify ownership first
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const { data, error } = await supabase
    .from('workflow_versions')
    .select('id, version_number, commit_sha, created_by, created_at, message')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// GET /api/workflows/:id/versions/:version_id
workflows.get('/:id/versions/:version_id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const versionId = c.req.param('version_id') as string
  const supabase = createSupabaseClient(c.env)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const { data, error } = await supabase
    .from('workflow_versions')
    .select('*')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .single()

  if (error) return c.json({ error: 'Version not found' }, 404)
  return c.json(data)
})

// POST /api/workflows/:id/versions/:version_id/restore
workflows.post('/:id/versions/:version_id/restore', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id') as string
  const versionId = c.req.param('version_id') as string
  const supabase = createSupabaseClient(c.env)

  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .select('definition, version_number')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .single()

  if (versionError || !version) return c.json({ error: 'Version not found' }, 404)

  // Restore = create a new version with the old definition
  const { data: lastVersion } = await supabase
    .from('workflow_versions')
    .select('version_number')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single()

  const nextVersion = ((lastVersion?.version_number as number) ?? 0) + 1

  await supabase.from('workflow_versions').insert({
    workflow_id: id,
    version_number: nextVersion,
    definition: version.definition,
    created_by: userId,
    message: `Restored from v${version.version_number}`,
  })

  await supabase
    .from('workflows')
    .update({ definition: version.definition, updated_by: userId, updated_by_email: email })
    .eq('id', id)

  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    restored_from_version: version.version_number,
    new_version: nextVersion,
  })

  return c.json({ ok: true, version_number: nextVersion })
})

// POST /api/workflows/:id/test
workflows.post('/:id/test', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ payload: unknown }>()

  // Verify ownership
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const result = await executeWorkflow(
    { workflowId: id, payload: body.payload, source: 'test_runner', isTest: true },
    c.env,
    supabase,
    c.executionCtx
  )

  return c.json(result.response, result.status as 200 | 500, { 'X-Trace-Id': result.traceId })
})

export default workflows
