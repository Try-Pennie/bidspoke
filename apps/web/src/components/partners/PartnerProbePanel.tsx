'use client'

import { useId, useState } from 'react'
import { FieldError, TextArea } from '@/components/ui/form'

interface Props {
  value: unknown
  onChange: (next: unknown) => void
}

/**
 * Paste-in capture of a representative partner API response. Drives the
 * schema-aware autocomplete in ExtraExtractionEditor. Parses on every
 * change; valid JSON is lifted to the parent immediately, invalid input
 * stays in the local textarea state with an inline error.
 */
export function PartnerProbePanel({ value, onChange }: Props) {
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
    <div className="space-y-2">
      <p className="text-xs text-hint">
        Paste a representative response body. The fields here populate the autocomplete dropdown when configuring extraction paths below. Valid JSON saves automatically.
      </p>
      <TextArea
        id={id}
        aria-label="Sample response"
        value={text}
        onChange={handleChange}
        rows={6}
        placeholder={'{\n  "ok": true,\n  "data": {\n    "createLead": { "id": "...", "resultCode": 1013 }\n  }\n}'}
        mono
        describedBy={error ? `${id}-error` : undefined}
        className="min-h-[120px] resize-y text-xs"
      />
      {error && <FieldError id={`${id}-error`} alert size="xs">{error}</FieldError>}
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
