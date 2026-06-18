import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../index'
import type { StepLogEntry } from '../step-logger'

// Force the Hyperdrive path on and make the direct insert fail transiently, so
// flushStepLogs takes the PostgREST fallback branch — which must drop a
// hyperdrive-fallback marker (#134). Isolated in its own file so this mock
// doesn't affect the main step-logger tests.
vi.mock('../../lib/pg-writer', async () => {
  const actual = await vi.importActual<typeof import('../../lib/pg-writer')>('../../lib/pg-writer')
  return {
    ...actual,
    hyperdriveEnabled: () => true,
    pgInsert: vi.fn().mockRejectedValue(new Error('connection refused')),
  }
})

const stepEntry: StepLogEntry = {
  execution_id: 'e1',
  execution_started_at: '2026-01-01T00:00:00.000Z',
  step_namespace: 's1',
  step_type: 'code',
  status: 'completed',
  input: {},
  output: {},
  retries_used: 0,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:00.100Z',
  duration_ms: 100,
  step_order: 0,
}

describe('flushStepLogs — Hyperdrive fallback marker (#134)', () => {
  it('drops a hdfb:m: marker when the direct insert fails and it falls back to PostgREST', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const env = { IDEMPOTENCY: { put } } as unknown as Env
    // PostgREST fallback insert succeeds.
    const client = { from: () => ({ insert: async () => ({ error: null }) }) }

    const { flushStepLogs } = await import('../step-logger')
    await flushStepLogs(client as never, [stepEntry], '', undefined, env)

    expect(put).toHaveBeenCalled()
    expect(put.mock.calls[0][0]).toMatch(/^hdfb:m:/)
  })
})
