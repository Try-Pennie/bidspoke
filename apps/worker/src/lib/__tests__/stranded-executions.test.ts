import { describe, it, expect } from 'vitest'
import {
  resolveStrandedExecution,
  buildStrandGraph,
  runReduceFinalizeStrandedExecutions,
  type StrandStepEvidence,
} from '../stranded-executions'
import type { WorkflowDefinition } from '../../types'

// Minimal graph builder for tests: a linear chain trigger -> a -> b -> c where
// `c` is the true terminal (zero outgoing edges). Node ids equal their letters.
function makeDefinition(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'wf-def',
    name: 'Test Workflow',
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [
      { id: 'a', namespace: 'a', type: 'code', config: {} },
      { id: 'b', namespace: 'b', type: 'branch', config: {} },
      { id: 'c', namespace: 'c', type: 'response', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
    ...overrides,
  } as WorkflowDefinition
}

describe('resolveStrandedExecution', () => {
  it('honestly labels an execution with no step history as unrecoverable, never guessing success', () => {
    const resolved = resolveStrandedExecution([], '2026-07-07T21:32:05.000Z')
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.completed_at).toBe('2026-07-07T21:32:05.000Z')
    expect(resolved.duration_ms).toBe(0)
    expect(resolved.error_message).toMatch(/recovered/i)
    expect(resolved.failed_step_type).toBeNull()
  })

  it('marks failed with the real error when a step actually failed', () => {
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'code', error_message: null, completed_at: '2026-07-08T02:38:00.000Z' },
        { status: 'failed', step_type: 'partner_bid', error_message: 'equifax_api_error: ACRO_GATEWAY', completed_at: '2026-07-08T02:38:05.000Z' },
      ],
      '2026-07-08T02:37:57.000Z'
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBe('failed')
    expect(resolved.error_message).toBe('equifax_api_error: ACRO_GATEWAY')
    expect(resolved.failed_step_type).toBe('partner_bid')
    expect(resolved.completed_at).toBe('2026-07-08T02:38:05.000Z')
    expect(resolved.duration_ms).toBe(8000)
  })

  it('does NOT guess completed when steps exist but none failed and none is a known terminal type', () => {
    // Mirrors the real Engine Bidding Workflow shape: it never logs a
    // 'response'/'exit' step, so this must not be treated as proof of success.
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'constants', error_message: null, completed_at: '2026-07-01T01:00:13.000Z' },
        { status: 'completed', step_type: 'code', error_message: null, completed_at: '2026-07-01T01:00:13.100Z' },
        { status: 'completed', step_type: 'branch', error_message: null, completed_at: '2026-07-01T01:00:13.200Z' },
        { status: 'completed', step_type: 'salesforce', error_message: null, completed_at: '2026-07-01T01:00:13.293Z' },
      ],
      '2026-07-01T01:00:12.991Z'
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.error_message).toMatch(/recovered/i)
    expect(resolved.failed_step_type).toBeNull()
    // Duration is reconstructed from real step history, not fabricated as "now".
    expect(resolved.completed_at).toBe('2026-07-01T01:00:13.293Z')
  })

  it('does not call it failed when an earlier failed step was recovered by a later successful step (on_error/fallback_node)', () => {
    const resolved = resolveStrandedExecution(
      [
        { status: 'failed', step_type: 'partner_bid', error_message: 'timeout', completed_at: '2026-07-08T02:38:00.000Z' },
        { status: 'completed', step_type: 'partner_bid', error_message: null, completed_at: '2026-07-08T02:38:05.000Z' },
      ],
      '2026-07-08T02:37:57.000Z'
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.error_message).toMatch(/recovered/i)
    expect(resolved.failed_step_type).toBeNull()
    expect(resolved.completed_at).toBe('2026-07-08T02:38:05.000Z')
  })

  it('never produces a negative duration even if a completed_at predates started_at', () => {
    const resolved = resolveStrandedExecution(
      [{ status: 'completed', step_type: 'code', error_message: null, completed_at: '2026-07-01T01:00:00.000Z' }],
      '2026-07-01T01:00:05.000Z'
    )
    expect(resolved.duration_ms).toBe(0)
  })

  it('falls back to started_at for completed_at when no step has a completed_at at all', () => {
    const resolved = resolveStrandedExecution(
      [{ status: 'running', step_type: 'code', error_message: null, completed_at: null }],
      '2026-07-01T01:00:00.000Z'
    )
    expect(resolved.completed_at).toBe('2026-07-01T01:00:00.000Z')
    expect(resolved.duration_ms).toBe(0)
  })
})

