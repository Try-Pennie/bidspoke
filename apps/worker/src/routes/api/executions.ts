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
  const { workflow_id, status, outcome, source, from, to, before, before_id } = c.req.query()

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
    .eq('is_test', false)
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(100)
  // `.in('workflow_id', [oneId])` generates `workflow_id=in.(X)` which the
  // planner sees as `col = ANY(ARRAY[X])` — partition pruning skips on the
  // ANY form and the query scans every partition (~7s on engine-bidding
  // post daily-partition migration vs ~140ms with `eq.`). Use eq when there
  // is a single workflow so partition pruning fires.
  query = workflowIds.length === 1
    ? query.eq('workflow_id', workflowIds[0])
    : query.in('workflow_id', workflowIds)

  if (status) query = query.eq('status', status)
  if (outcome) query = query.eq('outcome', outcome)
  if (source) query = query.eq('source', source)
  if (from) query = query.gte('started_at', from)
  if (to) query = query.lte('started_at', to)
  // Keyset cursor for infinite scroll: load executions strictly older than
  // (before, before_id). Tiebreak on id when timestamps collide — rare but
  // possible at high volume.
  if (before && before_id) {
    query = query.or(`started_at.lt.${before},and(started_at.eq.${before},id.lt.${before_id})`)
  }

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

  // v8 prefix: bump when the suggestion math changes so stale entries expire
  // immediately instead of lingering 30 min. (v5 added the per-workflow RPC
  // bound; v6 added the node-type floor; v7 moved `constants` to the DB floor;
  // v8 made the sample window adaptive so high-volume nodes stop timing out.)
  const cacheKey = `step-stats:v8:${workflowId}:${namespace}:${nodeType ?? ''}:${subtype ?? ''}:${retries}`
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

  const SAMPLE_FLOOR = 10
  const HOUR = 60 * 60 * 1000
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * HOUR).toISOString()

  // 1. Per-step history (preferred when there's enough data).
  //
  // Adaptive window, shortest-first. The per-step RPC joins this workflow's
  // recent executions to their step partitions; over a 7-day window a
  // high-volume workflow (Engine Bidding produces 50k-100k+ steps/namespace/wk)
  // makes that join scan enough partitions to blow the DB statement timeout —
  // which surfaced as the config panel never showing a suggestion at all. But a
  // busy node fills the whole sample within a couple of hours, so we try a short
  // window first and only widen when the sample is thin. A node thin at 2h is
  // low-volume by definition, so its wider joins are cheap — the timeout-prone
  // case and the needs-a-wide-window case are mutually exclusive.
  //
  // On RPC error (e.g. statement timeout) we stop widening and degrade to
  // whatever we have (often nothing) plus the node-type floor below, returning
  // 200 so the panel can still hard-flag a sub-floor timeout — never a 500 that
  // blanks the UI.
  const WINDOWS: Array<{ since: string; days: number }> = [
    { since: new Date(Date.now() - 2 * HOUR).toISOString(), days: 2 / 24 },
    { since: new Date(Date.now() - 24 * HOUR).toISOString(), days: 1 },
    { since: sevenDaysAgo, days: 7 },
  ]
  let specificRow: PctRow
  let specificSample = 0
  let specificWindowDays = 7
  for (const w of WINDOWS) {
    const { data: specificData, error: specificError } = await supabase.rpc('step_duration_percentiles', {
      p_workflow_id: workflowId,
      p_namespace: namespace,
      p_since: w.since,
    })
    if (specificError) break // degrade gracefully; floor payload still returned below
    // A wider window is a strict superset, so a successful call never has fewer
    // samples than a narrower one — always take the latest success.
    specificRow = pctRow(specificData)
    specificSample = Number(specificRow?.sample_size ?? 0)
    specificWindowDays = w.days
    if (specificSample >= SAMPLE_FLOOR) break // enough data; don't widen
  }

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
      p_since: sevenDaysAgo,
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
  // Node-type floor (below): the percentiles are computed over COMPLETED steps,
  // so any attempt slow enough to hit the current timeout is censored out of the
  // distribution. For dispatch-/network-bound steps that floor is exactly the
  // overhead the data can't see — a code node's Dynamic Worker cold-dispatch can
  // exceed its compute-time p99 by an order of magnitude, and retries don't help
  // when the slowness is correlated within a run (cold worker = every attempt is
  // slow). So we never suggest below the type's known irreducible floor.
  // Magnitude-aware rounding keeps sub-100ms suggestions readable, sub-1s at
  // 50ms, above at 250ms.
  const floorMs = suggestionFloorMs(nodeType)
  const rawSuggested =
    p99 != null && maxMs != null
      ? retries >= 1
        ? Math.max(p99 * 1.5, floorMs)
        : Math.max(p99 * 1.5, maxMs * 1.05, floorMs)
      : null
  const suggestedMs = rawSuggested != null ? roundUpSmart(rawSuggested) : null

  const payload = {
    p50: row?.p50 ?? null,
    p95: row?.p95 ?? null,
    p99,
    max_ms: row?.max_ms ?? null,
    sample_size: sampleSize,
    suggested_ms: suggestedMs,
    // The node-type floor and why it exists. Sent unconditionally (even with no
    // run history) so the config UI can hard-flag a timeout set below the floor —
    // a value the percentiles can't catch when a node has thin/no completed runs.
    floor_ms: floorMs,
    floor_reason: suggestionFloorReason(nodeType),
    // The per-step window actually used (adaptive); the typed fallback is 7d.
    window_days: source === 'similar' ? 7 : specificWindowDays,
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

// Minimum timeout the suggester will ever recommend, by node type. This is the
// irreducible overhead the percentiles CAN'T measure: completed-step durations
// exclude any attempt slow enough to have hit the current timeout, so for
// dispatch-/IO-bound steps the real floor lives below the visible data.
//
// Dispatch/DB floor (~150ms): a cold-path round-trip that retries can't rescue,
// because a cold worker / cold cache makes EVERY attempt in the run slow.
//   - code: Cloudflare Dynamic Worker (WfP) dispatch. Warm is single-digit ms,
//     cold is 100ms+. A 20ms timeout here = flaky timeouts on cold runs.
//   - constants: LOOKS in-memory but loadPartnerConstants reads KV and, on a
//     cold miss, queries Supabase (partner_uuid_map + partner_configs) — a DB
//     round-trip. A timed-out fetch never populates KV, so retries stay cold.
//
// Network floor (~50ms): outbound HTTP round-trip + TLS. These nodes' own p99 is
// usually well above this, so the floor mainly guards a fast-declining partner.
//
// In-memory floor (10ms): filter/branch/transform/response/etc. — truly fast;
// keep the original floor so we don't recommend 0ms.
const DISPATCH_OR_DB_FLOOR_MS = 150
const NETWORK_FLOOR_MS = 50
const INMEMORY_FLOOR_MS = 10
const DISPATCH_OR_DB_NODE_TYPES = new Set(['code', 'constants'])
const NETWORK_NODE_TYPES = new Set(['partner_bid', 'integration', 'salesforce', 'webhook', 'bid_group'])

export function suggestionFloorMs(nodeType?: string): number {
  if (nodeType && DISPATCH_OR_DB_NODE_TYPES.has(nodeType)) return DISPATCH_OR_DB_FLOOR_MS
  if (nodeType && NETWORK_NODE_TYPES.has(nodeType)) return NETWORK_FLOOR_MS
  return INMEMORY_FLOOR_MS
}

// Plain-language reason the floor exists, so the config UI can explain why a
// sub-floor timeout is a hard error (cold path fails every attempt) rather than
// a soft "you have less headroom" nudge. Mirrors the categories above.
export function suggestionFloorReason(nodeType?: string): string | null {
  if (nodeType && nodeType === 'code')
    return 'Code nodes run in a sandboxed worker that takes time to dispatch, so a cold run can take 100ms+ before your code even starts.'
  if (nodeType && nodeType === 'constants')
    return 'The constants step reads from KV and queries the database on a cold cache, so the first run after a gap is a full round-trip.'
  if (nodeType && NETWORK_NODE_TYPES.has(nodeType))
    return 'This step makes an outbound API call, so every run pays a network round-trip plus TLS setup.'
  return null
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

  const t0 = Date.now()
  // Single round-trip: execution + ownership check via inner join on workflows.
  // RLS already scopes via workflows.organization_id, but we explicitly filter
  // so a row from another org returns "not found" instead of leaking shape.
  const { data: execution, error } = await supabase
    .from('workflow_executions')
    .select('*, workflows!inner(id)')
    .eq('id', id)
    .eq('workflows.organization_id', orgId)
    .single()
  const t1 = Date.now()

  if (error || !execution) return c.json({ error: 'Execution not found' }, 404)

  const stepColumns = summary
    ? 'id, step_namespace, step_type, step_node_id, parallel_group_id, status, error_message, error_type, retries_used, started_at, completed_at, duration_ms, step_order'
    : '*'

  // Fetch steps + any executions that reference this one as parent (replays
  // and resumes both set parent_execution_id, so both surface as children).
  // `started_at >= execution.started_at` is a partition-pruning hint:
  //   - Steps are always created during/after the execution starts.
  //   - Replay/resume children are always triggered after the parent finishes.
  // Without it the planner has to scan every partition on each query. See
  // reference_supabase_in_single_id_defeats_partition_pruning for the related
  // gotcha on the list endpoint.
  const execStartedAt = execution.started_at
  const [stepsRes, childrenRes] = await Promise.all([
    supabase
      .from('execution_steps')
      .select(stepColumns)
      .eq('execution_id', id)
      .gte('started_at', execStartedAt)
      .order('step_order', { ascending: true }),
    supabase
      .from('workflow_executions')
      .select('id, started_at, status, outcome, source')
      .eq('parent_execution_id', id)
      .gte('started_at', execStartedAt)
      .order('started_at', { ascending: true }),
  ])
  const t2 = Date.now()

  // Inherit completed steps from the parent execution on resumes so the
  // canvas overlay shows skipped upstream steps as completed (green) with
  // their original outputs. Replays don't get this treatment — they re-run
  // every step and have their own rows.
  type StepRow = { step_namespace: string; step_order: number; [k: string]: unknown }
  let steps = (stepsRes.data ?? []) as unknown as StepRow[]
  if (execution.resumed_from_execution_id) {
    const presentNamespaces = new Set(steps.map((s) => s.step_namespace))
    // The resumed-from execution ran strictly before the current one, so its
    // steps' `started_at` is always < execStartedAt. Lets the planner prune all
    // partitions newer than the current execution. Doesn't bound the lower end
    // tightly (we'd need parent.started_at for that), but is still a big win
    // once daily partitions accumulate.
    const { data: parentSteps } = await supabase
      .from('execution_steps')
      .select(stepColumns)
      .eq('execution_id', execution.resumed_from_execution_id)
      .eq('status', 'completed')
      .lt('started_at', execStartedAt)
      .order('step_order', { ascending: true })
    const inherited = ((parentSteps ?? []) as unknown as StepRow[])
      .filter((s) => !presentNamespaces.has(s.step_namespace))
      .map((s) => ({ ...s, inherited_from_execution_id: execution.resumed_from_execution_id }))
    steps = [...inherited, ...steps].sort((a, b) => a.step_order - b.step_order)
  }
  const t3 = Date.now()

  return c.json(
    { ...execution, steps, child_executions: childrenRes.data ?? [] },
    200,
    { 'Server-Timing': `auth;dur=${t1 - t0},parallel;dur=${t2 - t1},inherit;dur=${t3 - t2}` }
  )
})

