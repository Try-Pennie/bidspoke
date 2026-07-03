import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, isNotFoundError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidateWorkflowCache } from '../../engine/definition-loader'
import { detectCycle } from '../../engine/graph'
import { pushWorkflowToGitHub } from '../../lib/github'
import { recordBackupSuccess, recordBackupFailure } from '../../lib/github-backup-alert'
import { writeAuditLog } from '../../lib/audit'
import { executeWorkflow } from '../../engine/index'
import { executeNode } from '../../engine/nodes/index'
import { buildContext } from '../../engine/context'
import { formatCodeErrorMessage } from '../../engine/error-classifier'
import { loadEnvVars } from '../../lib/env-loader'
import { deployCodeNodes, deployTestCodeBundle, deleteTestBundles } from '../../lib/code-node-deployer'
import { computeDiff, diffIsEmpty, draftChangelog, getAnthropicKey, hashDefinition } from '../../lib/changelog-drafter'
import { DEFAULT_RETRIES, SUGGESTION_MIN_SAMPLE, suggestedTimeoutMs } from '../../lib/timeout-suggestion'
import { collectWorkflowDurationStats } from '../../lib/timeout-audit'
import type { WorkflowDefinition, StepOutput } from '../../types'
import { asJson } from '../../lib/json'

type Variables = AuthVariables

const workflows = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/workflows
workflows.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, description, is_active, capture_sightings, folder_id, created_at, updated_at, updated_by_email, updated_by_name')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (error) return dbError(c, error)
  return c.json(data)
})

// POST /api/workflows
workflows.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name: string; description?: string; definition?: unknown; folder_id?: string | null }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)

  if (body.folder_id) {
    const { data: folder, error: folderError } = await supabase
      .from('folders')
      .select('id')
      .eq('id', body.folder_id)
      .eq('organization_id', orgId)
      .single()
    if (folderError && !isNotFoundError(folderError)) return dbError(c, folderError)
    if (!folder) return c.json({ error: 'folder not found' }, 404)
  }

  const { data, error } = await supabase
    .from('workflows')
    .insert({
      organization_id: orgId,
      name: body.name,
      description: body.description ?? null,
      definition: asJson(body.definition ?? { nodes: [], edges: [], trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } }),
      is_active: true,
      folder_id: body.folder_id ?? null,
      created_by: userId,
      updated_by: userId,
      updated_by_email: c.get('user').email,
      updated_by_name: c.get('user').name,
    })
    .select()
    .single()

  if (error) return dbError(c, error)

  await writeAuditLog(supabase, orgId, 'workflow', data.id, 'created', userId)
  return c.json(data, 201)
})

