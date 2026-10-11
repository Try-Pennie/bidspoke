import { describe, it, expect, vi } from 'vitest'
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

  // #1112: measured on 2026-09-02. Every one of 117 recovered rows over 14 days
  // took the honest-unresolved branch and not one took the dead-end branch, so a
  // signal shipped as the precise one had never fired in production. The cause is
  // here: two steps routinely complete in the SAME millisecond, the sort by
  // completed_at leaves them tied, and the winner is whichever order the database
  // read happened to return (it has no ORDER BY: LESSONS L343). Real run
  // 01a06408-5e54-71f0-9038-b0badfaf2210 finished with route_response_end (a
  // branch_end, zero outgoing edges) and patch_prospect (one outgoing edge) both
  // stamped 21:31:08.966, the salesforce step won the coin flip, and a completed
  // run was recorded as a failure.
  //
  // Reaching a dead end is evidence regardless of which tied step is listed
  // first, so the answer must not depend on the order at all.
  describe('steps tied at the same completed_at (#1112)', () => {
    const tied = '2026-07-01T01:00:13.500Z'
    const deadEnd = { status: 'completed', step_type: 'branch_end', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: tied }
    const midGraph = { status: 'completed', step_type: 'salesforce', step_node_id: 'b', step_namespace: 'b', error_message: null, completed_at: tied }

    it('marks completed when a tied step landed on a dead end, whichever order the read returned', () => {
      const graph = buildStrandGraph(makeDefinition())
      const midGraphFirst = resolveStrandedExecution([midGraph, deadEnd], startedAt, graph)
      const deadEndFirst = resolveStrandedExecution([deadEnd, midGraph], startedAt, graph)

      expect(midGraphFirst.status).toBe('completed')
      expect(deadEndFirst.status).toBe('completed')
      expect(midGraphFirst).toEqual(deadEndFirst)
    })

    // Conservative direction: a failure among the tied steps outranks a dead end,
    // so a tie can never upgrade a failed walk into a clean completion.
    it('still marks failed when one of the tied steps failed', () => {
      const graph = buildStrandGraph(makeDefinition())
      const failed = { status: 'failed', step_type: 'salesforce', step_node_id: 'b', step_namespace: 'b', error_message: 'Salesforce 503', completed_at: tied }
      const resolved = resolveStrandedExecution([deadEnd, failed], startedAt, graph)
      expect(resolved.status).toBe('failed')
      expect(resolved.error_message).toBe('Salesforce 503')
    })

    // A dead end reached EARLIER than the last step is not evidence the walk
    // finished: something ran after it. Only the final moment counts.
    it('does not treat a dead end from an earlier moment as proof the walk finished', () => {
      const graph = buildStrandGraph(makeDefinition())
      const resolved = resolveStrandedExecution(
        [
          { ...deadEnd, completed_at: '2026-07-01T01:00:13.000Z' },
          { ...midGraph, completed_at: tied },
        ],
        startedAt,
        graph,
      )
      expect(resolved.status).toBe('failed')
      expect(resolved.error_message).toContain('could not be confirmed')
    })
  })

  // #1112: when the graph cannot confirm (the walk answered from a node that
  // still has outgoing edges, which is what the Engine flow does when it responds
  // from inside a code node), the engine's OWN verdict is already recorded in
  // lead_sightings.outcome. Real run 01a06409-8452-73c6-a47c-81d5bf4a4345 is
  // exactly this shape: last step create_prospect, one outgoing edge, sighting
  // outcome 'completed'.
  //
  // Note this cannot read workflow_executions.sighting_finalize instead, even
  // though that projection exists for the strand drain: it is written by the very
  // finalize UPDATE that eviction destroys, so it is null on 119 of 119 stranded
  // rows, i.e. absent for precisely the population it was built to serve.
  describe('lead_sightings outcome as evidence (#1112)', () => {
    const midGraphStep = [
      { status: 'completed', step_type: 'salesforce', step_node_id: 'b', step_namespace: 'b', error_message: null, completed_at: '2026-07-01T01:00:13.500Z' },
    ]

    it('claims completed when the sighting recorded a non-failed outcome', () => {
      const resolved = resolveStrandedExecution(midGraphStep, startedAt, buildStrandGraph(makeDefinition()), { outcome: 'completed' })
      expect(resolved.status).toBe('completed')
      expect(resolved.outcome).toBe('completed')
      expect(resolved.error_message).toBeNull()
    })

    it('carries a successful outcome through rather than flattening it to completed', () => {
      const resolved = resolveStrandedExecution(midGraphStep, startedAt, undefined, { outcome: 'successful' })
      expect(resolved.status).toBe('completed')
      expect(resolved.outcome).toBe('successful')
    })

    it('marks failed when the sighting recorded a failure, even with no failed step', () => {
      const resolved = resolveStrandedExecution(midGraphStep, startedAt, undefined, { outcome: 'failed' })
      expect(resolved.status).toBe('failed')
      expect(resolved.outcome).toBe('failed')
    })

    // A sighting whose own finalize was lost carries a null outcome. That is
    // missing evidence, not a verdict, and must not read as one.
    it('stays honestly unresolved when the sighting exists but never recorded an outcome', () => {
      const resolved = resolveStrandedExecution(midGraphStep, startedAt, undefined, { outcome: null })
      expect(resolved.status).toBe('failed')
      expect(resolved.outcome).toBeNull()
      expect(resolved.error_message).toContain('could not be confirmed')
    })

    // The column is a plain text field, so it can hold anything. A value outside
    // the three the engine writes is not a verdict this code can interpret, and
    // guessing which way it leans is how a rejected lead gets recorded as served
    // (LESSONS L257: listing the bad values admits every one nobody listed).
    it('does not trust a sighting outcome outside the vocabulary the engine writes', () => {
      const resolved = resolveStrandedExecution(midGraphStep, startedAt, undefined, { outcome: 'partially_ok' })
      expect(resolved.status).toBe('failed')
      expect(resolved.outcome).toBeNull()
      expect(resolved.error_message).toContain('could not be confirmed')
    })

    // Concrete evidence outranks a recorded verdict: a step that actually threw
    // names the failing node and its message, which the sighting cannot.
    it('prefers a genuinely failed step over the sighting outcome', () => {
      const resolved = resolveStrandedExecution(
        [{ status: 'failed', step_type: 'salesforce', step_node_id: 'b', step_namespace: 'b', error_message: 'Salesforce 503', completed_at: '2026-07-01T01:00:13.500Z' }],
        startedAt,
        undefined,
        { outcome: 'completed' },
      )
      expect(resolved.status).toBe('failed')
      expect(resolved.error_message).toBe('Salesforce 503')
      expect(resolved.failed_step_type).toBe('salesforce')
    })
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
  // Ids whose UPDATE matches zero rows (row purged between scan and update).
  updateMatchesNoRowsForId?: string | null
  sightingsByExecutionId?: Record<string, { outcome: string | null }>
  sightingError?: { message: string } | null
}) {
  const updates: { id: string; payload: Record<string, unknown>; filters: Record<string, unknown> }[] = []
  const stepLookups: string[] = []
  const stepLimitCalls: number[] = []
  const stepOrderCalls: { column: string; ascending: boolean }[] = []
  const versionFetches: string[] = []
  const sightingLookups: { executionId: string; startedAt: string }[] = []

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
            update: (payload: Record<string, unknown>) => {
              // The real query ends in .select('id') so a zero-row match is
              // detectable rather than reported as a silent success (#583).
              // Every eq is recorded, so a test can see the filters an update used.
              const filters: Record<string, unknown> = {}
              const chain = {
                eq: (col: string, value: unknown) => {
                  filters[col] = value
                  return chain
                },
                select: async () => {
                  const id = filters.id as string
                  updates.push({ id, payload, filters })
                  if (opts.updateErrorForId === id) return { data: null, error: { message: 'update failed' } }
                  if (opts.updateMatchesNoRowsForId === id) return { data: [], error: null }
                  return { data: [{ id }], error: null }
                },
              }
              return chain
            },
          }
        }
        if (table === 'execution_steps') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => {
                stepLookups.push(id)
                return {
                  gte: () => ({
                    // The real query declares an ORDER BY and bounds the read with
                    // .limit(n). Neither resolves on its own, so the code under
                    // test MUST call both to get any data back: a read with no
                    // ORDER BY returns rows in whatever order the store chose
                    // (L343), which is what let tied steps decide #1112 at random.
                    order: (col: string, o?: { ascending?: boolean }) => {
                      stepOrderCalls.push({ column: col, ascending: o?.ascending !== false })
                      return {
                        limit: async (n: number) => {
                          stepLimitCalls.push(n)
                          if (opts.stepsError) return { data: null, error: opts.stepsError }
                          return { data: opts.stepsByExecutionId?.[id] ?? [], error: null }
                        },
                      }
                    },
                  }),
                }
              },
            }),
          }
        }
        if (table === 'lead_sightings') {
          return {
            select: () => ({
              eq: (_c: string, executionId: string) => ({
                // The partition key. A sighting read without it scans every
                // monthly partition.
                eq: (_c2: string, startedAt: string) => ({
                  maybeSingle: async () => {
                    sightingLookups.push({ executionId, startedAt })
                    if (opts.sightingError) return { data: null, error: opts.sightingError }
                    const s = opts.sightingsByExecutionId?.[executionId]
                    return { data: s ?? null, error: null }
                  },
                }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table in test mock: ${table}`)
      },
    },
    updates,
    stepLimitCalls,
    stepOrderCalls,
    stepLookups,
    versionFetches,
    sightingLookups,
  }
}

describe('runReduceFinalizeStrandedExecutions', () => {
  it('does nothing and reports zero when no rows are stranded', async () => {
    const { client, updates } = makeSupabase({ stranded: [] })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 0, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 } })
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
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: expect.any(Object) })
    expect(result.byBranch.failed_step).toBe(1) // #1133: the row is tallied to its branch
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
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: expect.any(Object) })
    expect(result.byBranch.unresolved).toBe(1) // #1133: the fallback row is tallied to its branch
    expect(updates[0].payload.outcome).toBeNull()
    expect(updates[0].payload.error_message).toMatch(/recovered/i)
  })

  it('counts a scan failure as an error and does not process anything', async () => {
    const { client, updates } = makeSupabase({ stranded: [], strandedError: { message: 'db down' } })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 } })
    expect(result.byBranch).toEqual({ failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 }) // #1133: nothing resolved
    expect(updates).toHaveLength(0)
  })

  it('counts a step-lookup failure as an error for that row without touching workflow_executions', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-3', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsError: { message: 'partition unavailable' },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 } })
    expect(result.byBranch).toEqual({ failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 }) // #1133: nothing resolved
    expect(updates).toHaveLength(0)
  })

  it('counts an update failure as an error rather than silently reporting success', async () => {
    const { client } = makeSupabase({
      stranded: [{ id: 'exec-4', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsByExecutionId: { 'exec-4': [] },
      updateErrorForId: 'exec-4',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 0, errors: 1, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 } })
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
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: expect.any(Object) })
    expect(result.byBranch.graph_dead_end).toBe(1) // #1133: the dead-end row is tallied to its branch
    expect(updates[0].payload).toMatchObject({ status: 'completed', outcome: 'completed', error_message: null })
  })

  // #606: a malformed definition makes buildStrandGraph throw. loadStrandGraph
  // catches it, logs the cause via formatErr (never a bare String() that would
  // print "[object Object]"), and falls back to the honest-unresolved labeling so
  // the run continues instead of failing the row.
  it('logs the real cause and falls back gracefully when a definition is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-bad', started_at: '2026-07-01T01:00:12.000Z', workflow_version_id: 'v-bad' }],
      stepsByExecutionId: { 'exec-bad': [] },
      // `nodes: 5` is truthy but not iterable, so `for (const n of definition.nodes)` throws.
      definitionsByVersionId: { 'v-bad': { nodes: 5 } as unknown as WorkflowDefinition },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)

    // The row is still resolved (unresolved-label fallback), not counted as an error.
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: expect.any(Object) })
    expect(updates).toHaveLength(1)
    // The warn log names the cause instead of blanking it to "[object Object]".
    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.find((c) => String(c[0]).includes('malformed definition'))
    expect(logged).toBeDefined()
    expect(JSON.stringify(logged![1])).not.toContain('[object Object]')
    warn.mockRestore()
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
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 1 } })
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
    expect(result).toEqual({ processed: 1, errors: 1, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 1 } })
    expect(updates.map((u) => u.id)).toEqual(['exec-good', 'exec-bad'])
  })
})

// #583: the drain's UPDATE is keyed on id alone, and PostgREST reports a
// zero-row UPDATE as a plain success. The drain counted every such write as
// processed++, so the repair-job metric claimed work it had not done.
//
// A vanished row here is benign, not an error: the nightly partition purge can
// drop the row between the scan and the update. It just must not be counted as
// a repair.
describe('runReduceFinalizeStrandedExecutions: sighting evidence and ordering (#1112)', () => {
  const startedAt = '2026-07-01T01:00:00.000Z'
  const midGraphOnly: Record<string, StrandStepEvidence[]> = {
    'exec-1': [
      { status: 'completed', step_type: 'salesforce', step_node_id: 'b', step_namespace: 'b', error_message: null, completed_at: '2026-07-01T01:00:02.000Z' },
    ],
  }

  // Descending, not ascending: the read is capped at 1000 rows, and every piece
  // of evidence the resolver uses lives at the END of the run. An ascending cap
  // would discard exactly the steps that decide the outcome.
  it('orders the step read newest-first so tied rows cannot arrive in an arbitrary order', async () => {
    const { client, stepOrderCalls } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: startedAt, workflow_version_id: null }],
      stepsByExecutionId: midGraphOnly,
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(stepOrderCalls).toContainEqual({ column: 'completed_at', ascending: false })
  })

  it('finalizes from the sighting outcome when the graph cannot confirm', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: startedAt, workflow_version_id: null }],
      stepsByExecutionId: midGraphOnly,
      sightingsByExecutionId: { 'exec-1': { outcome: 'successful' } },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result.processed).toBe(1)
    expect(updates[0].payload.status).toBe('completed')
    expect(updates[0].payload.outcome).toBe('successful')
  })

  it('scopes the sighting read by the partition key, not the execution id alone', async () => {
    const { client, sightingLookups } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: startedAt, workflow_version_id: null }],
      stepsByExecutionId: midGraphOnly,
      sightingsByExecutionId: { 'exec-1': { outcome: 'completed' } },
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(sightingLookups).toEqual([{ executionId: 'exec-1', startedAt }])
  })

  // The lookup is a precision boost, exactly like the graph load beside it. A
  // failure to read it must leave the row honestly unresolved, never error it.
  it('falls back to honest-unresolved when the sighting read fails, without erroring the row', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: startedAt, workflow_version_id: null }],
      stepsByExecutionId: midGraphOnly,
      sightingError: { message: 'sighting read failed' },
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result.errors).toBe(0)
    expect(result.processed).toBe(1)
    expect(updates[0].payload.status).toBe('failed')
    expect(updates[0].payload.error_message).toContain('could not be confirmed')
  })

  // Graph confirmation is cheaper and already conclusive, so a row it can settle
  // must not spend a sighting read at all.
  it('does not read the sighting when the graph already confirmed completion', async () => {
    const { client, sightingLookups } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: startedAt, workflow_version_id: 'v1' }],
      definitionsByVersionId: { v1: makeDefinition() },
      stepsByExecutionId: {
        'exec-1': [
          { status: 'completed', step_type: 'response', step_node_id: 'c', step_namespace: 'c', error_message: null, completed_at: '2026-07-01T01:00:02.000Z' },
        ],
      },
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(sightingLookups).toEqual([])
  })
})

describe('runReduceFinalizeStrandedExecutions: zero-row update (#583)', () => {
  const stranded = [{ id: 'exec-gone', started_at: '2026-07-08T02:37:57.000Z' }]
  const steps = {
    'exec-gone': [
      { status: 'failed' as const, step_type: 'partner_bid', error_message: 'boom', completed_at: '2026-07-08T02:38:05.000Z' },
    ],
  }

  it('does not count a vanished row as processed', async () => {
    const { client } = makeSupabase({
      stranded,
      stepsByExecutionId: steps,
      updateMatchesNoRowsForId: 'exec-gone',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result.processed).toBe(0)
  })

  it('reports the vanished row separately rather than as an error', async () => {
    const { client } = makeSupabase({
      stranded,
      stepsByExecutionId: steps,
      updateMatchesNoRowsForId: 'exec-gone',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result.vanished).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('still counts a genuine repair as processed and reports no vanished rows', async () => {
    const { client } = makeSupabase({ stranded, stepsByExecutionId: steps })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result).toEqual({ processed: 1, errors: 0, vanished: 0, byBranch: expect.any(Object) })
    // #1133: the per-branch tally is consistent with the processed count (the one
    // repaired row is tallied to exactly one branch).
    const tallied = Object.values(result.byBranch).reduce((a, b) => a + b, 0)
    expect(tallied).toBe(result.processed)
  })

  it('still counts a real update failure as an error, not as a vanished row', async () => {
    const { client } = makeSupabase({
      stranded,
      stepsByExecutionId: steps,
      updateErrorForId: 'exec-gone',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never)
    expect(result.errors).toBe(1)
    expect(result.vanished).toBe(0)
    expect(result.processed).toBe(0)
  })
})

/**
 * #1883, defect A: a run cut off during a database stall kept no record of what
 * it answered, so the drain could only label it unresolved. The engine now
 * journals the answer in KV at the answer, and the drain restores it.
 */
describe('restoring a stranded run from its answer journal (#1883)', () => {
  const journal = {
    execution_id: 'exec-j',
    started_at: '2026-10-08T12:20:40.000Z',
    status: 'completed',
    outcome: 'completed',
    final_node_namespace: 'reject_response',
    final_node_id: 'node-9',
    completed_at: '2026-10-08T12:20:43.700Z',
    duration_ms: 3700,
    response_status: 200,
    response_body: { status: 'rejected' },
    error_message: null,
    failed_step_type: null,
    sighting_finalize: { outcome: 'completed', winning_partner_slug: null },
    cost_usd: 0.0012,
    written_at: '2026-10-08T12:20:43.701Z',
  }

  it('writes the answer the run actually gave, read from the journal, before any inference', async () => {
    const { client, updates, stepLookups } = makeSupabase({
      stranded: [{ id: 'exec-j', started_at: journal.started_at }],
      stepsByExecutionId: { 'exec-j': [] },
    })
    const readJournal = vi.fn(async (id: string) => (id === 'exec-j' ? journal : null))
    const result = await runReduceFinalizeStrandedExecutions(client as never, { readJournal })
    expect(result.processed).toBe(1)
    expect(readJournal).toHaveBeenCalledWith('exec-j')
    expect(updates[0].payload).toMatchObject({
      status: 'completed',
      outcome: 'completed',
      completed_at: journal.completed_at,
      duration_ms: 3700,
      response_status: 200,
      response_body: { status: 'rejected' },
      final_node_namespace: 'reject_response',
      final_node_id: 'node-9',
      error_message: null,
      // The sighting drain finalizes a stranded sighting from this projection.
      sighting_finalize: { outcome: 'completed', winning_partner_slug: null },
      cost_usd: 0.0012,
    })
    // The journal is the engine's own record, so no step inference is needed.
    expect(stepLookups).toEqual([])
    // Only a row still at running, in its own partition: a finalize that landed
    // after the scan must not be overwritten by the journal.
    expect(updates[0].filters).toEqual({ id: 'exec-j', started_at: journal.started_at, status: 'running' })
  })

  it('falls back to the existing evidence when there is no journal, or it cannot be read', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-1', started_at: '2026-07-01T01:00:00.000Z' }, { id: 'exec-2', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsByExecutionId: { 'exec-1': [], 'exec-2': [] },
    })
    const readJournal = vi.fn(async (id: string) => {
      if (id === 'exec-2') throw new Error('kv down')
      return null
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never, { readJournal })
    expect(result.processed).toBe(2)
    expect(updates.map((u) => u.payload.outcome)).toEqual([null, null])
  })

  it('does not count a row its own finalize reached first as vanished', async () => {
    const { client } = makeSupabase({
      stranded: [{ id: 'exec-j', started_at: journal.started_at }],
      stepsByExecutionId: { 'exec-j': [] },
      updateMatchesNoRowsForId: 'exec-j',
    })
    const result = await runReduceFinalizeStrandedExecutions(client as never, { readJournal: async () => journal })
    expect(result).toEqual({ processed: 0, errors: 0, vanished: 0, byBranch: { failed_step: 0, graph_dead_end: 0, sighting_outcome: 0, unresolved: 0 } })
  })

  it('ignores a journal whose start time is not the start of the row', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-j', started_at: journal.started_at }],
      stepsByExecutionId: { 'exec-j': [] },
    })
    await runReduceFinalizeStrandedExecutions(client as never, { readJournal: async () => ({ ...journal, started_at: '2026-10-07T12:20:40.000Z' }) })
    expect(updates[0].payload.outcome).toBeNull()
  })

  it('ignores a journal written for another run', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-j', started_at: journal.started_at }],
      stepsByExecutionId: { 'exec-j': [] },
    })
    const readJournal = vi.fn(async () => ({ ...journal, execution_id: 'someone-else' }))
    await runReduceFinalizeStrandedExecutions(client as never, { readJournal })
    expect(updates[0].payload.outcome).toBeNull()
  })

  it('names the cause as the work after the answer being cancelled, not an isolate eviction', async () => {
    const { client, updates } = makeSupabase({
      stranded: [{ id: 'exec-2', started_at: '2026-07-01T01:00:00.000Z' }],
      stepsByExecutionId: {},
    })
    await runReduceFinalizeStrandedExecutions(client as never)
    expect(updates[0].payload.error_message).toMatch(/work after the answer was cancelled before finalize/)
    expect(updates[0].payload.error_message).not.toMatch(/isolate evicted/)
  })
})
