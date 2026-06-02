'use client'

import { useEffect } from 'react'

// `<input type="number">` changes its value when you scroll the wheel over it
// while focused — almost never intended (you mean to scroll the page, the value
// silently ticks up/down). Mounted once at the root, this blurs the focused
// number input on a wheel event over it, so only typing and the stepper arrows
// edit the value. The listener is passive (we don't preventDefault), so the page
// still scrolls normally — the input just drops focus first, which removes the
// precondition the browser needs to apply its wheel-increment.
export default function NumberInputWheelGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement &&
        active.type === 'number' &&
        (e.target === active || active.contains(e.target as Node))
      ) {
        active.blur()
      }
    }
    document.addEventListener('wheel', onWheel, { passive: true })
    return () => document.removeEventListener('wheel', onWheel)
  }, [])
  return null
}
