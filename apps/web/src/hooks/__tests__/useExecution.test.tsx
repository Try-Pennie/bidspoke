/**
 * Issue #477 (AUD-012): the execution detail page fetched once and never
 * re-fetched, so a running execution's badge was frozen forever. useExecution
 * polls while the execution is running and stops once it reaches a terminal
 * status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const getMock = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { executions: { get: (...args: unknown[]) => getMock(...args) } },
}))
vi.mock('@/lib/execution-retention', () => ({
  isNotFoundError: (e: { message?: string }) => (e?.message ?? '').includes('not found'),
}))

import { useExecution, POLL_INTERVAL_MS } from '../useExecution'

function running(over: Record<string, unknown> = {}) {
  return { id: 'exec-1', status: 'running', started_at: new Date().toISOString(), steps: [], ...over }
}

beforeEach(() => {
  vi.useFakeTimers()
  getMock.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('useExecution (#477)', () => {
  it('polls while running and stops when the status turns terminal', async () => {
    getMock
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running({ status: 'completed' }))

    const { result } = renderHook(() => useExecution('exec-1'))

    // First load
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.execution?.status).toBe('running')
    expect(getMock).toHaveBeenCalledTimes(1)

    // Second poll — still running
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
    expect(getMock).toHaveBeenCalledTimes(2)
    expect(result.current.execution?.status).toBe('running')

    // Third poll — completed; polling must stop after this
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
    expect(getMock).toHaveBeenCalledTimes(3)
    expect(result.current.execution?.status).toBe('completed')

    // No further polls once terminal
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3) })
    expect(getMock).toHaveBeenCalledTimes(3)
  })

  it('does not poll when the first load is already terminal', async () => {
    getMock.mockResolvedValueOnce(running({ status: 'completed' }))
    const { result } = renderHook(() => useExecution('exec-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.execution?.status).toBe('completed')
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3) })
    expect(getMock).toHaveBeenCalledTimes(1)
  })

  it('flags a not-found error and stops polling', async () => {
    getMock.mockRejectedValueOnce(new Error('execution not found'))
    const { result } = renderHook(() => useExecution('exec-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.notFound).toBe(true)
    expect(result.current.loading).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3) })
    expect(getMock).toHaveBeenCalledTimes(1)
  })
})