// POST /api/workflows/:id/duplicate — clone a workflow with its full version history
//
// Unlike a client-side "GET then create", this copies every workflow_versions row
// so the clone is a faithful starting point: the revision timeline reads identically
// and the next save continues from the right version number (rather than restarting
// at v1). The workflow's current `definition` is always the latest saved state, so
// copying it carries the most recent edits too. (A separate draft/undeployed concept
// doesn't exist yet — see the staging-vs-prod issue — so there's nothing more to carry.)
workflows.post('/:id/duplicate', async (c) => {
  const { orgId, userId, email, name } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Load source (org-scoped)
  const { data: source, error: sourceErr } = await supabase
    .from('workflows')
    .select('name, description, definition, folder_id, is_active')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (sourceErr || !source) return c.json({ error: 'Workflow not found' }, 404)

  // Create the clone. is_active mirrors the source — a clone has no source
  // assignments or custom endpoints pointing at it, so it can't receive live
  // traffic regardless until the user wires routing.
  const { data: clone, error: createErr } = await supabase
    .from('workflows')
    .insert({
      organization_id: orgId,
      name: `${source.name} (copy)`,
      description: source.description ?? null,
      definition: source.definition,
      is_active: source.is_active,
      folder_id: source.folder_id ?? null,
      created_by: userId,
      updated_by: userId,
      updated_by_email: email,
      updated_by_name: name,
    })
    .select()
    .single()

  if (createErr || !clone) return c.json({ error: createErr?.message ?? 'Failed to create copy' }, 500)

  // Copy the full version history. Preserve version_number, created_at, message,
  // commit_sha, and created_by so the timeline is identical and the next save
  // increments from the source's latest version.
  const { data: versions } = await supabase
    .from('workflow_versions')
    .select('version_number, definition, commit_sha, created_by, created_at, message')
    .eq('workflow_id', id)
    .order('version_number', { ascending: true })

  if (versions && versions.length > 0) {
    const rows = versions.map((v) => ({
      workflow_id: clone.id,
      version_number: v.version_number,
      definition: v.definition,
      commit_sha: v.commit_sha,
      created_by: v.created_by,
      created_at: v.created_at,
      message: v.message,
    }))
    const { error: versionsErr } = await supabase.from('workflow_versions').insert(rows)
    if (versionsErr) console.error('[duplicate] version history copy failed:', versionsErr.message)
  } else {
    // Source never had a saved version (created but not yet saved). Seed v1 from
    // the current definition so the clone has a baseline snapshot, matching what
    // a first save produces.
    await supabase.from('workflow_versions').insert({
      workflow_id: clone.id,
      version_number: 1,
      definition: source.definition,
      created_by: userId,
      message: `Duplicated from ${source.name}`,
    })
  }

  // Deploy the clone's code-node bundle. Bundles are keyed per workflow id, so
  // the source's bundle doesn't cover the clone — without this, a cloned workflow
  // with Code nodes would 500 on them until its first save. Awaited so the clone
  // is runnable on return; no-op (returns []) when the definition has no code nodes.
  const deployErrors: { namespace: string; error: string }[] = []
  const results = await deployCodeNodes(
    clone.id,
    source.definition as unknown as WorkflowDefinition,
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.WORKFLOW_CACHE
  ).catch((e) => { console.error('[duplicate] code-node deploy failed:', e); return [] })
  for (const r of results) {
    if (r.error) deployErrors.push({ namespace: r.namespace, error: r.error })
  }

  await writeAuditLog(supabase, orgId, 'workflow', clone.id, 'created', userId, { duplicated_from: id })
  return c.json({ ...clone, deploy_errors: deployErrors.length ? deployErrors : undefined }, 201)
})

// GET /api/workflows/:id
workflows.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (error) return c.json({ error: 'Workflow not found' }, 404)
  return c.json(data)
})

// GET /api/workflows/:id/timeout-suggestions
//
// Batched timeout suggestions for every node in one workflow, so the canvas can
// badge nodes whose configured timeout sits below the suggested value without a
// per-node step-duration-stats round-trip. One grouped percentile RPC per
// window instead of N: step_duration_percentiles_by_workflow returns all
// namespaces at once.
//
// Sampling comes from collectWorkflowDurationStats — the shared adaptive
// window with per-namespace lock-in, so the badge, the config panel, and the
// audit all see the same stats for the same node.
//
// Cached in KV for 30 minutes, keyed on updated_at so a save (which can change
// per-node retries, and with them the suggestion math) busts it immediately.
workflows.get('/:id/timeout-suggestions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: wf, error: wfError } = await supabase
    .from('workflows')
    .select('id, updated_at, definition')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (wfError && !isNotFoundError(wfError)) return dbError(c, wfError)
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  // v3: added p50 + per-node window_days (panel and badge share this payload)
  const cacheKey = `timeout-suggestions:v3:${id}:${wf.updated_at}`
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  const definition = wf.definition as WorkflowDefinition | null
  const defNodes = Array.isArray(definition?.nodes) ? definition.nodes : []

  const { stats, windowDays } = await collectWorkflowDurationStats(
    supabase,
    id,
    defNodes.map((n) => n.namespace)
  )

  const nodes = defNodes.flatMap((node) => {
    const row = stats.get(node.namespace)
    if (!row || row.p99 == null || row.max_ms == null) return []
    const sampleSize = Number(row.sample_size)
    if (sampleSize < SUGGESTION_MIN_SAMPLE) return []
    const retries = typeof node.config?.retries === 'number' ? node.config.retries : DEFAULT_RETRIES
    return [{
      node_id: node.id,
      namespace: node.namespace,
      type: node.type,
      configured_ms: typeof node.config?.timeout_ms === 'number' ? node.config.timeout_ms : null,
      retries,
      suggested_ms: suggestedTimeoutMs(node.type, row.p99, row.max_ms, retries),
      p50: row.p50 ?? null,
      p99: row.p99,
      max_ms: row.max_ms,
      sample_size: sampleSize,
      window_days: row.window_days ?? 7,
    }]
  })

  const payload = { window_days: windowDays, nodes }
  await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 })
  return c.json(payload)
})

