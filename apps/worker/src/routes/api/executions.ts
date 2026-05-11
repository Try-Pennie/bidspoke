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

// GET /api/executions/step-duration-stats?workflow_id=X&namespace=Y[&node_type=Z&subtype=W]
//
// Returns p50/p95/p99/max/sample_size for completed (non-test) runs of one
// step over the last 7 days. Used by the config panel to suggest a sensible
// timeout. Cached in KV for 30 minutes.
//
// When the per-step query returns fewer than 10 samples (a fresh workflow,
// say), and node_type is provided AND falls into one of the categories where
// duration is roughly stable across workflows, the route falls back to a
// cross-workflow aggregate keyed by step type (+ optional subtype). The
// response carries `source: 'history' | 'similar'` so the UI can change copy.
//
// Must be declared BEFORE `/:id` so the literal segment isn't matched as an id.
executions.get('/step-duration-stats', async (c) => {
  const { orgId } = c.get('user')
  const workflowId = c.req.query('workflow_id')
  const namespace = c.req.query('namespace')
  const nodeType = c.req.query('node_type')
  const subtype = c.req.query('subtype')
  // Retries change the safety profile of a timeout: with retries, a long-tail
  // outlier just retries instead of failing permanently, so the suggestion can
  // be tighter. Default to the engine's default of 2.
  const retries = Math.max(0, parseInt(c.req.query('retries') ?? '2'))
  if (!workflowId || !namespace) return c.json({ error: 'workflow_id and namespace required' }, 400)

  // v4 prefix: bump when the suggestion math changes so stale entries expire.
  const cacheKey = `step-stats:v4:${workflowId}:${namespace}:${nodeType ?? ''}:${subtype ?? ''}:${retries}`
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
  const SAMPLE_FLOOR = 10

  // 1. Per-step history (preferred when there's enough data)
  const { data: specificData, error: specificError } = await supabase.rpc('step_duration_percentiles', {
    p_workflow_id: workflowId,
    p_namespace: namespace,
    p_since: since,
  })
  if (specificError) return c.json({ error: specificError.message }, 500)
  const specificRow = pctRow(specificData)
  const specificSample = Number(specificRow?.sample_size ?? 0)

  // 2. Cross-workflow fallback when per-step data is thin and the type qualifies
  let row = specificRow
  let source: 'history' | 'similar' = 'history'
  let resolvedSubtype: string | null = null

  if (specificSample < SAMPLE_FLOOR && nodeType && qualifiesForSimilarFallback(nodeType, subtype)) {
    const subtypeArg = subtypeRequired(nodeType) ? subtype! : null
    const { data: typedData, error: typedError } = await supabase.rpc('step_duration_percentiles_typed', {
      p_org_id: orgId,
      p_step_type: nodeType,
      p_step_subtype: subtypeArg,
      p_since: since,
    })
    if (!typedError) {
      const typedRow = pctRow(typedData)
      const typedSample = Number(typedRow?.sample_size ?? 0)
      if (typedSample >= SAMPLE_FLOOR) {
        row = typedRow
        source = 'similar'
        resolvedSubtype = subtypeArg
      }
    }
  }

  const sampleSize = Number(row?.sample_size ?? 0)
  const p99 = row?.p99 ?? null
  const maxMs = row?.max_ms ?? null
  // Suggestion math depends on whether the step retries on failure:
  //   retries == 0: must clear max × 1.05 — a single timeout = permanent fail.
  //   retries >= 1: drop the max-clamp; a long-tail outlier just retries.
  //                 Use p99 × 1.5 as the baseline (most calls succeed first try).
  // 10ms hard floor across both cases: avoids recommending 0ms when percentiles
  // round to zero for sub-ms in-memory steps. Magnitude-aware rounding keeps
  // sub-100ms suggestions readable (5ms steps), sub-1s at 50ms, above at 250ms.
  const SUGGESTION_FLOOR_MS = 10
  const rawSuggested =
    p99 != null && maxMs != null
      ? retries >= 1
        ? Math.max(p99 * 1.5, SUGGESTION_FLOOR_MS)
        : Math.max(p99 * 1.5, maxMs * 1.05, SUGGESTION_FLOOR_MS)
      : null
  const suggestedMs = rawSuggested != null ? roundUpSmart(rawSuggested) : null

  const payload = {
    p50: row?.p50 ?? null,
    p95: row?.p95 ?? null,
    p99,
    max_ms: row?.max_ms ?? null,
    sample_size: sampleSize,
    suggested_ms: suggestedMs,
    window_days: 7,
    source,
    subtype: resolvedSubtype,
    retries_assumed: retries,
  }

  // 30-minute KV cache
  await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 })

  return c.json(payload)
})

