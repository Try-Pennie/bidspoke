'use client'

import { useId, useState } from 'react'
import { FieldError, TextArea } from '@/components/ui/form'

interface Props {
  value: unknown
  onChange: (next: unknown) => void
  /** Named in the line under the box (PM-23). */
  partnerName: string
}

/**
 * The Sample answer box under Extract (PM-23, #2326): a pasted answer from the
 * partner, whose paths ExtraExtractionEditor offers as an extraction is typed.
 * Not used when bidding. Parses on every
 * change; valid JSON is lifted to the parent immediately, invalid input
 * stays in the local textarea state with an inline error.
 */
export function PartnerProbePanel({ value, onChange, partnerName }: Props) {
  const initialText = value === null || value === undefined ? '' : safeStringify(value)
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  function handleChange(next: string) {
    setText(next)
    if (next.trim() === '') {
      onChange(null)
      setError(null)
      return
    }
    try {
      const parsed = JSON.parse(next)
      onChange(parsed)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }

  return (
    <div className="space-y-1">
      <TextArea
        id={id}
        aria-label="Sample answer"
        value={text}
        onChange={handleChange}
        rows={4}
        placeholder={'{ "data": { "bid": 42.5 } }'}
        mono
        describedBy={[error ? `${id}-error` : '', `${id}-hint`].filter(Boolean).join(' ')}
        className="min-h-[80px] resize-y text-xs"
      />
      {error && <FieldError id={`${id}-error`} alert size="xs">{error}</FieldError>}
      <p id={`${id}-hint`} className="text-xs text-hint">
        Paste an answer from {partnerName} and the paths in it are offered as you type an extraction. Not used when bidding.
      </p>
    </div>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}
