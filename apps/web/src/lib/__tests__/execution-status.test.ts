import { describe, it, expect } from 'vitest'
import { resolveExecutionStatus, STALL_THRESHOLD_MS } from '../execution-status'

describe('resolveExecutionStatus', () => {
  const start = 1_000_000

  it('passes terminal statuses through unchanged', () => {
    for (const s of ['completed', 'degraded', 'failed', 'skipped', 'failed_with_fallback']) {
      expect(resolveExecutionStatus(s, start, start + 5 * 60_000)).toBe(s)
    }
  })

  it('keeps a fresh running execution as running', () => {
    expect(resolveExecutionStatus('running', start, start + 10_000)).toBe('running')
  })

  it('keeps running right up to (but not at) the stall threshold', () => {
    expect(resolveExecutionStatus('running', start, start + STALL_THRESHOLD_MS - 1)).toBe('running')
  })

  it('converts a long-running execution to stalled at the threshold', () => {
    expect(resolveExecutionStatus('running', start, start + STALL_THRESHOLD_MS)).toBe('stalled')
    expect(resolveExecutionStatus('running', start, start + 5 * 60_000)).toBe('stalled')
  })

  it('maps an unrecognized status to neutral unknown, not running', () => {
    expect(resolveExecutionStatus('queued', start, start + 1000)).toBe('unknown')
    expect(resolveExecutionStatus('', start, start + 1000)).toBe('unknown')
  })

  it('honors a custom stall threshold', () => {
    expect(resolveExecutionStatus('running', start, start + 20_000, 30_000)).toBe('running')
    expect(resolveExecutionStatus('running', start, start + 31_000, 30_000)).toBe('stalled')
  })
})