describe('buildStrandGraph', () => {
  it('counts outgoing edges per node id from the definition edges', () => {
    const graph = buildStrandGraph(makeDefinition())
    expect(graph.outgoingEdgeCount.get('a')).toBe(1)
    expect(graph.outgoingEdgeCount.get('b')).toBe(1)
    // The terminal node is never a source, so it has zero outgoing edges.
    expect(graph.outgoingEdgeCount.get('c') ?? 0).toBe(0)
  })

  it('records every node id so an absent id can be distinguished from a real dead end', () => {
    const graph = buildStrandGraph(makeDefinition())
    expect(graph.nodeIds.has('c')).toBe(true)
    expect(graph.nodeIds.has('ghost')).toBe(false)
  })

  it('surfaces the trigger success_node_namespaces for outcome attribution', () => {
    const graph = buildStrandGraph(
      makeDefinition({
        trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key', success_node_namespaces: ['c'] } },
      }),
    )
    expect(graph.successNamespaces).toEqual(['c'])
  })
})

describe('resolveStrandedExecution with a workflow graph', () => {
  const startedAt = '2026-07-01T01:00:12.000Z'

  it('marks completed when the last-completed step landed on a true graph dead end', () => {
    const graph = buildStrandGraph(makeDefinition())
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'code', step_node_id: 'a', step_namespace: 'a', error_message: null, completed_at: '2026-07-01T01:00:13.000Z' },
        { status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' },
      ],
      startedAt,
      graph,
    )
    expect(resolved.status).toBe('completed')
    expect(resolved.outcome).toBe('completed')
    expect(resolved.error_message).toBeNull()
    expect(resolved.failed_step_type).toBeNull()
    expect(resolved.completed_at).toBe('2026-07-01T01:00:13.500Z')
    expect(resolved.duration_ms).toBe(1500)
  })

  it('attributes outcome=successful when a success-namespace step completed', () => {
    const graph = buildStrandGraph(
      makeDefinition({
        trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key', success_node_namespaces: ['c'] } },
      }),
    )
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' },
      ],
      startedAt,
      graph,
    )
    expect(resolved.status).toBe('completed')
    expect(resolved.outcome).toBe('successful')
  })

  it('does NOT mark completed when the last-completed node still has outgoing edges (walk cut off mid-graph)', () => {
    const graph = buildStrandGraph(makeDefinition())
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'code', step_node_id: 'a', step_namespace: 'a', error_message: null, completed_at: '2026-07-01T01:00:13.000Z' },
      ],
      startedAt,
      graph,
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.error_message).toMatch(/recovered/i)
  })

  it('does NOT mark completed when the last-completed node id is absent from the definition (avoids a false dead-end)', () => {
    const graph = buildStrandGraph(makeDefinition())
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'code', step_node_id: 'ghost', step_namespace: 'ghost', error_message: null, completed_at: '2026-07-01T01:00:13.000Z' },
      ],
      startedAt,
      graph,
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.error_message).toMatch(/recovered/i)
  })

  it('still marks failed when the last step failed, even if its node is a graph dead end', () => {
    const graph = buildStrandGraph(makeDefinition())
    const resolved = resolveStrandedExecution(
      [
        { status: 'failed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: 'render error', completed_at: '2026-07-01T01:00:13.500Z' },
      ],
      startedAt,
      graph,
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBe('failed')
    expect(resolved.error_message).toBe('render error')
    expect(resolved.failed_step_type).toBe('response')
  })

  it('falls back to honest-unresolved when no graph is provided (unchanged behavior)', () => {
    const resolved = resolveStrandedExecution(
      [
        { status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' },
      ],
      startedAt,
    )
    expect(resolved.status).toBe('failed')
    expect(resolved.outcome).toBeNull()
    expect(resolved.error_message).toMatch(/recovered/i)
  })
})

interface FakeExec {
  id: string
  started_at: string
  workflow_version_id?: string | null
}

function makeSupabase(opts: {
  stranded: FakeExec[]
  stepsByExecutionId?: Record<string, StrandStepEvidence[]>
  definitionsByVersionId?: Record<string, WorkflowDefinition>
  strandedError?: { message: string } | null
  stepsError?: { message: string } | null
  versionError?: { message: string } | null
  updateErrorForId?: string | null
}) {
  const updates: { id: string; payload: Record<string, unknown> }[] = []
  const stepLookups: string[] = []
  const stepLimitCalls: number[] = []
  const versionFetches: string[] = []

  return {
    client: {
      from(table: string) {
        if (table === 'workflow_versions') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => {
                  versionFetches.push(id)
                  if (opts.versionError) return { data: null, error: opts.versionError }
                  const def = opts.definitionsByVersionId?.[id]
                  return { data: def ? { definition: def } : null, error: null }
                },
              }),
            }),
          }
        }
        if (table === 'workflow_executions') {
          return {
            select: () => ({
              eq: () => ({
                lt: () => ({
                  gte: () => ({
                    order: () => ({
                      limit: async () => ({ data: opts.stranded, error: opts.strandedError ?? null }),
                    }),
                  }),
                }),
              }),
            }),
            update: (payload: Record<string, unknown>) => ({
              eq: async (_col: string, id: string) => {
                updates.push({ id, payload })
                if (opts.updateErrorForId === id) return { error: { message: 'update failed' } }
                return { error: null }
              },
            }),
          }
        }
        if (table === 'execution_steps') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => {
                stepLookups.push(id)
                return {
                  gte: () => ({
                    // The real query bounds this with .limit(n) -- capture what
                    // was asked for so callers can assert it's actually applied,
                    // not just assumed. Only resolving here (not at .gte()) means
                    // the code under test MUST call .limit() to get any data back.
                    limit: async (n: number) => {
                      stepLimitCalls.push(n)
                      if (opts.stepsError) return { data: null, error: opts.stepsError }
                      return { data: opts.stepsByExecutionId?.[id] ?? [], error: null }
                    },
                  }),
                }
              },
            }),
          }
        }
        throw new Error(`unexpected table in test mock: ${table}`)
      },
    },
    updates,
    stepLimitCalls,
    stepLookups,
    versionFetches,
  }
}