// PUT /api/workflows/:id — save definition, create version snapshot, invalidate KV cache
workflows.put('/:id', async (c) => {
  const { orgId, userId, email, name } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ name?: string; description?: string; definition?: unknown; message?: string; slack_channel?: string | null }>()

  // Verify ownership
  const { data: existing, error: fetchError } = await supabase
    .from('workflows')
    .select('id, definition')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  const blocked = dbErrorUnlessNotFound(c, fetchError)
  if (blocked) return blocked
  if (!existing) return c.json({ error: 'Workflow not found' }, 404)

  // Reject a cyclic definition at save time (#334). A cycle (an edge path that
  // returns to an earlier node) would loop at run time until the #260 step
  // ceiling aborts it; catching it here flags the misconfiguration in the editor
  // before it can process a lead. Only checked when a new definition is sent.
  if (body.definition) {
    const def = body.definition as WorkflowDefinition
    const cycle = detectCycle(def.nodes ?? [], def.edges ?? [])
    if (cycle) {
      return c.json(
        { error: `Workflow has a loop: ${cycle.join(' → ')}. Remove the edge that returns to an earlier node before saving.` },
        400,
      )
    }
  }

  // Get next version number. `.single()` reports "no prior versions" (first save)
  // as PGRST116 — fine, start at 1. Any other error is a real DB failure: bailing
  // beats defaulting to 1, which would collide with / clobber an existing chain.
  const { data: lastVersion, error: lastVersionError } = await supabase
    .from('workflow_versions')
    .select('version_number')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single()
  if (lastVersionError && !isNotFoundError(lastVersionError)) return dbError(c, lastVersionError)

  const nextVersion = ((lastVersion?.version_number as number) ?? 0) + 1

  // Create version snapshot
  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .insert({
      workflow_id: id,
      version_number: nextVersion,
      definition: asJson(body.definition ?? existing.definition),
      created_by: userId,
      message: body.message ?? null,
    })
    .select()
    .single()

  if (versionError) return dbError(c, versionError)

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

  if (updateError) return dbError(c, updateError)

  // Invalidate KV cache
  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)

  // Deploy code node scripts — run synchronously so errors surface in the save response
  const deployErrors: { namespace: string; error: string }[] = []
  if (body.definition) {
    const results = await deployCodeNodes(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      c.env.WORKFLOW_CACHE
    ).catch((e) => { console.error('[code-nodes] deploy failed:', e); return [] })
    for (const r of results) {
      if (r.error) deployErrors.push({ namespace: r.namespace, error: r.error })
    }
    // The stable bundle is now (re)deployed — delete the ephemeral test bundles
    // accumulated from iterate-then-test cycles. Non-blocking; best-effort.
    c.executionCtx.waitUntil(
      deleteTestBundles(id, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN, c.env.WORKFLOW_CACHE)
        .catch((e) => console.error('[code-nodes] test bundle cleanup failed:', e))
    )
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
      .then(async (commitSha) => {
        // null = backup not configured (no token/repo) — not a failure, leave the streak alone.
        if (!commitSha) return
        await supabase.from('workflow_versions').update({ commit_sha: commitSha }).eq('id', version.id)
        await recordBackupSuccess(c.env.IDEMPOTENCY, orgId)
      })
      .catch(async (e) => {
        console.error('[github] backup failed:', e)
        // LOCAL_DEV (set only in .dev.vars, never in production) means this save is
        // running against the real production Supabase/Slack connection from a local
        // `wrangler dev` process, which has no GITHUB_TOKEN. Recording the failure here
        // would trip the real org's backup-failure Slack alert from local testing.
        if (c.env.LOCAL_DEV) return
        await recordBackupFailure({
          supabase,
          kv: c.env.IDEMPOTENCY,
          orgId,
          workflowId: id,
          workflowName,
          error: e,
          appUrl: c.env.APP_URL,
        }).catch((alertErr) => console.error('[github] backup alert failed:', alertErr))
      })
  )

  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    version: nextVersion,
    changed_by_name: email,
  })

  return c.json({ ...updated, version_id: version.id, deploy_errors: deployErrors.length ? deployErrors : undefined })
})