// GET /api/executions/:id/steps/:stepId
//
// Returns input/output/logs for a single step. Used by the canvas execution
// overlay to lazy-load heavy step payloads when the user clicks a node.
//
// Org verification goes via the step's own execution_id → workflow → org,
// not the :id path param. This lets resumed executions lazy-load inherited
// steps (whose row lives on the parent execution) without a separate route.
executions.get('/:id/steps/:stepId', async (c) => {
  const { orgId } = c.get('user')
  const stepId = c.req.param('stepId') as string
  const supabase = createSupabaseClient(c.env)

  const { data: step, error: stepError } = await supabase
    .from('execution_steps')
    .select('id, step_namespace, input, output, logs, execution_id')
    .eq('id', stepId)
    .single()
  if (stepError || !step) return c.json({ error: 'Step not found' }, 404)

  const { data: execution, error: execError } = await supabase
    .from('workflow_executions')
    .select('workflow_id')
    .eq('id', step.execution_id)
    .single()
  if (execError || !execution) return c.json({ error: 'Step not found' }, 404)

  const { error: ownerError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', execution.workflow_id)
    .eq('organization_id', orgId)
    .single()
  if (ownerError) return c.json({ error: 'Step not found' }, 404)

  // Don't leak execution_id in the response.
  const { execution_id: _eid, ...rest } = step
  return c.json(rest)
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

  return c.json(result.response, result.status as 200 | 500, {
    'X-Trace-Id': result.traceId,
    'X-Execution-Id': result.executionId,
  })
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
