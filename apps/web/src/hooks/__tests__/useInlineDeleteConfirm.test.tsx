import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { INLINE_DELETE_CONFIRM_MS, useInlineDeleteConfirm } from '../useInlineDeleteConfirm'

/**
 * Issue #546. This pattern was hand-copied four times, so its timing, styling and
 * behaviour could only be changed in four places at once.
 */
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useInlineDeleteConfirm (#546)', () => {
  it('confirms nothing until asked', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    expect(result.current.confirmingId).toBeNull()
    expect(result.current.isConfirming('a')).toBe(false)
  })

  it('opens the confirm for one row', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    expect(result.current.isConfirming('a')).toBe(true)
    expect(result.current.isConfirming('b')).toBe(false)
  })

  it('auto-dismisses after the window', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => { vi.advanceTimersByTime(INLINE_DELETE_CONFIRM_MS) })
    expect(result.current.confirmingId).toBeNull()
  })

  it('is still open just before the window closes', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => { vi.advanceTimersByTime(INLINE_DELETE_CONFIRM_MS - 1) })
    expect(result.current.isConfirming('a')).toBe(true)
  })

  it('moves the confirm when another row asks, without the first row s timer closing it', () => {
    // The old copies restarted the timer on each request, so the second row got
    // a full window. Same here, and the first row must not be left open.
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => result.current.request('b'))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current.isConfirming('b')).toBe(true)
    expect(result.current.isConfirming('a')).toBe(false)
  })

  it('closes on cancel', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => result.current.cancel())
    expect(result.current.confirmingId).toBeNull()
  })

  it('closes on commit, so the buttons go on the click rather than on the response', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => result.current.commit())
    expect(result.current.confirmingId).toBeNull()
  })

  it('does not reopen after cancel when the original window would have elapsed', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    act(() => result.current.cancel())
    act(() => { vi.advanceTimersByTime(INLINE_DELETE_CONFIRM_MS * 2) })
    expect(result.current.confirmingId).toBeNull()
  })

  it('drops its pending timer when the component goes away', () => {
    // Every hand-written copy leaked this, so navigating off mid-confirm left a
    // timeout that set state on a component that no longer existed.
    const { result, unmount } = renderHook(() => useInlineDeleteConfirm())
    act(() => result.current.request('a'))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a custom window', () => {
    const { result } = renderHook(() => useInlineDeleteConfirm(1000))
    act(() => result.current.request('a'))
    act(() => { vi.advanceTimersByTime(999) })
    expect(result.current.isConfirming('a')).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.confirmingId).toBeNull()
  })
})
