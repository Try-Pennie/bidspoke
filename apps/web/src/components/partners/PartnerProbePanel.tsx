'use client'

import { useState } from 'react'

interface Props {
  value: unknown
  onChange: (next: unknown) => void
}

/**
 * Paste-in capture of a representative partner API response. Drives the
 * schema-aware autocomplete in ExtraExtractionEditor without requiring a
 * live probe request (which would need a server-side proxy with the
 * partner's secret). A live "Probe" button can be layered on later as
 * POST /api/partners/:id/probe.
 */
export function PartnerProbePanel({ value, onChange }: Props) {
  const initialText = value ? safeStringify(value) : ''
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)

  function handleApply() {
    try {
      const parsed = JSON.parse(text)
      onChange(parsed)
      setError(null)
      setSavedNotice(true)
      setTimeout(() => setSavedNotice(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }

  function handleClear() {
    setText('')
    onChange(null)
    setError(null)
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400">
        Paste a representative response body here. The fields in this JSON populate the autocomplete dropdown when configuring extraction paths below.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{\n  "ok": true,\n  "data": {\n    "createLead": { "id": "...", "resultCode": 1013 }\n  }\n}'}
        className="min-h-[120px] w-full resize-y rounded-md border border-gray-200 bg-white p-2 font-mono text-xs focus:border-gray-400 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleApply}
          className="rounded-md bg-p-blue-light px-3 py-1 text-xs font-medium text-p-blue-dark hover:bg-p-blue-dark hover:text-white"
        >
          Apply sample
        </button>
        {value !== null && value !== undefined && (
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
        {savedNotice && <span className="text-xs text-green-600">Applied.</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
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
