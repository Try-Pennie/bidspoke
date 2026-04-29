import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { executeWorkflow } from '../../engine/index'

type Variables = AuthVariables

const executions = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/executions
executions.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const { workflow_id, status, outcome, source, from, to } = c.req.query()

  // Resolve the set of workflow IDs this org owns (optionally scoped to one)
  let workflowIds: string[]
  if (workflow_id) {
    // Verify this workflow belongs to the org
    const { data: wf } = await supabase
      .from('workflows')
      .select('id')
      .eq('id', workflow_id)
      .eq('organization_id', orgId)
      .single()
    if (!wf) return c.json({ error: 'Workflow not found' }, 404)
    workflowIds = [wf.id]
  } else {
    const { data: wfs } = await supabase
      .from('workflows')
      .select('id')
      .eq('organization_id', orgId)
    workflowIds = (wfs ?? []).map((w) => w.id)
    if (workflowIds.length === 0) return c.json([])
  }

  let query = supabase
    .from('workflow_executions')
    .select('id, workflow_id, status, outcome, final_node_namespace, source, started_at, duration_ms, error_message, parent_execution_id')
    .in('workflow_id', workflowIds)
    .eq('is_test', false)
    .order('started_at', { ascending: false })
    .limit(100)

  if (status) query = query.eq('status', status)
  if (outcome) query = query.eq('outcome', outcome)
  if (source) query = query.eq('source', source)
  if (from) query = query.gte('started_at', from)
  if (to) query = query.lte('started_at', to)

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  if (!data || data.length === 0) return c.json([])

  // Resolve which rows have been replayed at least once. We only ever care
  // about parents of the rows in this page — the page is at most 100 ids,
  // so the IN list stays small. This makes the "replayed" marker accurate
  // even when the replay row scrolled off the visible page.
  const pageIds = data.map((r) => r.id)
  const { data: parents } = await supabase
    .from('workflow_executions')
    .select('parent_execution_id')
    .in('parent_execution_id', pageIds)
  const replayedIds = new Set((parents ?? []).map((p) => p.parent_execution_id))

  const enriched = data.map((row) => ({ ...row, has_children: replayedIds.has(row.id) }))
  return c.json(enriched)
})

// GET /api/executions/step-duration-stats?workflow_id=X&namespace=Y
//
// Returns p50/p95/p99/max/sample_size for completed (non-test) runs of one
// step over the last 7 days. Used by the config panel to suggest a sensible
// timeout. Cached in KV for 30 minutes.
//
// Must be declared BEFORE `/:id` so the literal segment isn't matched as an id.
executions.get('/step-duration-stats', async (c) => {
  const { orgId } = c.get('user')
  const workflowId = c.req.query('workflow_id')
  const namespace = c.req.query('namespace')
  if (!workflowId || !namespace) return c.json({ error: 'workflow_id and namespace required' }, 400)

  const cacheKey = `step-stats:${workflowId}:${namespace}`
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  const supabase = createSupabaseClient(c.env)

  // Verify org owns the workflow before exposing any stats
  const { data: wf } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('organization_id', orgId)
    .single()
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase.rpc('step_duration_percentiles', {
    p_workflow_id: workflowId,
    p_namespace: namespace,
    p_since: since,
  })
  if (error) return c.json({ error: error.message }, 500)

  const row = (data ?? [])[0] as
    | { p50: number | null; p95: number | null; p99: number | null; max_ms: number | null; sample_size: number }
    | undefined

  const sampleSize = Number(row?.sample_size ?? 0)
  const p99 = row?.p99 ?? null
  const suggestedMs = p99 != null ? Math.ceil((p99 * 1.5) / 250) * 250 : null

  const payload = {
    p50: row?.p50 ?? null,
    p95: row?.p95 ?? null,
    p99,
    max_ms: row?.max_ms ?? null,
    sample_size: sampleSize,
    suggested_ms: suggestedMs,
    window_days: 7,
  }

  // 30-minute KV cache
  await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 })

  return c.json(payload)
})

// GET /api/executions/:id
executions.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data: execution, error } = await supabase
    .from('workflow_executions')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !execution) return c.json({ error: 'Execution not found' }, 404)

  // Verify org ownership via workflow
  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', execution.workflow_id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Execution not found' }, 404)

  // Fetch steps + any executions that reference this one as parent (replays
  // and resumes both set parent_execution_id, so both surface as children).
  const [stepsRes, childrenRes] = await Promise.all([
    supabase
      .from('execution_steps')
      .select('*')
      .eq('execution_id', id)
      .order('step_order', { ascending: true }),
    supabase
      .from('workflow_executions')
      .select('id, started_at, status, outcome, source')
      .eq('parent_execution_id', id)
      .order('started_at', { ascending: true }),
  ])

  return c.json({
    ...execution,
    steps: stepsRes.data ?? [],
    child_executions: childrenRes.data ?? [],
  })
})

// POST /api/executions/:id/resume
executions.post('/:id/resume', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data: execution, error } = await supabase
    .from('workflow_executions')
    .select('workflow_id, trigger_payload, source')
    .eq('id', id)
    .single()

  if (error || !execution) return c.json({ error: 'Execution not found' }, 404)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', execution.workflow_id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Execution not found' }, 404)

  const result = await executeWorkflow(
    {
      workflowId: execution.workflow_id,
      payload: execution.trigger_payload,
      source: execution.source ?? 'resume',
      resumeFromExecutionId: id,
    },
    c.env,
    supabase,
    c.executionCtx
  )

  return c.json(result.response, result.status as 200 | 500, { 'X-Trace-Id': result.traceId })
})

// POST /api/executions/:id/replay
executions.post('/:id/replay', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data: execution, error } = await supabase
    .from('workflow_executions')
    .select('workflow_id, trigger_payload, source')
    .eq('id', id)
    .single()

  if (error || !execution) return c.json({ error: 'Execution not found' }, 404)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', execution.workflow_id)
    .eq('organization_id', orgId)
    .single()

  if (ownerError) return c.json({ error: 'Execution not found' }, 404)

  // Replay = fresh execution from start with original payload, linked back
  // to the original via parent_execution_id so both rows can show the
  // relationship in the UI.
  const result = await executeWorkflow(
    {
      workflowId: execution.workflow_id,
      payload: execution.trigger_payload,
      source: execution.source ?? 'replay',
      parentExecutionId: id,
    },
    c.env,
    supabase,
    c.executionCtx
  )

  return c.json(result.response, result.status as 200 | 500, {
    'X-Trace-Id': result.traceId,
    'X-Execution-Id': result.executionId,
  })
})

export default executions
