'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { EnvVar } from '@/types/workflow'
import { Plus, Trash2, Eye, EyeOff, Loader2 } from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

type NewVar = { key: string; value: string; is_secret: boolean }

export default function EnvPage() {
  const [vars, setVars] = useState<EnvVar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [newVar, setNewVar] = useState<NewVar>({ key: '', value: '', is_secret: false })
  const [creating, setCreating] = useState(false)
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.env.list()
      .then(setVars)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newVar.key) return
    setCreating(true)
    try {
      const created = await api.env.create(newVar)
      setVars((vs) => [...vs, created])
      setNewVar({ key: '', value: '', is_secret: false })
      setShowForm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  function requestDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(id)
    deleteTimerRef.current = setTimeout(() => setConfirmingDelete(null), 4000)
  }

  function cancelDelete() {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
  }

  async function handleDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmingDelete(null)
    const item = vars.find((v) => v.id === id)
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setVars((vs) => vs.filter((v) => v.id !== id))
      setRemovingId(null)
    }, 150)
    try {
      await api.env.delete(id)
    } catch (err) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      if (item) setVars((vs) => vs.find((v) => v.id === id) ? vs : [...vs, item])
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Environment Variables</h1>
            <p className="mt-1 text-sm text-gray-500">
              Available in workflows as <code className="rounded bg-gray-100 px-1 text-xs">{'{{env.KEY}}'}</code>
            </p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Add Variable
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Add form */}
        {showForm && (
          <form
            onSubmit={handleCreate}
            className="mb-6 rounded-xl border border-gray-200 bg-white p-4"
          >
            <h2 className="mb-4 text-base font-semibold text-gray-900">New Variable</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Key</label>
                <input
                  className="input w-full font-mono"
                  placeholder="MY_API_KEY"
                  value={newVar.key}
                  onChange={(e) => setNewVar({ ...newVar, key: e.target.value.toUpperCase().replace(/\s/g, '_') })}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Value</label>
                <input
                  type={newVar.is_secret ? 'password' : 'text'}
                  className="input w-full"
                  placeholder="value"
                  value={newVar.value}
                  onChange={(e) => setNewVar({ ...newVar, value: e.target.value })}
                />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="checkbox"
                id="is_secret"
                checked={newVar.is_secret}
                onChange={(e) => setNewVar({ ...newVar, is_secret: e.target.checked })}
                className="rounded border-gray-300 text-indigo-600"
              />
              <label htmlFor="is_secret" className="text-xs text-gray-600">
                Secret — value encrypted and synced to Cloudflare Worker
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {[...Array(3)].map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-5 w-12 rounded-full" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-6 w-6" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : vars.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 py-12 text-center">
            <p className="text-base font-semibold text-gray-900">No variables yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-400">
              Environment variables let workflows reference API keys and config values without hardcoding them. Reference them in any step as <code className="rounded bg-gray-100 px-1 text-xs">{'{{env.KEY}}'}</code>.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Add your first variable
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Key</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Value</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Last updated</th>
                  <th className="w-16 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {vars.map((v) => (
                  <tr key={v.id} className={`hover:bg-gray-50 transition-opacity duration-150 ${removingId === v.id ? 'opacity-0' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">{v.key}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {v.is_secret ? (
                        <div className="flex items-center gap-1.5">
                          <span>{revealedValues[v.id] ?? '••••••••'}</span>
                          {revealedValues[v.id] ? (
                            <button
                              type="button"
                              onClick={() => setRevealedValues((prev) => { const next = { ...prev }; delete next[v.id]; return next })}
                              className="text-gray-300 hover:text-gray-500"
                            >
                              <EyeOff className="h-3.5 w-3.5" />
                            </button>
                          ) : revealing.has(v.id) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-300" />
                          ) : (
                            <button
                              type="button"
                              onClick={async () => {
                                setRevealing((s) => new Set([...s, v.id]))
                                try {
                                  const { value } = await api.env.reveal(v.id)
                                  setRevealedValues((prev) => ({ ...prev, [v.id]: value }))
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : 'Failed to reveal')
                                } finally {
                                  setRevealing((s) => { const next = new Set(s); next.delete(v.id); return next })
                                }
                              }}
                              className="text-gray-300 hover:text-gray-500"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ) : (
                        v.value ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                          v.is_secret ? 'bg-orange-50 text-orange-700' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {v.is_secret ? 'Secret' : 'Plain'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDatetime(v.updated_at)}
                    </td>
                    <td className="relative px-4 py-3">
                      {/* Always in DOM to hold cell size; invisible when confirm showing */}
                      <button
                        onClick={() => requestDelete(v.id)}
                        className={`rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 ${confirmingDelete === v.id ? 'invisible pointer-events-none' : ''}`}
                        title="Delete variable"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      {/* Confirm — floats absolutely, extends left over adjacent column */}
                      {confirmingDelete === v.id && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap">
                          <button
                            onClick={() => handleDelete(v.id)}
                            className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                          >
                            Delete
                          </button>
                          <button onClick={cancelDelete} className="text-xs text-gray-400 hover:text-gray-600">
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </NavLayout>
  )
}
