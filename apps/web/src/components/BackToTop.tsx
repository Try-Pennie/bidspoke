'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'

/**
 * A floating "back to top" control for long pages (#441).
 *
 * IT DOES NOT SCROLL THE WINDOW, and that is the whole trick. NavLayout puts page
 * content inside `<main className="overflow-auto">`, so the window never scrolls
 * and a `window.scrollTo(0, 0)` button would render, click, and do nothing at all,
 * which looks identical to a broken page. So it finds its own scrollable ancestor
 * at runtime and only falls back to the window when there genuinely is none.
 *
 * Appears after one viewport of scrolling, which is the point at which the header
 * is definitely gone, rather than a pixel count that means different things on
 * different screens.
 */

/** The nearest ancestor that actually scrolls, or null when none does. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el
  }
  return null
}

export function BackToTop() {
  const anchor = useRef<HTMLSpanElement>(null)
  const container = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = scrollParent(anchor.current)
    container.current = el
    const target: HTMLElement | Window = el ?? window

    const update = () => {
      const top = el ? el.scrollTop : window.scrollY
      const viewport = el ? el.clientHeight : window.innerHeight
      setVisible(top > viewport)
    }

    update()
    target.addEventListener('scroll', update, { passive: true })
    return () => target.removeEventListener('scroll', update)
  }, [])

  const toTop = useCallback(() => {
    // Someone who has asked the system to reduce motion should not be given a
    // long animated fling up a very long page.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth'
    const el = container.current
    if (el) el.scrollTo({ top: 0, behavior })
    else window.scrollTo({ top: 0, behavior })
  }, [])

  return (
    <>
      {/* Zero-size anchor so the component can locate its own scroll container. */}
      <span ref={anchor} aria-hidden="true" />
      {visible && (
        <button
          type="button"
          onClick={toTop}
          aria-label="Back to top"
          className="fixed bottom-6 right-6 z-40 rounded-full border border-gray-200 bg-white p-3 text-gray-600 shadow-lg transition hover:bg-beige hover:text-graphite focus:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}
    </>
  )
}
