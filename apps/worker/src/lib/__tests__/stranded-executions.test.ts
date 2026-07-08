import { describe, it, expect } from 'vitest'
import { resolveStrandedExecution } from '../stranded-executions'

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