// POST /api/workflows/:id/draft-changelog — AI-drafted summary of pending changes for the save popover
workflows.post('/:id/draft-changelog', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  let body: { definition?: WorkflowDefinition }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON' }, 400)
  }
  if (!body.definition) return c.json({ error: 'definition required' }, 400)

  const apiKey = await getAnthropicKey(c.env, supabase, orgId)
  if (!apiKey) {
    return c.json({ draft: null, reason: 'unavailable' as const })
  }

  const { data: wf, error: wfError } = await supabase
    .from('workflows')
    .select('id, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (wfError && !isNotFoundError(wfError)) return dbError(c, wfError)
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  const { data: lastVersion } = await supabase
    .from('workflow_versions')
    .select('definition')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lastVersion?.definition) {
    return c.json({ draft: null, reason: 'no_previous_version' as const })
  }

  const hash = await hashDefinition(body.definition)
  const cacheKey = `changelog-draft:${id}:${hash}`
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return c.json({ draft: cached, cached: true })

  const diff = computeDiff(lastVersion.definition as unknown as WorkflowDefinition, body.definition)
  if (diffIsEmpty(diff)) {
    return c.json({ draft: null, reason: 'no_changes' as const })
  }

  try {
    const draft = await draftChangelog(apiKey, diff, wf.name)
    if (draft) {
      c.executionCtx.waitUntil(
        c.env.WORKFLOW_CACHE.put(cacheKey, draft, { expirationTtl: 3600 })
      )
    }
    return c.json({ draft })
  } catch (e) {
    console.error('[changelog-draft] failed:', e)
    return c.json({ draft: null, reason: 'error' as const })
  }
})

// PATCH /api/workflows/:id — lightweight field updates (is_active) without creating a version snapshot
workflows.patch('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    is_active?: boolean
    capture_sightings?: boolean
    folder_id?: string | null
  }>()

  const { error: fetchError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (fetchError) return c.json({ error: 'Workflow not found' }, 404)

  const updates: Record<string, unknown> = { updated_by: userId, updated_by_email: email, updated_by_name: c.get('user').name }
  if (body.is_active !== undefined) updates.is_active = body.is_active
  if (body.capture_sightings !== undefined) updates.capture_sightings = body.capture_sightings
  if ('folder_id' in body) {
    if (body.folder_id === null) {
      updates.folder_id = null
    } else if (typeof body.folder_id === 'string') {
      const { data: folder, error: folderError } = await supabase
        .from('folders')
        .select('id')
        .eq('id', body.folder_id)
        .eq('organization_id', orgId)
        .single()
      if (folderError && !isNotFoundError(folderError)) return dbError(c, folderError)
      if (!folder) return c.json({ error: 'folder not found' }, 404)
      updates.folder_id = body.folder_id
    }
  }

  const { data, error } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', id)
    .select('id, name, is_active, capture_sightings, folder_id, updated_at')
    .single()

  if (error) return dbError(c, error)

  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'updated', userId, {
    is_active: body.is_active,
    capture_sightings: body.capture_sightings,
    folder_id: 'folder_id' in body ? body.folder_id : undefined,
    changed_by_name: email,
  })

  return c.json(data)
})

// DELETE /api/workflows/:id — soft delete. Execution rows have a
// RESTRICT FK on workflows(id) and are audit/cost history, so we retire
// the workflow via deleted_at and also flip is_active off so anything that
// only checks is_active (cache prewarm, definition loader) skips it too.
workflows.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { error } = await supabase
    .from('workflows')
    .update({ deleted_at: new Date().toISOString(), is_active: false, updated_by: userId })
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)

  if (error) return dbError(c, error)

  await invalidateWorkflowCache(id, c.env.WORKFLOW_CACHE)
  await writeAuditLog(supabase, orgId, 'workflow', id, 'deleted', userId)
  return c.json({ ok: true })
})