type PctRow = { p50: number | null; p95: number | null; p99: number | null; max_ms: number | null; sample_size: number } | undefined
function pctRow(data: unknown): PctRow {
  return ((data ?? []) as PctRow[])[0]
}

// Round suggestions to readable increments that scale with magnitude. Without
// this a sub-100ms value would get rounded to 250ms (defeating the hard floor)
// and a 30s value would have noisy 250ms granularity.
function roundUpSmart(ms: number): number {
  if (ms <= 100) return Math.ceil(ms / 5) * 5
  if (ms <= 1000) return Math.ceil(ms / 50) * 50
  return Math.ceil(ms / 250) * 250
}

// Node types whose duration distribution is consistent enough across workflows
// that a cross-workflow aggregate is a useful fallback when a fresh workflow
// has no prior runs. Excludes `code`, `partner_bid`, `bid_group`, and `webhook`
// — those are too workflow-specific (custom script / partner / external API).
const SIMILAR_FALLBACK_STABLE = new Set([
  'constants', 'transform', 'branch', 'filter', 'exit', 'response',
  'parallel', 'parallel_end', 'bid_evaluation',
])
const SIMILAR_FALLBACK_BY_SUBTYPE = new Set(['salesforce'])

function qualifiesForSimilarFallback(nodeType: string, subtype?: string): boolean {
  if (SIMILAR_FALLBACK_STABLE.has(nodeType)) return true
  if (SIMILAR_FALLBACK_BY_SUBTYPE.has(nodeType) && subtype) return true
  return false
}
function subtypeRequired(nodeType: string): boolean {
  return SIMILAR_FALLBACK_BY_SUBTYPE.has(nodeType)
}

// GET /api/executions/:id
//
// `?summary=1` strips input/output/logs from step rows. The canvas execution
// overlay only needs status/duration/error to color nodes, and lazy-loads
// input/output via /:id/steps/:stepId when a node is clicked. Heavy step
// payloads (Equifax response, SF blobs) added up to multi-MB responses on
// every click before this — see TODO 4.x notes.
executions.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const summary = c.req.query('summary') === '1'
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

  const stepColumns = summary
    ? 'id, step_namespace, step_type, step_node_id, parallel_group_id, status, error_message, error_type, retries_used, started_at, completed_at, duration_ms, step_order'
    : '*'

  // Fetch steps + any executions that reference this one as parent (replays
  // and resumes both set parent_execution_id, so both surface as children).
  const [stepsRes, childrenRes] = await Promise.all([
    supabase
      .from('execution_steps')
      .select(stepColumns)
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

// GET /api/executions/:id/steps/:stepId
//
// Returns input/output/logs for a single step. Used by the canvas execution
// overlay to lazy-load heavy step payloads when the user clicks a node.
executions.get('/:id/steps/:stepId', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const stepId = c.req.param('stepId') as string
  const supabase = createSupabaseClient(c.env)

  const { data: execution, error: execError } = await supabase
    .from('workflow_executions')
    .select('workflow_id')
    .eq('id', id)
    .single()
  if (execError || !execution) return c.json({ error: 'Execution not found' }, 404)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', execution.workflow_id)
    .eq('organization_id', orgId)
    .single()
  if (ownerError) return c.json({ error: 'Execution not found' }, 404)

  const { data: step, error: stepError } = await supabase
    .from('execution_steps')
    .select('id, step_namespace, input, output, logs')
    .eq('execution_id', id)
    .eq('id', stepId)
    .single()
  if (stepError || !step) return c.json({ error: 'Step not found' }, 404)

  return c.json(step)
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
