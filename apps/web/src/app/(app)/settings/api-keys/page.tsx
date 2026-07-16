'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { KeyRound, Check, AlertCircle, Trash2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

export default function ApiKeysPage() {
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [updatedBy, setUpdatedBy] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      const data = await api.settings.getAnthropicKey()
      setConfigured(data.configured)
      setUpdatedAt(data.updated_at ?? null)
      setUpdatedBy(data.updated_by_email ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const key = keyInput.trim()
    if (!key) return
    setSaving(true)
    setError(null)
    try {
      await api.settings.setAnthropicKey(key)
      setKeyInput('')
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save key')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    setError(null)
    try {
      await api.settings.clearAnthropicKey()
      setConfigured(false)
      setUpdatedAt(null)
      setUpdatedBy(null)
      setConfirmingRemove(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove key')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm text-gray-600">
        API keys for third-party services Bidspoke calls on your behalf. Stored encrypted; never displayed after save.
      </p>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50">
            <KeyRound className="h-4 w-4 text-amber-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-graphite">Anthropic</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Powers AI-drafted changelog summaries when you save a workflow. Without it, the save popover stays empty.
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : configured ? (
            <span className="flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
              <Check className="h-3 w-3" />
              Connected
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
              Not set
            </span>
          )}
        </div>

        {!loading && configured && updatedAt && (
          <p className="mb-4 text-xs text-gray-500">
            Last updated {new Date(updatedAt).toLocaleString()}
            {updatedBy ? ` by ${updatedBy}` : ''}
          </p>
        )}

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              {configured ? 'Replace key' : 'API key'}
            </label>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="input w-full font-mono text-xs"
              placeholder="sk-ant-..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              Get a key from console.anthropic.com. Keys start with <span className="font-mono">sk-ant-</span>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving || !keyInput.trim()}
              className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40 ${
                savedOk ? 'bg-green-600' : 'bg-p-blue-dark hover:bg-[#155E99]'
              }`}
            >
              {savedOk ? <Check className="h-3.5 w-3.5" /> : null}
              {saving ? 'Saving…' : savedOk ? 'Saved' : configured ? 'Replace key' : 'Save key'}
            </button>

            {configured && !confirmingRemove && (
              <button
                type="button"
                onClick={() => setConfirmingRemove(true)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
            {configured && confirmingRemove && (
              <>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removing}
                  className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {removing ? 'Removing…' : 'Confirm remove'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  className="text-sm text-gray-500 hover:text-gray-800"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
