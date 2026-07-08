import { describe, it, expect } from 'vitest'
import { resolveStrandedExecution, runReduceFinalizeStrandedExecutions, type StrandStepEvidence } from '../stranded-executions'

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

interface FakeExec {
  id: string
  started_at: string
}

function makeSupabase(opts: {
  stranded: FakeExec[]
  stepsByExecutionId?: Record<string, StrandStepEvidence[]>
  strandedError?: { message: string } | null
  stepsError?: { message: string } | null
  updateErrorForId?: string | null
}) {
  const updates: { id: string; payload: Record<string, unknown> }[] = []
  const stepLookups: string[] = []

  return {
    client: {
      from(table: string) {
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
                  gte: async () => {
                    if (opts.stepsError) return { data: null, error: opts.stepsError }
                    return { data: opts.stepsByExecutionId?.[id] ?? [], error: null }
                  },
                }
              },
            }),
          }
        }
        throw new Error(`unexpected table in test mock: ${table}`)
      },
    },
    updates,
    stepLookups,
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
