import { describe, it, expect, vi } from 'vitest'
import { createExecutionRecord, updateExecutionRecord } from '../step-logger'
import type { SupabaseClient } from '@supabase/supabase-js'

// Regression guard for the 2026-06-10 incident: the nightly partition purge
// held an ACCESS EXCLUSIVE lock, the workflow_executions insert hit the 8s
// statement timeout, createExecutionRecord threw with no retry, and 8
// executions lost their entire audit trail (execution row, step rows, lead
// sighting). The lock clears within seconds; a short backoff saves the row.

function clientWith(results: Array<{ error: { code?: string; message: string } | null }>) {
  let call = 0
  const insert = vi.fn().mockImplementation(() => Promise.resolve(results[Math.min(call++, results.length - 1)]))
  const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
  return { client, insert }
}

const record = {
  id: 'exec-1',
  workflow_id: 'wf-1',
  workflow_version_id: 'ver-1',
  source: 'test',
  trigger_payload: {},
  trace_id: 'trace-1',
  started_at: '2026-06-10T03:30:00Z',
  is_test: false,
}

describe('createExecutionRecord', () => {
  it('succeeds first try without sleeping', async () => {
    const { client, insert } = clientWith([{ error: null }])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('retries after a statement timeout and succeeds when the lock clears', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      { error: null },
    ])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('throws the last error once retries are exhausted', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '57014', message: 'still locked' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).rejects.toThrow(
      'workflow_executions insert failed: still locked'
    )
    expect(insert).toHaveBeenCalledTimes(3)
  })

  it('treats a unique violation on a retry as success (first attempt landed, response lost)', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('resolves when every attempt reports a duplicate (the row exists either way)', async () => {
    const { client } = clientWith([
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ])
    // A dup on attempt 0 retries once and then resolves via the retry-dup
    // rule. The audit row existing is the goal, so this is success, not an
    // error worth surfacing as "step logs failed to persist".
    await expect(createExecutionRecord(client, record, [1, 1])).resolves.toBeUndefined()
  })
})

describe('createExecutionRecord — error classification (2026-06-12 schema-cache 503)', () => {
  it('retries a PostgREST schema-cache 503 and succeeds once the reload finishes', async () => {
    const { client, insert } = clientWith([
      { error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } },
      { error: null },
    ])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('fails fast on a permanent data error without burning the retry budget', async () => {
    const { client, insert } = clientWith([
      { error: { code: '23502', message: 'null value in column "workflow_id" violates not-null constraint' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).rejects.toThrow('violates not-null constraint')
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

const stepEntry = {
  execution_id: 'exec-1',
  execution_started_at: '2026-06-11T00:00:00Z',
  step_namespace: 'equifax',
  step_type: 'code',
  status: 'completed' as const,
  input: {},
  output: {},
  retries_used: 0,
  started_at: '2026-06-11T00:00:00Z',
  completed_at: '2026-06-11T00:00:01Z',
  duration_ms: 1000,
  step_order: 1,
}

describe('flushStepLogs — transient retry', () => {
  it('retries the batch on a schema-cache 503 then succeeds (no per-row fallback)', async () => {
    vi.useFakeTimers()
    try {
      const insert = vi
        .fn()
        .mockResolvedValueOnce({ error: { code: 'PGRST002', message: 'schema cache' } })
        .mockResolvedValueOnce({ error: null })
      const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
      const { flushStepLogs } = await import('../step-logger')
      const p = flushStepLogs(client, [stepEntry], '')
      await vi.advanceTimersByTimeAsync(2100)
      await expect(p).resolves.toBeNull()
      expect(insert).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a permanent row error; isolates it per-row instead', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue({ error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const { flushStepLogs } = await import('../step-logger')
    const result = await flushStepLogs(client, [stepEntry], '')
    // One batch attempt (permanent -> no retry) plus one per-row isolation attempt.
    expect(insert).toHaveBeenCalledTimes(2)
    expect(result).toContain('1/1 step rows failed')
  })
})

describe('updateExecutionRecord', () => {
  it('retries a schema-cache 503 on the finalize update then succeeds', async () => {
    vi.useFakeTimers()
    try {
      let call = 0
      const results = [
        { error: { code: 'PGRST002', message: 'schema cache' } },
        { data: [{ id: 'exec-1' }] },
      ]
      const select = vi.fn().mockImplementation(() => Promise.resolve(results[Math.min(call++, results.length - 1)]))
      const eq2 = vi.fn().mockReturnValue({ select })
      const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
      const update = vi.fn().mockReturnValue({ eq: eq1 })
      const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

      const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', {
        status: 'completed',
        completed_at: '2026-06-11T00:00:01Z',
        duration_ms: 1000,
      })
      await vi.advanceTimersByTimeAsync(2100)
      await p
      expect(select).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes response_status through to the workflow_executions update (issue #30)', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: 'exec-1' }] })
    const eq2 = vi.fn().mockReturnValue({ select })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const update = vi.fn().mockReturnValue({ eq: eq1 })
    const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

    await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', {
      status: 'completed',
      completed_at: '2026-06-11T00:00:01Z',
      duration_ms: 1000,
      response_body: { ok: true },
      response_status: 200,
    })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ response_status: 200, response_body: { ok: true } })
    )
  })
})

describe('flushStepLogs stamping', () => {
  it('stamps workflow_id and is_test on every row (issue #32: per-namespace percentile sampling)', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const { flushStepLogs } = await import('../step-logger')

    const entry = {
      execution_id: 'exec-1',
      execution_started_at: '2026-06-11T00:00:00Z',
      step_namespace: 'equifax',
      step_type: 'code',
      status: 'completed' as const,
      input: {},
      output: {},
      retries_used: 0,
      started_at: '2026-06-11T00:00:00Z',
      completed_at: '2026-06-11T00:00:01Z',
      duration_ms: 1000,
      step_order: 1,
    }
    await flushStepLogs(client, [entry], '', { workflowId: 'wf-1', isTest: false })

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ workflow_id: 'wf-1', is_test: false, step_namespace: 'equifax' }),
    ])
  })
})