// PATCH /api/workflows/:id/test-payloads — replace the saved test payload array
workflows.patch('/:id/test-payloads', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ test_payloads: Array<{ name: string; payload: unknown }> }>()

  if (!Array.isArray(body.test_payloads)) {
    return c.json({ error: 'test_payloads must be an array' }, 400)
  }

  const { data, error } = await supabase
    .from('workflows')
    .update({ test_payloads: asJson(body.test_payloads) })
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .select('test_payloads')
    .single()

  if (error) return dbError(c, error)
  return c.json(data)
})

// GET /api/workflows/:id/versions
workflows.get('/:id/versions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Verify ownership first
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const { data, error } = await supabase
    .from('workflow_versions')
    .select('id, version_number, commit_sha, created_by, created_at, message')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })

  if (error) return dbError(c, error)
  return c.json(data)
})

// GET /api/workflows/:id/versions/:version_id
workflows.get('/:id/versions/:version_id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const versionId = c.req.param('version_id')
  const supabase = createSupabaseClient(c.env)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
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
  const id = c.req.param('id')
  const versionId = c.req.param('version_id')
  const supabase = createSupabaseClient(c.env)

  // Verify ownership — the service-role key bypasses RLS, so without this an
  // org-B caller who knows an org-A (workflow_id, version_id) pair could
  // overwrite org A's live definition and insert into its version history.
  // 404 (not 403) to avoid leaking which workflow ids exist, matching siblings.
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .select('definition, version_number')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .single()

  const blocked = dbErrorUnlessNotFound(c, versionError)
  if (blocked) return blocked
  if (!version) return c.json({ error: 'Version not found' }, 404)

  // Restore = create a new version with the old definition. PGRST116 = no prior
  // versions → start at 1; any other error is a real failure (defaulting to 1
  // would clobber the chain), so bail.
  const { data: lastVersion, error: lastVersionError } = await supabase
    .from('workflow_versions')
    .select('version_number')
    .eq('workflow_id', id)
    .order('version_number', { ascending: false })
    .limit(1)
    .single()
  if (lastVersionError && !isNotFoundError(lastVersionError)) return dbError(c, lastVersionError)

  const nextVersion = ((lastVersion?.version_number as number) ?? 0) + 1

  // Surface a failed snapshot write instead of silently "restoring" nothing.
  const { error: restoreInsertError } = await supabase.from('workflow_versions').insert({
    workflow_id: id,
    version_number: nextVersion,
    definition: version.definition,
    created_by: userId,
    message: `Restored from v${version.version_number}`,
  })
  if (restoreInsertError) return dbError(c, restoreInsertError)

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
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ payload: unknown; execution_id?: string; definition?: unknown }>()

  // Verify ownership
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()

  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  // Deploy code nodes from the current (unsaved) definition to an ephemeral
  // content-hashed bundle so the test runs the EXACT canvas code, with no
  // dispatch-namespace update-propagation lag (a fixed name can serve the prior
  // bundle right after an upload). The bundle name is threaded to the engine so
  // code nodes dispatch to it; saved bundles are cleaned up on the next save.
  let testBundleName: string | null = null
  if (body.definition) {
    const dep = await deployTestCodeBundle(
      id,
      body.definition as WorkflowDefinition,
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN,
      c.env.WORKFLOW_CACHE
    ).catch((e) => { console.error('[code-nodes] test deploy failed:', e); return { bundleName: null } })
    testBundleName = dep.bundleName
  }

  const result = await executeWorkflow(
    {
      workflowId: id,
      payload: body.payload,
      source: 'test_runner',
      isTest: true,
      executionId: body.execution_id,
      ...(testBundleName ? { codeBundleName: testBundleName } : {}),
      ...(body.definition ? { definitionOverride: body.definition as import('../../types').WorkflowDefinition } : {}),
    },
    c.env,
    supabase,
    c.executionCtx
  )

  return c.json(result.response, result.status as 200 | 500, { 'X-Trace-Id': result.traceId })
})