describe('runReduceFinalizeStrandedExecutions', () => {
  it('does nothing and reports zero when no rows are stranded', async () => {
    const { client, updates } = makeSupabase({ stranded: [] })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 0 })
    expect(updates).toHaveLength(0)
  })

  it('finalizes a stranded execution as failed using its failed step as evidence', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-08T02:37:57.000Z' }],
      stepsByExecutionId: {
        'exec-1': [
          { status: 'failed', step_type: 'partner_bid', error_message: 'equifax_api_error: ACRO_GATEWAY', completed_at: '2026-07-08T02:38:05.000Z' },
        ],
      },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('exec-1')
    expect(updates[0].payload).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      error_message: 'equifax_api_error: ACRO_GATEWAY',
      failed_step_type: 'partner_bid',
    })
  })

  it('bounds the per-execution execution_steps read instead of fetching unbounded rows', async () => {
    const { client, stepLimitCalls } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-08T02:37:57.000Z' }],
      stepsByExecutionId: { 'exec-1': [] },
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(stepLimitCalls).toEqual([1000])
  })

  it('honestly labels a stranded execution with no step history, without touching execution_steps in a way that fabricates success', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-2', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsByExecutionId: {},
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(updates[0].payload.outcome).toBeNull()
    expect(updates[0].payload.error_message).toMatch(/recovered/i)
  })

  it('counts a scan failure as an error and does not process anything', async () => {
    const { client, updates } = makeSupabase({ stranded: [], strandedError: { message: 'db down' } })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(updates).toHaveLength(0)
  })

  it('counts a step-lookup failure as an error for that row without touching workflow_executions', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-3', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsError: { message: 'partition unavailable' },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(updates).toHaveLength(0)
  })

  it('counts an update failure as an error rather than silently reporting success', async () => {
    const { client } = makeSupabase({
      stranded: [{ id: 'exec-4', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsByExecutionId: { 'exec-4': [] },
      updateErrorForId: 'exec-4',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1 })
  })

  it('marks a stranded row completed when its last step landed on a graph dead end', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-01T01:00:12.000Z', workflow_version_id: 'ver-1' }],
      stepsByExecutionId: {
        'exec-1': [
          { status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' },
        ],
      },
      definitionsByVersionId: { 'ver-1': makeDefinition() },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(updates[0].payload).toMatchObject({ status: 'completed', outcome: 'completed', error_message: null })
  })

  it('fetches each workflow_version definition only once even across many rows sharing it', async () => {
    const { client, versionFetches } = makeSupabase({
      stranded: [
        { id: 'exec-1', started_at: '2026-07-01T01:00:12.000Z', workflow_version_id: 'ver-1' },
        { id: 'exec-2', started_at: '2026-07-01T01:05:12.000Z', workflow_version_id: 'ver-1' },
      ],
      stepsByExecutionId: {
        'exec-1': [{ status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' }],
        'exec-2': [{ status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:05:13.500Z' }],
      },
      definitionsByVersionId: { 'ver-1': makeDefinition() },
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(versionFetches).toEqual(['ver-1'])
  })

  it('falls back to honest-unresolved when the version definition cannot be loaded, without erroring the row', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-01T01:00:12.000Z', workflow_version_id: 'ver-missing' }],
      stepsByExecutionId: {
        'exec-1': [{ status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' }],
      },
      definitionsByVersionId: {},
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(updates[0].payload).toMatchObject({ status: 'failed', outcome: null })
    expect(updates[0].payload.error_message).toMatch(/recovered/i)
  })

  it('does not attempt a version fetch for a row with no workflow_version_id', async () => {
    const { client, versionFetches, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-01T01:00:12.000Z', workflow_version_id: null }],
      stepsByExecutionId: {
        'exec-1': [{ status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' }],
      },
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(versionFetches).toEqual([])
    expect(updates[0].payload).toMatchObject({ status: 'failed', outcome: null })
  })

  it('processes multiple stranded rows independently, one bad row does not block the rest', async () => {
    const { client, updates } = makeSupabase({
      stranded: [
        { id: 'exec-good', started_at: '2026-07-01T01:00:00.000Z' },
        { id: 'exec-bad', started_at: '2026-07-01T01:05:00.000Z' },
      ],
      stepsByExecutionId: { 'exec-good': [] },
      updateErrorForId: 'exec-bad',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 1 })
    expect(updates.map((u) => u.id)).toEqual(['exec-good', 'exec-bad'])
  })
})
