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
  isNotFoundError: (e: { status?: number }) => e?.status === 404,
  // The real reader is tested on its own against the real message shape. Here
  // it only has to be PRESENT: leaving it out of this mock made it undefined,
  // which throws on every error path rather than reporting one (#874).
  archiveUnavailableFrom: (e: { status?: number }) =>
    e?.status === 503
      ? { waitingFor: 'the execution archive', detail: 'did not answer' }
      : null,
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
    // Carries a status because that is what api.ts's req() attaches. Rejecting
    // with a bare message meant this test agreed with a reader that could not
    // recognise a real 404 (#874).
    getMock.mockRejectedValueOnce(
      Object.assign(new Error('Execution not found'), { status: 404 })
    )
    const { result } = renderHook(() => useExecution('exec-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.notFound).toBe(true)
    expect(result.current.loading).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3) })
    expect(getMock).toHaveBeenCalledTimes(1)
  })
})

describe('useExecution, the archive states (#874)', () => {
  it('reports an unreachable archive as its own state, not as not-found', async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error('Archive temporarily unavailable'), { status: 503 }))

    const { result } = renderHook(() => useExecution('exec-old'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(result.current.archiveUnavailable).toEqual({
      waitingFor: 'the execution archive',
      detail: 'did not answer',
    })
    // The two states are mutually exclusive. If both were set the page would
    // have to guess which screen to render.
    expect(result.current.notFound).toBe(false)
  })

  it('still reports a genuine not-found as not-found, with no archive state', async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error('Execution not found'), { status: 404 }))

    const { result } = renderHook(() => useExecution('exec-ghost'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(result.current.notFound).toBe(true)
    expect(result.current.archiveUnavailable).toBeNull()
  })

  it('reload retries a failed load and clears the archive state on success', async () => {
    getMock
      .mockRejectedValueOnce(Object.assign(new Error('Archive temporarily unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ id: 'exec-old', status: 'completed', steps: [] })

    const { result } = renderHook(() => useExecution('exec-old'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.archiveUnavailable).not.toBeNull()

    await act(async () => {
      result.current.reload()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(getMock).toHaveBeenCalledTimes(2)
    expect(result.current.archiveUnavailable).toBeNull()
    expect(result.current.execution).toMatchObject({ id: 'exec-old' })
  })
})