// POST /api/workflows/:id/test-node — re-run a single node using context from a prior execution
workflows.post('/:id/test-node', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // Verify ownership before deploying code or executing anything. Code bundles
  // are keyed by workflow id (deployCodeNodes), and the service-role key
  // bypasses RLS, so without this a cross-org caller could overwrite a victim
  // workflow's live code-node bundle with attacker-supplied script. The
  // execution_id path below only scopes the execution, not this workflow id.
  // 404 (not 403) to avoid leaking which ids exist, matching siblings.
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (ownerError) return c.json({ error: 'Workflow not found' }, 404)

  const body = await c.req.json<{
    namespace: string
    definition?: WorkflowDefinition
    execution_id?: string
    trigger_payload?: unknown
    steps?: Record<string, StepOutput>
  }>()

  // Build the execution context. Two modes:
  //  - Build from run: execution_id supplied → reconstruct the trigger payload
  //    and upstream step outputs from that execution.
  //  - Cold start: no execution_id → use the inline trigger_payload (and any
  //    inline steps), so a node that doesn't depend on upstream output can be
  //    tested without ever running the whole workflow.
  // Inline trigger_payload / steps always override, so a build-from-run context
  // can still be tweaked before re-testing.
  let triggerPayload: unknown = body.trigger_payload ?? {}
  let source = 'test_node'
  let traceId = crypto.randomUUID()
  const ctxSteps: Record<string, StepOutput> = {}

  if (body.execution_id) {
    // Scope to the workflow being tested (already org-verified above). The
    // execution must belong to this workflow; workflow_executions has no
    // organization_id column (it's org-scoped through workflow_id).
    const { data: exec, error: execError } = await supabase
      .from('workflow_executions')
      .select('trigger_payload, trace_id, source')
      .eq('id', body.execution_id)
      .eq('workflow_id', id)
      .single()
    if (execError && !isNotFoundError(execError)) return dbError(c, execError)
    if (!exec) return c.json({ error: 'Execution not found' }, 404)
    triggerPayload = body.trigger_payload ?? exec.trigger_payload
    source = (exec.source) ?? source
    traceId = (exec.trace_id) ?? traceId

    // paginate-ok: one execution's steps, used to rebuild the test-node context
    const { data: stepRows } = await supabase
      .from('execution_steps')
      .select('step_namespace, status, output, error_message, error_type')
      .eq('execution_id', body.execution_id)
    for (const row of stepRows ?? []) {
      ctxSteps[row.step_namespace] = {
        output: row.output,
        status: row.status as StepOutput['status'],
        error: row.error_message as string | undefined,
        error_type: row.error_type as StepOutput['error_type'],
      }
    }
  }
  // Inline step overrides (cold start, or tweaking a build-from-run context).
  if (body.steps) {
    for (const [ns, step] of Object.entries(body.steps)) ctxSteps[ns] = step
  }

  // Find the node definition
  const definition = body.definition
  if (!definition) return c.json({ error: 'definition is required' }, 400)
  const node = definition.nodes.find((n) => n.namespace === body.namespace)
  if (!node) return c.json({ error: 'Node not found in definition' }, 404)

  // Deploy code node from current (unsaved) definition — propagate errors
  // in the response so a silent upload failure doesn't leave the user re-running
  // stale code without feedback.
  let deployResult: { deployed: boolean; skipped: boolean; error?: string } = { deployed: false, skipped: false }
  if (node.type === 'code') {
    try {
      const results = await deployCodeNodes(id, definition, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN, c.env.WORKFLOW_CACHE)
      const failed = results.find((r) => r.error)
      if (failed?.error) {
        deployResult = { deployed: false, skipped: false, error: failed.error }
        return c.json({ output: null, status: 'failed', error_message: `Code deploy failed: ${failed.error}`, duration_ms: 0, deploy: deployResult }, 500)
      }
      // deployCodeNodes returns [] when nothing to deploy; non-empty means it
      // ran. Distinguish skip vs. actual upload by looking at logs — but for
      // the response, both are "ok, new code is live" from the caller's POV.
      deployResult = { deployed: results.length > 0, skipped: false }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[code-nodes] test-node deploy threw:', e)
      return c.json({ output: null, status: 'failed', error_message: `Code deploy threw: ${msg}`, duration_ms: 0, deploy: { deployed: false, skipped: false, error: msg } }, 500)
    }
  }

  // Reconstruct execution context
  const envVars = await loadEnvVars(orgId, c.env.WORKFLOW_CACHE, supabase, c.env.SECRET_ENCRYPTION_KEY)
  const ctx = buildContext(triggerPayload, source, id, traceId, envVars, orgId, body.execution_id, c.env.APP_URL)
  ctx.steps = ctxSteps

  const started = Date.now()
  try {
    const result = await executeNode(node, ctx, c.env, supabase)
    // Mirror the engine's sentinel-failed check (engine/index.ts:825): a code
    // node that returns { response: { status: 4xx/5xx } } is signaling its own
    // failure. Without this, Re-run shows green for error responses.
    const respStatus = result.earlyResponse?.status
    const sentinelFailed = respStatus !== undefined && respStatus >= 400 && !result.expected
    if (sentinelFailed) {
      return c.json({ output: result.output, status: 'failed', error_message: formatCodeErrorMessage(respStatus, result.earlyResponse?.body), duration_ms: Date.now() - started, deploy: deployResult })
    }
    return c.json({ output: result.output, status: 'completed', error_message: null, duration_ms: Date.now() - started, deploy: deployResult })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ output: null, status: 'failed', error_message: msg, duration_ms: Date.now() - started, deploy: deployResult })
  }
})

