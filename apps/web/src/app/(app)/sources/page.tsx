'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Copy, Trash2, Plus, Key } from 'lucide-react'

interface Source {
  name: string
  key_previews: string[]
}

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  // Shown once after creation
  const [newKey, setNewKey] = useState<{ name: string; api_key: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    api.sources.list()
      .then(setSources)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.sources.create(newName.trim())
      setNewKey(result)
      setNewName('')
      setAdding(false)
      const updated = await api.sources.list()
      setSources(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create source')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Revoke all API keys for "${name}"? Any callers using these keys will immediately get 401s.`)) return
    setDeleting(name)
    setError(null)
    try {
      await api.sources.delete(name)
      setSources((prev) => prev.filter((s) => s.name !== name))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke source')
    } finally {
      setDeleting(null)
    }
  }

  async function handleCopy(key: string) {
    await navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">API Sources</h1>
            <p className="mt-1 text-sm text-gray-500">
              Each source gets a unique API key passed in the <code className="rounded bg-gray-100 px-1 font-mono text-xs">X-API-Key</code> header.
              The source name is available as <code className="rounded bg-gray-100 px-1 font-mono text-xs">trigger.source</code> in workflows.
            </p>
          </div>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              New source
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* One-time key display */}
        {newKey && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-5">
            <p className="mb-2 text-sm font-medium text-green-800">
              Source <span className="font-mono">{newKey.name}</span> created. Copy this key now — it won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-green-200 bg-white px-3 py-2 font-mono text-sm text-gray-900">
                {newKey.api_key}
              </code>
              <button
                onClick={() => handleCopy(newKey.api_key)}
                className="flex items-center gap-1.5 rounded-lg border border-green-200 bg-white px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100"
              >
                <Copy className="h-4 w-4" />
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="mt-3 text-xs text-green-700 underline"
            >
              I&apos;ve saved it, dismiss
            </button>
          </div>
        )}

        {/* Add form */}
        {adding && (
          <div className="mb-6 max-w-md rounded-xl border border-gray-200 bg-white p-5">
            <p className="mb-4 text-sm font-medium text-gray-700">New source</p>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
                <input
                  className="input w-full font-mono"
                  placeholder="wallet_owl"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  required
                />
                <p className="mt-1 text-xs text-gray-400">Lowercase, underscores. Used as trigger.source in workflows.</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Generating…' : 'Generate key'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAdding(false); setNewName('') }}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Sources list */}
        <div className="max-w-xl">
          {loading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : sources.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
              <Key className="mx-auto mb-2 h-6 w-6 text-gray-300" />
              <p className="text-sm text-gray-500">No sources yet. Add one to get a webhook API key.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              {sources.map((source, i) => (
                <div
                  key={source.name}
                  className={`flex items-center justify-between px-5 py-4 ${i !== sources.length - 1 ? 'border-b border-gray-100' : ''}`}
                >
                  <div>
                    <p className="font-mono text-sm font-medium text-gray-900">{source.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {source.key_previews.length === 1
                        ? `Key: ${source.key_previews[0]}`
                        : `${source.key_previews.length} keys: ${source.key_previews.join(', ')}`}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(source.name)}
                    disabled={deleting === source.name}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting === source.name ? 'Revoking…' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-6 text-xs text-gray-400">
          Keys take effect within ~30 seconds after creation or revocation (Worker redeploy).
        </p>
      </div>
    </NavLayout>
  )
}
