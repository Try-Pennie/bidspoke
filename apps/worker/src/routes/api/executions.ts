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
    .select('id, workflow_id, status, outcome, final_node_namespace, source, started_at, duration_ms, error_message')
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
  return c.json(data)
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
