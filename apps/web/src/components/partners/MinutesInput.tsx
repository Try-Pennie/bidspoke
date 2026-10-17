'use client'

import { useState } from 'react'
import { NumberInput } from '@/components/ui/form'

/**
 * A number of minutes on screen over a number of whole seconds in the store
 * (PM-23, #2326): the circuit breaker's Within and Pause for. The value passes
 * through as the form keeps it, text, so a box nobody touched saves nothing.
 *
 * While the box has focus it shows what the person typed, not the stored value
 * read back: 0.01 minutes is stored as 1 second, and redrawing that as 0.0167
 * under the cursor would replace what they are typing. On leaving the box it
 * shows the stored value, so what it then says is what will be saved.
 */
export function MinutesInput({ id, seconds, onChange, placeholder, describedBy }: {
  id: string
  /** The stored seconds, as the form keeps them: text, '' for none. */
  seconds: string
  onChange: (seconds: string) => void
  placeholder?: string
  describedBy?: string
}) {
  const [typed, setTyped] = useState<number | null | undefined>(undefined)
  return (
    <span className="flex items-center gap-1.5" onBlur={() => setTyped(undefined)}>
      <NumberInput
        id={id}
        value={typed !== undefined ? typed : secondsAsMinutes(seconds)}
        onChange={(m) => { setTyped(m); onChange(minutesAsSeconds(m)) }}
        placeholder={placeholder}
        describedBy={describedBy}
      />
      <span className="text-[13px] text-graphite">minutes</span>
    </span>
  )
}

/** Stored seconds as minutes, to four places so 50 seconds does not read as 0.8333333. */
export function secondsAsMinutes(text: string): number | null {
  if (text.trim() === '') return null
  const s = Number(text)
  return Number.isFinite(s) ? Number((s / 60).toFixed(4)) : null
}

/** Typed minutes as whole seconds, the unit the store keeps. */
export function minutesAsSeconds(m: number | null): string {
  return m === null ? '' : String(Math.round(m * 60))
}
