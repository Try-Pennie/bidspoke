import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidateWorkflowCache } from '../../engine/definition-loader'
import { pushWorkflowToGitHub } from '../../lib/github'
import { writeAuditLog } from '../../lib/audit'
import { executeWorkflow } from '../../engine/index'
import { deployCodeNodes } from '../../lib/code-node-deployer'
import type { WorkflowDefinition } from '../../types'

type Variables = AuthVariables

const workflows = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/workflows
workflows.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, description, is_active, created_at, updated_at, updated_by_email, updated_by_name')
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
      updated_by_name: c.get('user').name,
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
  const { orgId, userId, email, name } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name?: string; description?: string; definition?: unknown; message?: string; slack_channel?: string | null }>()

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
    updated_by_name: name,
  }
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.definition !== undefined) updates.definition = body.definition
  if (body.slack_channel !== undefined) updates.slack_channel = body.slack_channel

  const { data: updated, error: updateError } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (updateError) return c.json({ error: updateError.message }, 500)

  // Invalidate KV cache
  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)

  // Deploy code node scripts — run synchronously so errors surface in the save response
  const deployErrors: { namespace: string; error: string }[] = []
  if (body.definition) {
    const results = await deployCodeNodes(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN
    ).catch((e) => { console.error('[code-nodes] deploy failed:', e); return [] })
    for (const r of results) {
      if (r.error) deployErrors.push({ namespace: r.namespace, error: r.error })
    }
  }

  // Push definition to GitHub backup repo and store commit SHA on the version row (non-blocking)
  const workflowName = (updates.name as string | undefined) ?? (existing.definition as { name?: string } | null)?.name ?? id
  c.executionCtx.waitUntil(
    pushWorkflowToGitHub(
      c.env.GITHUB_TOKEN,
      c.env.GITHUB_REPO,
      id,
      workflowName,
      body.definition ?? existing.definition,
      nextVersion,
      body.message
    )
      .then((commitSha) => {
        if (!commitSha) return
        return supabase
          .from('workflow_versions')
          .update({ commit_sha: commitSha })
          .eq('id', version.id)
      })
      .catch((e) => console.error('[github] backup failed:', e))
  )

  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    version: nextVersion,
    changed_by_name: email,
  })

  return c.json({ ...updated, version_id: version.id, deploy_errors: deployErrors.length ? deployErrors : undefined })
})

// PATCH /api/workflows/:id — lightweight field updates (is_active) without creating a version snapshot
workflows.patch('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ is_active?: boolean }>()

  const { error: fetchError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (fetchError) return c.json({ error: 'Workflow not found' }, 404)

  const updates: Record<string, unknown> = { updated_by: userId, updated_by_email: email, updated_by_name: c.get('user').name }
  if (body.is_active !== undefined) updates.is_active = body.is_active

  const { data, error } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', id)
    .select('id, name, is_active, updated_at')
    .single()

  if (error) return c.json({ error: error.message }, 500)

  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    is_active: body.is_active,
    changed_by_name: email,
  })

  return c.json(data)
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

// PATCH /api/workflows/:id/test-payloads — replace the saved test payload array
workflows.patch('/:id/test-payloads', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ test_payloads: Array<{ name: string; payload: unknown }> }>()

  if (!Array.isArray(body.test_payloads)) {
    return c.json({ error: 'test_payloads must be an array' }, 400)
  }

  const { data, error } = await supabase
    .from('workflows')
    .update({ test_payloads: body.test_payloads })
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('test_payloads')
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
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
    .update({ definition: version.definition, updated_by: userId, updated_by_email: email, updated_by_name: c.get('user').name })
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
  const body = await c.req.json<{ payload: unknown; execution_id?: string; definition?: unknown }>()

  // Verify ownership
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  // Deploy any code nodes from the current (unsaved) definition so test runs the latest scripts
  if (body.definition) {
    await deployCodeNodes(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN
    ).catch((e) => console.error('[code-nodes] test deploy failed:', e))
  }

  const result = await executeWorkflow(
    {
      workflowId: id,
      payload: body.payload,
      source: 'test_runner',
      isTest: true,
      executionId: body.execution_id,
      ...(body.definition ? { definitionOverride: body.definition as import('../../types').WorkflowDefinition } : {}),
    },
    c.env,
    supabase,
    c.executionCtx
  )

  return c.json(result.response, result.status as 200 | 500, { 'X-Trace-Id': result.traceId })
})

export default workflows
