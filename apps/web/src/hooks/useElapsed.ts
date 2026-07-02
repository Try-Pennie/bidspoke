'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Whole seconds elapsed since `active` became true, ticking once a second, and
 * back to 0 whenever `active` is false. The "still-alive" half of the working /
 * still-alive / failed rule (#492): a long action can render "Running… 3s" so a
 * hung run is visibly distinct from a slow one.
 */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      startRef.current = null
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    setElapsed(0)
    const id = setInterval(() => {
      if (startRef.current === null) return
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [active])

  return elapsed
}
