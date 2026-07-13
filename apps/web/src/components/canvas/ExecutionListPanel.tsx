'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual'
import { api } from '@/lib/api'
import * as execCache from '@/lib/execution-cache'
import { CheckCircle, CheckCircle2, XCircle, Loader2, RotateCcw, AlertTriangle } from 'lucide-react'

const PAGE_SIZE = 100

// Union a + b, dedupe by id, sort newest-first, and trim to `cap` rows.
// The cap is load-bearing: the 1s poll merges the newest page every second, and
// on a high-volume workflow that page is mostly fresh rows each tick. Without a
// bound, the merged set (and the un-virtualized DOM list below) grows without
// limit while the tab sits open, eventually OOMing the renderer. Callers pass a
// cap of (loadedPages + 1) * PAGE_SIZE so polling only refreshes the newest
// window, while explicit loadMore scroll-back still extends it.
function mergeExecs(a: ExecRow[], b: ExecRow[], cap: number): ExecRow[] {
  const map = new Map<string, ExecRow>()
  for (const e of a) map.set(e.id, e)
  for (const e of b) map.set(e.id, e)
  return Array.from(map.values())
    .sort((x, y) => {
      if (x.started_at !== y.started_at) return x.started_at < y.started_at ? 1 : -1
      return x.id < y.id ? 1 : -1
    })
    .slice(0, cap)
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
  completed:  { icon: CheckCircle,  color: 'text-gray-500'  },
  failed:     { icon: XCircle,      color: 'text-red-500'   },
}
const RUNNING_ICON = { icon: Loader2, color: 'text-amber-400' }
// The lead was served, but a post-response side-effect (e.g. the Salesforce
// writeback) failed (#310). Distinct from completed so it's visibly surfaced
// rather than hidden behind the served outcome.
const DEGRADED_ICON = { icon: AlertTriangle, color: 'text-amber-500' }

export function iconFor(exec: { status: string; outcome: string | null }) {
  if (exec.status === 'running') return RUNNING_ICON
  // A degraded run has a non-failed outcome (the lead was served), so check
  // status BEFORE the outcome fallback or it would render as a normal completed.
  if (exec.status === 'degraded') return DEGRADED_ICON
  return OUTCOME_ICON[exec.outcome ?? exec.status] ?? OUTCOME_ICON.failed
}

interface Props {
  workflowId: string
  selectedId?: string
  onSelect: (id: string) => void
  refreshSignal?: number
}

type OutcomeFilter = 'all' | 'successful' | 'completed' | 'failed' | 'degraded'

// Labels are abbreviated to fit all five tabs inside the fixed 288px (w-72)
// panel. The full status names overflowed the row and clipped the last tab.
export const FILTER_TABS: { key: OutcomeFilter; label: string }[] = [
  { key: 'all',        label: 'All'      },
  { key: 'successful', label: 'Success'  },
  { key: 'completed',  label: 'Done'     },
  { key: 'degraded',   label: 'Degraded' },
  { key: 'failed',     label: 'Failed'   },
]

// Every tab reserves the 2px bottom border, transparent when inactive. Without
// it, only the active tab was 2px taller, and the flex row's stretch pushed the
// inactive labels a pixel below the active one.
export function tabClass(active: boolean): string {
  return `border-b-2 px-2 py-1.5 text-xs transition-colors ${
    active
      ? 'border-p-blue-dark font-semibold text-p-blue-dark'
      : 'border-transparent text-gray-500 hover:text-gray-600'
  }`
}

