'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { CheckCircle, CheckCircle2, XCircle, Loader2, RotateCcw } from 'lucide-react'

const PAGE_SIZE = 100

function mergeExecs(a: ExecRow[], b: ExecRow[]): ExecRow[] {
  const map = new Map<string, ExecRow>()
  for (const e of a) map.set(e.id, e)
  for (const e of b) map.set(e.id, e)
  return Array.from(map.values()).sort((x, y) => {
    if (x.started_at !== y.started_at) return x.started_at < y.started_at ? 1 : -1
    return x.id < y.id ? 1 : -1
  })
}
import { getDateLabel, formatTime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'
import type { WorkflowVersion } from '@/types/workflow'

type ExecRow = {
  id: string
  status: string
  outcome: 'successful' | 'completed' | 'failed' | null
  final_node_namespace: string | null
  source: string
  started_at: string
  duration_ms: number | null
  error_message: string | null
  parent_execution_id: string | null
  has_children: boolean
}

type ListItem =
  | { type: 'date-header'; label: string }
  | { type: 'exec'; exec: ExecRow }
  | { type: 'version-divider'; version: WorkflowVersion }

function buildItems(filtered: ExecRow[], versions: WorkflowVersion[]): ListItem[] {
  const items: ListItem[] = []
  let vi = 0
  let currentDateLabel = ''

  for (const exec of filtered) {
    // Insert dividers for versions saved after this execution's start (walking newest-first)
    while (vi < versions.length && versions[vi].created_at > exec.started_at) {
      items.push({ type: 'version-divider', version: versions[vi] })
      vi++
    }
    // Date section header
    const dateLabel = getDateLabel(exec.started_at)
    if (dateLabel !== currentDateLabel) {
      currentDateLabel = dateLabel
      items.push({ type: 'date-header', label: dateLabel })
    }
    items.push({ type: 'exec', exec })
  }
  return items
}

function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const OUTCOME_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  successful: { icon: CheckCircle2, color: 'text-green-500' },
  completed:  { icon: CheckCircle,  color: 'text-gray-400'  },
  failed:     { icon: XCircle,      color: 'text-red-500'   },
}
const RUNNING_ICON = { icon: Loader2, color: 'text-amber-400' }

function iconFor(exec: { status: string; outcome: string | null }) {
  if (exec.status === 'running') return RUNNING_ICON
  return OUTCOME_ICON[exec.outcome ?? exec.status] ?? OUTCOME_ICON.failed
}

interface Props {
  workflowId: string
  selectedId?: string
  onSelect: (id: string) => void
  refreshSignal?: number
}

type OutcomeFilter = 'all' | 'successful' | 'completed' | 'failed'

const FILTER_TABS: { key: OutcomeFilter; label: string }[] = [
  { key: 'all',        label: 'All'        },
  { key: 'successful', label: 'Successful' },
  { key: 'completed',  label: 'Completed'  },
  { key: 'failed',     label: 'Failed'     },
]