// ─── Step ID rename ──────────────────────────────────────────────────────────
//
// When a user renames a node's namespace on the canvas, downstream references
// in other nodes (`steps.OLD.foo`) need to follow. Canvas-local references are
// rewritten client-side. Partner bid formulas live in `partner_configs` and
// are shared across workflows — these endpoints handle the cross-workflow
// safety check and the actual formula rewrite.
//
// GET  rename-impact: report which partner formulas would be affected, and
//                     which of them are shared with OTHER workflows in the org
//                     (those get flagged as unsafe-to-rewrite).
// POST rename-apply:  rewrite the formulas the caller opts into. Caller is
//                     expected to call this only after the workflow save
//                     succeeds, so the canvas and DB stay in sync.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countStepsRefs(haystack: string | null | undefined, ns: string): number {
  if (!haystack) return 0
  const matches = haystack.match(new RegExp(`\\bsteps\\.${escapeRegex(ns)}\\b`, 'g'))
  return matches ? matches.length : 0
}

function rewriteStepsRefs(haystack: string | null | undefined, oldNs: string, newNs: string): string | null {
  if (!haystack) return haystack ?? null
  return haystack.replace(new RegExp(`\\bsteps\\.${escapeRegex(oldNs)}\\b`, 'g'), `steps.${newNs}`)
}

interface PartnerForRename {
  id: string
  name: string
  slug: string
  bid_formula: string | null
  bid_resolver_config: Record<string, unknown> | null
}

function isValidNamespace(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
}

// GET /api/workflows/:id/rename-impact?old=foo&new=bar
workflows.get('/:id/rename-impact', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const oldNs = c.req.query('old')
  const newNs = c.req.query('new')
  const supabase = createSupabaseClient(c.env)

  if (!isValidNamespace(oldNs) || !isValidNamespace(newNs)) {
    return c.json({ error: 'old and new must be valid namespaces' }, 400)
  }
  if (oldNs === newNs) {
    return c.json({ partner_formulas: [] })
  }

  const { error: ownError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (ownError) return c.json({ error: 'Workflow not found' }, 404)

  const { data: partners, error: partnersError } = await supabase
    .from('partner_configs')
    .select('id, name, slug, bid_formula, bid_resolver_config')
    .eq('organization_id', orgId)
  if (partnersError) return dbError(c, partnersError)

  const affected: PartnerForRename[] = []
  for (const p of (partners ?? []) as PartnerForRename[]) {
    const resolverFormula =
      p.bid_resolver_config && typeof (p.bid_resolver_config).formula === 'string'
        ? ((p.bid_resolver_config).formula)
        : null
    const refs = countStepsRefs(p.bid_formula, oldNs) + countStepsRefs(resolverFormula, oldNs)
    if (refs > 0) affected.push(p)
  }

  if (affected.length === 0) return c.json({ partner_formulas: [] })

  // For each affected partner, find OTHER workflows in the same org that
  // reference this partner via a partner_bid or bid_group node. Those
  // workflows would be silently broken by a formula rewrite, so we surface
  // them to the user and (by default) skip the rewrite.
  const { data: otherWorkflows, error: wfError } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .neq('id', id)
  if (wfError) return dbError(c, wfError)

  function workflowsUsingPartner(partnerId: string): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = []
    for (const w of otherWorkflows ?? []) {
      const def = (w as { definition: unknown }).definition as { nodes?: Array<{ type?: string; config?: Record<string, unknown> }> } | null
      const nodes = def?.nodes ?? []
      const used = nodes.some((n) => {
        if (!n || !n.config) return false
        if (n.type === 'partner_bid' && n.config.partner_id === partnerId) return true
        if (n.type === 'bid_group') {
          const ids = n.config.partner_ids
          if (Array.isArray(ids) && ids.includes(partnerId)) return true
          if (n.config.fallback_partner_id === partnerId) return true
        }
        return false
      })
      if (used) out.push({ id: (w as { id: string }).id, name: (w as { name: string }).name })
    }
    return out
  }

  const partner_formulas = affected.map((p) => {
    const resolverFormula =
      p.bid_resolver_config && typeof (p.bid_resolver_config).formula === 'string'
        ? ((p.bid_resolver_config).formula)
        : null
    const formulaPreview = resolverFormula ?? p.bid_formula ?? ''
    const shared = workflowsUsingPartner(p.id)
    return {
      partner_id: p.id,
      partner_name: p.name,
      partner_slug: p.slug,
      references: countStepsRefs(p.bid_formula, oldNs) + countStepsRefs(resolverFormula, oldNs),
      formula_preview: formulaPreview.length > 120 ? formulaPreview.slice(0, 120) + '…' : formulaPreview,
      shared_with_workflows: shared,
      can_rewrite: shared.length === 0,
    }
  })

  return c.json({ partner_formulas })
})

