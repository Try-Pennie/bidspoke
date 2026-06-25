'use client'

import { useState } from 'react'

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
      <p className="text-xs text-gray-500">
        Paste a representative response body. The fields here populate the autocomplete dropdown when configuring extraction paths below. Valid JSON saves automatically.
      </p>
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={'{\n  "ok": true,\n  "data": {\n    "createLead": { "id": "...", "resultCode": 1013 }\n  }\n}'}
        className="min-h-[120px] w-full resize-y rounded-md border border-gray-200 bg-white p-2 font-mono text-xs focus:border-gray-400 focus:outline-none"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
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
