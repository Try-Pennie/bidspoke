'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowSummary } from '@/types/workflow'
import { Plus, MoreHorizontal, Power, Pencil, Copy, Trash2, Check, Search, X, ArrowUpDown, Loader2 } from 'lucide-react'
import { validateWorkflowDef } from '@/lib/workflow-validation'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

function HealthDot({ rate }: { rate: number | null }) {
  if (rate === null) {
    return <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border-2 border-gray-200" title="No run history" />
  }
  if (rate < 80) {
    return (
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0" title={`${rate}% success rate`}>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
      </span>
    )
  }
  return (
    <span
      className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${rate >= 95 ? 'bg-green-500' : 'bg-amber-400'}`}
      title={`${rate}% success rate`}
    />
  )
}

type SortMode = 'time' | 'health'

export default function WorkflowsPage() {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [healthMap, setHealthMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Sort (default: updated_at order from API)
  const [sortMode, setSortMode] = useState<SortMode>('time')

  // ⋯ menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Inline delete confirm
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Duplicate loading
  const [duplicating, setDuplicating] = useState<string | null>(null)

  // FLIP animation refs for sort
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const prevPositions = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    Promise.all([api.workflows.list(), api.stats.get(30)])
      .then(([wfs, stats]) => {
        setWorkflows(wfs)
        const map: Record<string, number> = {}
        for (const wf of stats.by_workflow) map[wf.workflow_id] = wf.success_rate
        setHealthMap(map)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Keyboard shortcut: / or ⌘K focuses search
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // FLIP: run after sortMode re-render, animate rows from old positions to new
  useLayoutEffect(() => {
    if (prevPositions.current.size === 0) return
    for (const [id, el] of rowRefs.current) {
      const prev = prevPositions.current.get(id)
      if (prev == null) continue
      const next = el.getBoundingClientRect().top
      const dy = prev - next
      if (Math.abs(dy) < 1) continue
      el.style.transform = `translateY(${dy}px)`
      el.style.transition = 'none'
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const [, el] of rowRefs.current) {
          el.style.transition = 'transform 350ms cubic-bezier(0.25, 0.46, 0.45, 0.94)'
          el.style.transform = ''
        }
      })
    })
    prevPositions.current = new Map()
  }, [sortMode])

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

  // Health priority for sort: red=4, amber=3, green=2, no-history=1, inactive=0
  function healthPriority(wf: WorkflowSummary): number {
    if (!wf.is_active) return 0
    const rate = healthMap[wf.id]
    if (rate == null) return 1
    if (rate >= 95) return 2
    if (rate >= 80) return 3
    return 4
  }

  function toggleSort() {
    const prefersReduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!prefersReduced) {
      for (const [id, el] of rowRefs.current) {
        prevPositions.current.set(id, el.getBoundingClientRect().top)
      }
    }
    setSortMode((s) => (s === 'time' ? 'health' : 'time'))
  }

  const sortedWorkflows =
    sortMode === 'health'
      ? [...workflows].sort((a, b) => healthPriority(b) - healthPriority(a))
      : workflows

  const isSearchActive = searchQuery.length > 0
  const firstMatchId = isSearchActive
    ? sortedWorkflows.find((wf) => wf.name.toLowerCase().includes(searchQuery.toLowerCase()))?.id
    : undefined

  // View Transitions: tag the clicked element, then navigate inside startViewTransition
  function navigateToWorkflow(e: React.MouseEvent<HTMLElement>, id: string) {
    // Pass through middle-click / modifier-click so browser handles them normally
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    if (typeof document === 'undefined' || !('startViewTransition' in document)) return
    e.preventDefault()
    const el = e.currentTarget
    el.style.viewTransitionName = 'workflow-name'
    ;(document as Document & { startViewTransition(cb: () => void): void })
      .startViewTransition(() => router.push(`/workflows/${id}`))
  }

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

    // Before enabling, validate that all attached nodes are configured
    if (next) {
      try {
        const full = await api.workflows.get(wf.id)
        const errors = validateWorkflowDef(
          full.definition?.nodes ?? [],
          full.definition?.edges ?? []
        )
        if (errors.length > 0) {
          const names = errors.map((e) => e.label || e.namespace).join(', ')
          setError(`Can't activate "${wf.name}": these nodes need to be configured: ${names}. Open the workflow to fix them.`)
          return
        }
      } catch {
        // If we can't fetch the definition, fall through and let the API attempt it
      }
    }

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
    const item = workflows.find((w) => w.id === id)
    setRemovingId(id)
    removeTimerRef.current = setTimeout(() => {
      setWorkflows((ws) => ws.filter((w) => w.id !== id))
      setRemovingId(null)
    }, 150)
    try {
      await api.workflows.delete(id)
    } catch (e) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingId(null)
      if (item) setWorkflows((ws) => ws.find((w) => w.id === id) ? ws : [...ws, item])
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center gap-4">
          <h1 className="text-3xl font-bold text-graphite">Workflows</h1>
          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && firstMatchId) router.push(`/workflows/${firstMatchId}`)
                  if (e.key === 'Escape') { setSearchQuery(''); searchRef.current?.blur() }
                }}
                placeholder="Search… /"
                className="h-8 w-44 rounded-lg border border-gray-200 bg-white pl-8 pr-7 text-sm text-gray-700 placeholder-gray-400 transition-[width] duration-200 focus:w-64 focus:outline-none focus:ring-1 focus:ring-p-blue-dark"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); searchRef.current?.focus() }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {creating ? 'Creating…' : 'New Workflow'}
            </button>
          </div>
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
                        <Skeleton className="h-2.5 w-2.5 rounded-full" />
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

            <h2 className="text-xl font-bold text-graphite">Build your first workflow</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-gray-400">
              Connect a trigger to filters, decisions, and API calls. Automate what happens when a lead comes in.
            </p>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="mt-6 rounded-lg bg-p-blue-dark px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'New workflow'}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-52" />
                <col className="w-44" />
                <col className="w-16" />
              </colgroup>
              <thead className="border-b border-gray-100 bg-beige">
                <tr>
                  <th className="rounded-tl-xl px-4 py-3 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-500">Name</span>
                      <button
                        onClick={toggleSort}
                        title={sortMode === 'health' ? 'Sorted by health. Click for date order.' : 'Sort by health (failing first)'}
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors ${
                          sortMode === 'health'
                            ? 'bg-p-blue-light font-medium text-p-blue-dark'
                            : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                        }`}
                      >
                        <ArrowUpDown className="h-3 w-3" />
                        Health
                      </button>
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Last modified</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Modified by</th>
                  <th className="rounded-tr-xl px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedWorkflows.map((wf) => {
                  const isMatch = !isSearchActive || wf.name.toLowerCase().includes(searchQuery.toLowerCase())
                  const isFirstMatch = wf.id === firstMatchId
                  const isFailing = healthMap[wf.id] != null && healthMap[wf.id] < 80
                  return (
                    <tr
                      key={wf.id}
                      ref={(el) => { if (el) rowRefs.current.set(wf.id, el); else rowRefs.current.delete(wf.id) }}
                      className={[
                        'transition-opacity duration-150',
                        removingId === wf.id ? 'opacity-0' : '',
                        isSearchActive && !isMatch ? 'opacity-20 pointer-events-none select-none' : '',
                        isFirstMatch ? 'bg-p-blue-light/50 hover:bg-p-blue-light/70' :
                          isFailing ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-beige',
                      ].filter(Boolean).join(' ')}
                    >
                      {/* Name + status badge */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <HealthDot rate={healthMap[wf.id] ?? null} />
                          {renamingId === wf.id ? (
                            <form
                              onSubmit={(e) => { e.preventDefault(); commitRename(wf.id) }}
                              className="flex items-center gap-1.5"
                            >
                              <input
                                autoFocus
                                className="rounded border border-gray-300 px-2 py-0.5 text-sm font-medium text-graphite focus:outline-none focus:ring-1 focus:ring-gray-400"
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
                              onClick={(e) => navigateToWorkflow(e, wf.id)}
                              className="font-semibold text-graphite hover:text-p-blue-dark"
                            >
                              {wf.name}
                            </Link>
                          )}
                          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                            wf.is_active
                              ? 'bg-green-50 text-green-700'
                              : 'bg-gray-100 text-gray-500'
                          }`}>
                            {wf.is_active ? 'Active' : 'Inactive'}
                          </span>
                          {duplicating === wf.id && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-p-blue-dark" />
                          )}
                        </div>
                        {wf.description && (
                          <p className="mt-0.5 text-xs text-gray-400">{wf.description}</p>
                        )}
                      </td>

                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {formatDatetime(wf.updated_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{wf.updated_by_name ?? wf.updated_by_email?.split('@')[0] ?? '—'}</td>

                      {/* Actions column */}
                      <td className="px-4 py-3">
                        <div ref={openMenuId === wf.id ? menuRef : undefined} className="relative">
                          {/* ••• always in DOM to hold cell size; invisible when confirm showing */}
                          <button
                            onClick={() => setOpenMenuId(openMenuId === wf.id ? null : wf.id)}
                            className={`rounded p-1.5 text-gray-400 hover:bg-gray-100 ${confirmingDelete === wf.id ? 'invisible pointer-events-none' : ''} ${openMenuId === wf.id ? 'bg-gray-100 text-gray-600' : ''}`}
                            title="More options"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          {/* Confirm — floats absolutely, extends left over adjacent column */}
                          {confirmingDelete === wf.id && (
                            <div className="absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-1.5 whitespace-nowrap">
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
                          )}
                          {/* Dropdown menu */}
                          {openMenuId === wf.id && (
                            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                              <button
                                onClick={() => handleToggleActive(wf)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                              >
                                <Power className="h-4 w-4 text-gray-400" />
                                {wf.is_active ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                onClick={() => startRename(wf)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
                              >
                                <Pencil className="h-4 w-4 text-gray-400" />
                                Rename
                              </button>
                              <button
                                onClick={() => handleDuplicate(wf.id)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-beige"
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
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {isSearchActive && !firstMatchId && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                No workflows match <span className="font-medium text-gray-600">&quot;{searchQuery}&quot;</span>
              </div>
            )}
          </div>
        )}
      </div>
    </NavLayout>
  )
}
