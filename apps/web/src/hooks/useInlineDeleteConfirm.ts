'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The "click Delete, then confirm inline for a few seconds" pattern (#546).
 *
 * Hand-copied four times before this existed: workflow row and workflow folder
 * on the workflows page, and env variable row and env folder on the env page.
 * Each copy repeated the same id state, the same timer ref, and the same three
 * functions, so a change to the timing, the styling or the keyboard behaviour
 * had to be made four times, and the fifth delete button added to the app would
 * have pasted a fifth.
 *
 * It also fixes something every copy got wrong: none of them cleared the timer
 * when the component went away. Navigating off the page mid-confirm left a
 * pending timeout that then set state on a component that no longer existed.
 */
export interface InlineDeleteConfirm {
  /** The id currently awaiting confirmation, or null. */
  confirmingId: string | null
  /** Whether this particular row is the one awaiting confirmation. */
  isConfirming: (id: string) => boolean
  /** Start the confirm window for `id`, replacing any other row's. */
  request: (id: string) => void
  /** Dismiss without deleting. */
  cancel: () => void
  /**
   * Close the confirm because the delete is going ahead. Call this BEFORE the
   * delete itself, so the buttons vanish on the click rather than after the
   * request comes back.
   */
  commit: () => void
}

export const INLINE_DELETE_CONFIRM_MS = 4000

export function useInlineDeleteConfirm(timeoutMs: number = INLINE_DELETE_CONFIRM_MS): InlineDeleteConfirm {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // Every hand-written copy of this leaked its timer on unmount.
  useEffect(() => clearTimer, [clearTimer])

  const request = useCallback(
    (id: string) => {
      clearTimer()
      setConfirmingId(id)
      timer.current = setTimeout(() => setConfirmingId(null), timeoutMs)
    },
    [clearTimer, timeoutMs],
  )

  const close = useCallback(() => {
    clearTimer()
    setConfirmingId(null)
  }, [clearTimer])

  return {
    confirmingId,
    isConfirming: (id: string) => confirmingId === id,
    request,
    cancel: close,
    commit: close,
  }
}
