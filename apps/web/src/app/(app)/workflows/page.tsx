'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowSummary } from '@/types/workflow'
import { Plus, MoreHorizontal, Power, Pencil, Copy, Trash2, Check } from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

export default function WorkflowsPage() {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ⋯ menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Inline delete confirm
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Duplicate loading
  const [duplicating, setDuplicating] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.list()
      .then(setWorkflows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuId])

  async function handleCreate() {
    setCreating(true)
    try {
      const wf = await api.workflows.create('Untitled Workflow')
      router.push(`/workflows/${wf.id}?mode=edit`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow')
      setCreating(false)
    }
  }

  async function handleToggleActive(wf: WorkflowSummary) {
    setOpenMenuId(null)
    const next = !wf.is_active
    setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: next } : w))
    try {
      await api.workflows.setActive(wf.id, next)
    } catch (e) {
      setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: wf.is_active } : w))
      setError(e instanceof Error ? e.message : 'Failed to update workflow')
    }
  }

  function startRename(wf: WorkflowSummary) {
    setOpenMenuId(null)
    setRenamingId(wf.id)
    setRenameValue(wf.name)
  }

  async function commitRename(id: string) {
    const trimmed = renameValue.trim()
    if (!trimmed) { setRenamingId(null); return }
    setWorkflows((ws) => ws.map((w) => w.id === id ? { ...w, name: trimmed } : w))
    setRenamingId(null)
    try {
      await api.workflows.save(id, { name: trimmed })
    } catch {
      // Reload to revert optimistic update
      api.workflows.list().then(setWorkflows).catch(() => {})
    }
  }

  async function handleDuplicate(id: string) {
    setOpenMenuId(null)
    setDuplicating(id)
    try {
      const copy = await api.workflows.duplicate(id)
      setWorkflows((ws) => [copy as unknown as WorkflowSummary, ...ws])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Duplicate failed')
    } finally {
      setDuplicating(null)
    }
  }

  function requestDelete(id: string) {
    setOpenMenuId(null)
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
    try {
      await api.workflows.delete(id)
      setWorkflows((ws) => ws.filter((w) => w.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Workflows</h1>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Creating…' : 'New Workflow'}
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {[...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-5 w-14 rounded-full" />
                      </div>
                    </td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-6 w-6" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : workflows.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-center">
            {/* Mini workflow diagram */}
            <svg width="100" height="122" viewBox="0 0 100 122" fill="none" aria-hidden="true" className="mb-8">
              <rect x="10" y="0" width="80" height="26" rx="5" fill="#eef2ff" stroke="#a5b4fc" strokeWidth="1"/>
              <text x="50" y="17" textAnchor="middle" fill="#4338ca" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">TRIGGER</text>
              <circle cx="50" cy="26" r="2.5" fill="#a5b4fc"/>
              <line x1="50" y1="28.5" x2="50" y2="45.5" stroke="#e0e7ff" strokeWidth="1.5"/>
              <circle cx="50" cy="48" r="2.5" fill="#93c5fd"/>
              <rect x="10" y="50" width="80" height="26" rx="5" fill="#eff6ff" stroke="#93c5fd" strokeWidth="1"/>
              <text x="50" y="67" textAnchor="middle" fill="#2563eb" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">FILTER</text>
              <circle cx="50" cy="76" r="2.5" fill="#93c5fd"/>
              <line x1="50" y1="78.5" x2="50" y2="93.5" stroke="#d1fae5" strokeWidth="1.5"/>
              <circle cx="50" cy="96" r="2.5" fill="#86efac"/>
              <rect x="10" y="98" width="80" height="26" rx="5" fill="#f0fdf4" stroke="#86efac" strokeWidth="1"/>
              <text x="50" y="115" textAnchor="middle" fill="#15803d" fontSize="8" fontWeight="700" fontFamily="ui-sans-serif,system-ui,sans-serif" letterSpacing="1">RESPOND</text>
            </svg>

            <h2 className="text-xl font-bold tracking-tight text-gray-900">Build your first workflow</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-gray-400">
              Connect a trigger to filters, decisions, and API calls — and automate what happens when a lead comes in.
            </p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="mt-6 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'New workflow'}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="rounded-tl-xl px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last modified</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">By</th>
                  <th className="w-12 rounded-tr-xl px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {workflows.map((wf) => (
                  <tr key={wf.id} className="hover:bg-gray-50">
                    {/* Name + status badge */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {renamingId === wf.id ? (
                          <form
                            onSubmit={(e) => { e.preventDefault(); commitRename(wf.id) }}
                            className="flex items-center gap-1.5"
                          >
                            <input
                              autoFocus
                              className="rounded border border-gray-300 px-2 py-0.5 text-sm font-medium text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={() => commitRename(wf.id)}
                              onKeyDown={(e) => e.key === 'Escape' && setRenamingId(null)}
                            />
                            <button type="submit" className="rounded p-0.5 text-green-600 hover:bg-green-50">
                              <Check className="h-3.5 w-3.5" />
                            </button>
                          </form>
                        ) : (
                          <Link
                            href={`/workflows/${wf.id}`}
                            className="font-semibold text-gray-900 hover:text-indigo-600"
                          >
                            {wf.name}
                          </Link>
                        )}
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          wf.is_active
                            ? 'bg-green-50 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}>
                          {wf.is_active ? 'Active' : 'Inactive'}
                        </span>
                        {duplicating === wf.id && (
                          <span className="text-xs text-gray-400">Duplicating…</span>
                        )}
                      </div>
                      {wf.description && (
                        <p className="mt-0.5 text-xs text-gray-400">{wf.description}</p>
                      )}
                    </td>

                    <td className="px-4 py-3 text-gray-500">
                      {formatDatetime(wf.updated_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{wf.updated_by_name ?? wf.updated_by_email?.split('@')[0] ?? '—'}</td>

                    {/* Actions column */}
                    <td className="px-4 py-3">
                      {confirmingDelete === wf.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleDelete(wf.id)}
                            className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                          >
                            Delete
                          </button>
                          <button onClick={cancelDelete} className="text-xs text-gray-400 hover:text-gray-600">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div ref={openMenuId === wf.id ? menuRef : undefined} className="relative">
                          <button
                            onClick={() => setOpenMenuId(openMenuId === wf.id ? null : wf.id)}
                            className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${openMenuId === wf.id ? 'bg-gray-100 text-gray-600' : ''}`}
                            title="More options"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          {openMenuId === wf.id && (
                            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                              <button
                                onClick={() => handleToggleActive(wf)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                <Power className="h-4 w-4 text-gray-400" />
                                {wf.is_active ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                onClick={() => startRename(wf)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                <Pencil className="h-4 w-4 text-gray-400" />
                                Rename
                              </button>
                              <button
                                onClick={() => handleDuplicate(wf.id)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                <Copy className="h-4 w-4 text-gray-400" />
                                Duplicate
                              </button>
                              <div className="my-1 border-t border-gray-100" />
                              <button
                                onClick={() => requestDelete(wf.id)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </button>
                            </div>
                          )}
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