// POST /api/workflows/:id/rename-apply
// Body: { old: string, new: string, partner_ids: string[] }
// Rewrites `steps.OLD.…` → `steps.NEW.…` in each listed partner's bid_formula
// and bid_resolver_config.formula. Caller is responsible for filtering out
// cross-workflow-shared partners using the rename-impact response.
workflows.post('/:id/rename-apply', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ old?: unknown; new?: unknown; partner_ids?: unknown }>()

  if (!isValidNamespace(body.old) || !isValidNamespace(body.new)) {
    return c.json({ error: 'old and new must be valid namespaces' }, 400)
  }
  const oldNs = body.old
  const newNs = body.new
  if (oldNs === newNs) return c.json({ updated: 0 })

  if (!Array.isArray(body.partner_ids) || body.partner_ids.some((x) => typeof x !== 'string')) {
    return c.json({ error: 'partner_ids must be an array of strings' }, 400)
  }
  const partnerIds = body.partner_ids as string[]
  if (partnerIds.length === 0) return c.json({ updated: 0 })

  const { error: ownError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  if (ownError) return c.json({ error: 'Workflow not found' }, 404)

  const { data: partners, error: partnersError } = await supabase
    .from('partner_configs')
    .select('id, name, slug, bid_formula, bid_resolver_config')
    .eq('organization_id', orgId)
    .in('id', partnerIds)
  if (partnersError) return dbError(c, partnersError)

  let updated = 0
  for (const p of (partners ?? []) as PartnerForRename[]) {
    const nextLegacy = rewriteStepsRefs(p.bid_formula, oldNs, newNs)
    const cfg = (p.bid_resolver_config ?? {})
    const cfgFormula = typeof cfg.formula === 'string' ? cfg.formula : null
    const nextCfgFormula = rewriteStepsRefs(cfgFormula, oldNs, newNs)
    const cfgChanged = cfgFormula !== null && nextCfgFormula !== cfgFormula
    const legacyChanged = nextLegacy !== p.bid_formula
    if (!cfgChanged && !legacyChanged) continue

    const update: Record<string, unknown> = { updated_by: userId }
    if (legacyChanged) update.bid_formula = nextLegacy
    if (cfgChanged) update.bid_resolver_config = { ...cfg, formula: nextCfgFormula }

    const { error: upErr } = await supabase
      .from('partner_configs')
      .update(update)
      .eq('id', p.id)
      .eq('organization_id', orgId)
    if (upErr) return dbError(c, upErr)

    await writeAuditLog(supabase, orgId, 'partner_config', p.id, 'updated', userId, {
      reason: 'step_id_renamed',
      workflow_id: id,
      old_namespace: oldNs,
      new_namespace: newNs,
    })
    updated += 1
  }

  return c.json({ updated })
})

export default workflows
