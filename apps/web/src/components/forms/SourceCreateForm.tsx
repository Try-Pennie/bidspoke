'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { sanitizeSourceName } from '@/lib/source-name'

interface Props {
  /** Auto-focus the name input on mount. */
  autoFocus?: boolean
  /** When set, the new key is immediately assigned to this workflow. */
  assignWorkflowId?: string
  onCreated: (source: { name: string; api_key: string }) => void
  onCancel: () => void
}

export default function SourceCreateForm({ autoFocus = false, assignWorkflowId, onCreated, onCancel }: Props) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoFocus) {
      const frame = requestAnimationFrame(() => nameInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [autoFocus])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const created = await api.sources.create(name.trim(), assignWorkflowId)
      onCreated(created)
      setName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create source')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
        <input
          ref={nameInputRef}
          className="input w-full font-mono"
          placeholder="wallet_owl"
          value={name}
          onChange={(e) => setName(sanitizeSourceName(e.target.value))}
          required
        />
        <p className="mt-1 text-xs text-gray-400">
          Lowercase letters, numbers, underscores. Used as <code className="rounded bg-gray-100 px-1 font-mono">trigger.source</code> in workflows.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
        >
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating…</> : 'Generate key'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