// Map a filter tab to the api.executions.list query params. 'degraded' is a
// status (the lead was served but a post-response writeback failed), not an
// outcome, so it filters by status; the rest filter by outcome. #352
export function listParamsForFilter(
  filter: OutcomeFilter,
): { outcome?: 'successful' | 'completed' | 'failed'; status?: 'degraded' } {
  if (filter === 'all') return {}
  if (filter === 'degraded') return { status: 'degraded' }
  return { outcome: filter }
}

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
  // How many older pages the user has explicitly scrolled in via loadMore.
  // Drives the retained-row cap so the 1s poll can't grow the list unbounded
  // (newest window stays at PAGE_SIZE), but deliberate scroll-back still works.
  const pagesLoadedRef = useRef(0)
  useEffect(() => { execsRef.current = executions }, [executions])
  useEffect(() => { hasMoreRef.current = hasMore }, [hasMore])
  useEffect(() => { loadingMoreRef.current = loadingMore }, [loadingMore])

  // Generation token: bumps on every workflow/filter change. The 1s poll keeps
  // firing fetches; when the user switches tabs, the interval is cleared but
  // already-in-flight requests are not. Without this guard, a stale "all"
  // response can land after the new filter's response and pollute the merged
  // list with rows that don't match the active filter.
  const genRef = useRef(0)
  useEffect(() => { genRef.current += 1 }, [workflowId, filter])

  function toggleError(id: string, e: React.MouseEvent | React.KeyboardEvent) {
    e.preventDefault()
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
    const opts: Parameters<typeof api.executions.list>[1] = { ...listParamsForFilter(filter) }
    const gen = genRef.current
    api.executions
      .list(workflowId, opts)
      .then((page) => {
        if (gen !== genRef.current) return // stale: filter/workflow changed mid-flight
        if (silent) {
          const cap = (pagesLoadedRef.current + 1) * PAGE_SIZE
          setExecutions((prev) => mergeExecs(prev, page, cap))
        } else {
          // Fresh load (initial / refresh signal): reset the scroll-back window.
          pagesLoadedRef.current = 0
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
      ...listParamsForFilter(filter),
    }
    const gen = genRef.current
    api.executions
      .list(workflowId, opts)
      .then((page) => {
        if (gen !== genRef.current) return // stale: filter/workflow changed mid-flight
        // Grow the retained window by one page before merging so the older rows
        // we just fetched survive the cap (and aren't trimmed by the next poll).
        pagesLoadedRef.current += 1
        const cap = (pagesLoadedRef.current + 1) * PAGE_SIZE
        setExecutions((prev) => mergeExecs(prev, page, cap))
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
    pagesLoadedRef.current = 0
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

  // Hover prefetch: 150ms debounce keeps a quick mouse-pass over the list
  // from firing 20+ requests. The cache itself dedupes against an in-flight
  // fetch, so a clicked row that's mid-hover-prefetch reuses the same call.
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onRowEnter = useCallback((id: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      execCache.prefetch(id)
    }, 150)
  }, [])
  const onRowLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  // Background sweep: every 10s prefetch the first 20 rows in the current
  // filter view. Chunks of 5 with 400ms gaps so we don't open 20 sockets at
  // once. Running/queued rows are revalidated (status may have changed);
  // terminal rows get prefetched once and skipped thereafter.
  useEffect(() => {
    let cancelled = false
    let chunkTimer: ReturnType<typeof setTimeout> | null = null

    const sweep = () => {
      if (cancelled || document.hidden) return
      const top = execsRef.current.slice(0, 20)
      if (!top.length) return
      let i = 0
      const fire = () => {
        if (cancelled) return
        const batch = top.slice(i, i + 5)
        i += 5
        for (const row of batch) {
          // Revalidate is a no-op on a cache miss, prefetch is a no-op on a
          // hit. Calling both covers "first time we've seen this id" and
          // "cached as running, should refresh."
          execCache.revalidateIfRunning(row.id)
          execCache.prefetch(row.id)
        }
        if (i < top.length) chunkTimer = setTimeout(fire, 400)
      }
      fire()
    }
    const interval = setInterval(sweep, 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
      if (chunkTimer) clearTimeout(chunkTimer)
    }
  }, [])

  const filtered = executions
  const items = useMemo(() => buildItems(filtered, versions), [filtered, versions])

  // Virtualized list: only the rows in (and near) the viewport are mounted, so
  // the DOM stays bounded no matter how deep the user scrolls back. Heights vary
  // (exec rows expand to show errors, dividers/headers differ), so we measure
  // each rendered row dynamically via measureElement. The scroll container is
  // the parent .overflow-y-auto div (scrollRootRef).
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  // Indices of the date-header rows — used to keep one header pinned to the top
  // while its date's executions scroll under it (replaces the old CSS-sticky
  // behavior, which doesn't survive virtualization since rows are absolutely
  // positioned). activeStickyIndexRef holds the header currently pinned.
  const headerIndexes = useMemo(
    () => items.flatMap((it, i) => (it.type === 'date-header' ? [i] : [])),
    [items]
  )
  const activeStickyIndexRef = useRef(0)

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRootRef.current,
    estimateSize: () => 56,
    overscan: 10,
    getItemKey: (index) => {
      const it = items[index]
      if (it.type === 'exec') return `e-${it.exec.id}`
      if (it.type === 'version-divider') return `v-${it.version.id}`
      return `d-${index}`
    },
    // Always keep the active sticky header in the rendered set so it can pin to
    // the top even after its slot scrolls out of view.
    rangeExtractor: useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        let active = 0
        for (const i of headerIndexes) {
          if (i <= range.startIndex) active = i
          else break
        }
        activeStickyIndexRef.current = active
        const next = new Set([active, ...defaultRangeExtractor(range)])
        return [...next].sort((a, b) => a - b)
      },
      [headerIndexes]
    ),
  })

  // Infinite scroll: when the rendered window reaches the tail of the list,
  // pull the next older page. loadMore guards against concurrent/duplicate
  // calls internally, so firing on every range change is safe.
  const virtualItems = rowVirtualizer.getVirtualItems()
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1]
    if (last && last.index >= items.length - 5) loadMore()
  }, [virtualItems, items.length, loadMore])

  return (
    <aside className="flex w-72 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Executions</p>
      </div>
      <div className="flex justify-around border-b border-gray-100">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={tabClass(filter === tab.key)}
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
                <p className="mt-1 text-xs text-gray-500">Trigger the workflow via webhook or use the Test button to run it.</p>
              </>
            ) : (
              <p className="text-xs text-gray-500">No {filter} executions.</p>
            )}
          </div>
        ) : (
          <>
            <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            {virtualItems.map((vRow) => {
              const item = items[vRow.index]
              if (!item) return null
              const isActiveStickyHeader =
                item.type === 'date-header' && activeStickyIndexRef.current === vRow.index
              const wrapStyle: React.CSSProperties = isActiveStickyHeader
                ? { position: 'sticky', top: 0, zIndex: 2, width: '100%' }
                : { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }
              const wrap = (children: React.ReactNode) => (
                <div key={vRow.key} data-index={vRow.index} ref={rowVirtualizer.measureElement} style={wrapStyle}>
                  {children}
                </div>
              )
              if (item.type === 'date-header') {
                return wrap(
                  <div className="bg-beige px-3 py-1.5 border-b border-gray-100">
                    <p className="text-xs font-medium text-gray-500">{item.label}</p>
                  </div>
                )
              }

              if (item.type === 'version-divider') {
                const v = item.version
                return wrap(
                  <div
                    className="flex items-center gap-2 px-2 py-1.5"
                    title={`Saved ${formatTime(v.created_at)}${v.message ? ` · ${v.message}` : ''}`}
                  >
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="whitespace-nowrap text-[10px] font-medium text-gray-500">
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
              return wrap(
                <a
                  href={`/workflows/${workflowId}?execution=${exec.id}`}
                  onClick={(e) => {
                    // Let the browser handle modifier / middle clicks natively (open in new tab).
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                    e.preventDefault()
                    onSelect(exec.id)
                  }}
                  onMouseEnter={() => onRowEnter(exec.id)}
                  onMouseLeave={onRowLeave}
                  className={`block w-full border-b border-gray-50 px-3 py-2.5 text-left transition-colors hover:bg-beige ${
                    isSelected ? 'border-l-2 border-l-p-blue-dark bg-p-blue-light' :
                    exec.status === 'failed' ? 'border-l-2 border-l-red-400' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.color}`} />
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-gray-800">
                      {exec.source}
                    </span>
                    <span className="ml-auto text-xs text-gray-500">{formatTime(exec.started_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500">
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
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => toggleError(exec.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') toggleError(exec.id, e)
                      }}
                      className={`mt-0.5 text-xs text-red-500 hover:text-red-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark ${
                        expandedErrors.has(exec.id) ? 'whitespace-pre-wrap break-words' : 'truncate'
                      }`}
                      title={expandedErrors.has(exec.id) ? 'Click to collapse' : 'Click to expand'}
                    >
                      {exec.error_message}
                    </div>
                  )}
                </a>
              )
            })}
            </div>
            {hasMore ? (
              <div className="flex justify-center px-3 py-3">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
              </div>
            ) : filtered.length > 0 ? (
              <p className="px-3 py-3 text-center text-[10px] text-gray-300">End of history</p>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}
