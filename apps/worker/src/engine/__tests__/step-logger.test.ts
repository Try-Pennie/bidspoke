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

describe('updateExecutionRecord', () => {
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