export default function ExecutionListPanel({ workflowId, selectedId, onSelect, refreshSignal }: Props) {
  const [executions, setExecutions] = useState<ExecRow[]>([])
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [filter, setFilter] = useState<OutcomeFilter>('all')
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())

  // Refs so the IntersectionObserver callback always sees current state
  // without re-binding on every executions/hasMore/loadingMore change.
  const execsRef = useRef<ExecRow[]>([])
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)
  useEffect(() => { execsRef.current = executions }, [executions])
  useEffect(() => { hasMoreRef.current = hasMore }, [hasMore])
  useEffect(() => { loadingMoreRef.current = loadingMore }, [loadingMore])

  // Generation token: bumps on every workflow/filter change. The 1s poll keeps
  // firing fetches; when the user switches tabs, the interval is cleared but
  // already-in-flight requests are not. Without this guard, a stale "all"
  // response can land after the new filter's response and pollute the merged
  // list — and mergeExecs only adds rows, so the pollution sticks.
  const genRef = useRef(0)
  useEffect(() => { genRef.current += 1 }, [workflowId, filter])

  function toggleError(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Fetch the newest page. On initial load it replaces state; on poll it
  // merges so older pages already loaded via loadMore aren't dropped.
  const loadFirstPage = useCallback((silent = false) => {
    if (!silent) setLoading(true)
    const opts = filter === 'all' ? undefined : { outcome: filter }
    const gen = genRef.current
    api.executions
      .list(workflowId, opts)
      .then((page) => {
        if (gen !== genRef.current) return // stale: filter/workflow changed mid-flight
        if (silent) {
          setExecutions((prev) => mergeExecs(prev, page))
        } else {
          setExecutions(page)
          setHasMore(page.length === PAGE_SIZE)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (gen === genRef.current) setLoading(false)
      })
  }, [workflowId, filter])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !hasMoreRef.current) return
    const oldest = execsRef.current[execsRef.current.length - 1]
    if (!oldest) return
    setLoadingMore(true)
    const opts: Parameters<typeof api.executions.list>[1] = {
      before: oldest.started_at,
      beforeId: oldest.id,
    }
    if (filter !== 'all') opts.outcome = filter
    const gen = genRef.current
    api.executions
      .list(workflowId, opts)
      .then((page) => {
        if (gen !== genRef.current) return // stale: filter/workflow changed mid-flight
        setExecutions((prev) => mergeExecs(prev, page))
        setHasMore(page.length === PAGE_SIZE)
      })
      .catch(() => {})
      .finally(() => {
        if (gen === genRef.current) setLoadingMore(false)
      })
  }, [workflowId, filter])

  const loadVersions = useCallback(() => {
    api.versions.list(workflowId).then(setVersions).catch(() => {})
  }, [workflowId])

  // Reset list when workflow or filter changes; this triggers a fresh first-page load.
  useEffect(() => {
    setExecutions([])
    setHasMore(true)
  }, [workflowId, filter])

  // Initial load + 1s polling for executions; versions load once (refresh on save signal)
  useEffect(() => {
    loadFirstPage()
    loadVersions()
    const tick = setInterval(() => { if (!document.hidden) loadFirstPage(true) }, 1000)
    const onVisible = () => { if (!document.hidden) loadFirstPage(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadFirstPage, loadVersions])

  useEffect(() => {
    if (refreshSignal) {
      loadFirstPage(true)
      loadVersions()
    }
  }, [refreshSignal, loadFirstPage, loadVersions])

  // Sentinel ref callback: (re)attaches an IntersectionObserver to the
  // bottom-of-list element. The scroll container is the parent .overflow-y-auto
  // div, set as `root` so observation fires only when the sentinel scrolls
  // into the panel's viewport (not the page's).
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (!node) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { root: scrollRootRef.current, rootMargin: '200px' }
    )
    obs.observe(node)
    observerRef.current = obs
  }, [loadMore])

  const filtered = executions
  const items = buildItems(filtered, versions)

  return (
    <aside className="flex w-72 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Executions</p>
      </div>
      <div className="flex justify-around border-b border-gray-100">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-2 py-1.5 text-xs transition-colors ${
              filter === tab.key
                ? 'border-b-2 border-p-blue-dark font-semibold text-p-blue-dark'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div ref={scrollRootRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="border-b border-gray-50 px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <Skeleton className="h-3 w-3 rounded-full flex-shrink-0" />
                  <Skeleton className="h-4 w-16 rounded" />
                  <Skeleton className="ml-auto h-3 w-8" />
                </div>
                <Skeleton className="mt-1 h-3 w-12" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center">
            {filter === 'all' ? (
              <>
                <p className="text-xs font-medium text-gray-500">No executions yet</p>
                <p className="mt-1 text-xs text-gray-400">Trigger the workflow via webhook or use the Test button to run it.</p>
              </>
            ) : (
              <p className="text-xs text-gray-400">No {filter} executions.</p>
            )}
          </div>
        ) : (
          <div>
            {items.map((item, i) => {
              if (item.type === 'date-header') {
                return (
                  <div key={`date-${item.label}-${i}`} className="sticky top-0 bg-beige px-3 py-1.5 border-b border-gray-100">
                    <p className="text-xs font-medium text-gray-400">{item.label}</p>
                  </div>
                )
              }

              if (item.type === 'version-divider') {
                const v = item.version
                return (
                  <div
                    key={`v-${v.id}`}
                    className="flex items-center gap-2 px-2 py-1.5"
                    title={`Saved ${formatTime(v.created_at)}${v.message ? ` · ${v.message}` : ''}`}
                  >
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="whitespace-nowrap text-[10px] font-medium text-gray-400">
                      Version {v.version_number}
                    </span>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>
                )
              }

              const exec = item.exec
              const cfg = iconFor(exec)
              const Icon = cfg.icon
              const isSelected = exec.id === selectedId
              return (
                <button
                  key={exec.id}
                  onClick={() => onSelect(exec.id)}
                  className={`w-full border-b border-gray-50 px-3 py-2.5 text-left transition-colors hover:bg-beige ${
                    isSelected ? 'border-l-2 border-l-p-blue-dark bg-p-blue-light' :
                    exec.status === 'failed' ? 'border-l-2 border-l-red-400' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.color}`} />
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-gray-800">
                      {exec.source}
                    </span>
                    <span className="ml-auto text-xs text-gray-400">{formatTime(exec.started_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-400">
                      {exec.duration_ms !== null ? formatDuration(exec.duration_ms) : ' '}
                    </p>
                    {exec.parent_execution_id && (
                      <span className="flex items-center gap-1 rounded-full bg-p-blue-light px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-p-blue-dark">
                        <RotateCcw className="h-3 w-3" />
                        Replay
                      </span>
                    )}
                    {exec.has_children && !exec.parent_execution_id && (
                      <span className="flex items-center gap-1 rounded-full bg-p-blue-light px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-p-blue-dark">
                        <RotateCcw className="h-3 w-3 -scale-x-100" />
                        Replayed
                      </span>
                    )}
                  </div>
                  {exec.status === 'failed' && exec.error_message && (
                    <p
                      onClick={(e) => toggleError(exec.id, e)}
                      className={`mt-0.5 text-xs text-red-500 hover:text-red-700 cursor-pointer ${
                        expandedErrors.has(exec.id) ? 'whitespace-pre-wrap break-words' : 'truncate'
                      }`}
                      title={expandedErrors.has(exec.id) ? 'Click to collapse' : 'Click to expand'}
                    >
                      {exec.error_message}
                    </p>
                  )}
                </button>
              )
            })}
            {hasMore ? (
              <div ref={sentinelRef} className="flex justify-center px-3 py-3">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
              </div>
            ) : filtered.length > 0 ? (
              <p className="px-3 py-3 text-center text-[10px] text-gray-300">End of history</p>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}
