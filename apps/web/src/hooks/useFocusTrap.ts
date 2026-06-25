import { useEffect, useRef } from 'react'

// Elements that can receive keyboard focus. Disabled controls and
// tabindex="-1" are excluded so the trap only cycles real tab stops.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  )
}

/**
 * Trap keyboard focus inside a dialog while it is open (#288).
 *
 * Returns a ref to attach to the dialog container. While `active`:
 *  - focus moves to the first focusable element on open,
 *  - Tab / Shift+Tab cycle within the container (no escaping behind the modal),
 *  - Escape invokes `onEscape` (close the dialog),
 *  - focus is restored to the previously-focused element on close/unmount.
 *
 * `onEscape` is read through a ref so an unmemoized handler does not re-run the
 * effect (which would steal focus back to the first element on every render).
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const containerRef = useRef<T>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const initial = getFocusableElements(container)
    ;(initial[0] ?? container).focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onEscapeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const els = getFocusableElements(container as HTMLElement)
      if (els.length === 0) {
        e.preventDefault()
        return
      }
      const first = els[0]
      const last = els[els.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && activeEl === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore focus to whatever was focused before the dialog opened.
      previouslyFocused?.focus?.()
    }
  }, [active])

  return containerRef
}
