/**
 * Issue #492 (AUD-062): the "still-alive" signal. A long action must show that
 * it is progressing (elapsed time), not just a static spinner. useElapsed
 * reports whole seconds since an action became active and resets when it ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useElapsed } from '../useElapsed'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useElapsed (#492)', () => {
  it('reports 0 when inactive', () => {
    const { result } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: false },
    })
    expect(result.current).toBe(0)
  })

  it('ticks up in whole seconds while active', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: false },
    })
    rerender({ active: true })
    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(result.current).toBe(3)
  })

  it('resets to 0 when the action ends', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: true },
    })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current).toBe(5)
    rerender({ active: false })
    expect(result.current).toBe(0)
  })

  it('restarts from 0 on a fresh activation', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: true },
    })
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(result.current).toBe(4)
    rerender({ active: false })
    rerender({ active: true })
    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current).toBe(1)
  })
})
