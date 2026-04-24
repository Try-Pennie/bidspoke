'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { CheckCircle, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
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
  const [filter, setFilter] = useState<OutcomeFilter>('all')
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())

  function toggleError(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true)
    api.executions
      .list(workflowId)
      .then(setExecutions)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workflowId])

  const loadVersions = useCallback(() => {
    api.versions.list(workflowId).then(setVersions).catch(() => {})
  }, [workflowId])

  // Initial load + 1s polling for executions; versions load once (refresh on save signal)
  useEffect(() => {
    load()
    loadVersions()
    const tick = setInterval(() => { if (!document.hidden) load(true) }, 1000)
    const onVisible = () => { if (!document.hidden) load(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, loadVersions])

  useEffect(() => {
    if (refreshSignal) {
      load(true)
      loadVersions()
    }
  }, [refreshSignal, load, loadVersions])

  const filtered = filter === 'all'
    ? executions
    : executions.filter((e) => (e.outcome ?? (e.status === 'failed' ? 'failed' : null)) === filter)
  const items = buildItems(filtered, versions)

  return (
    <aside className="flex w-72 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Executions</p>
      </div>
      <div className="flex border-b border-gray-100">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`flex-1 py-1.5 text-xs transition-colors ${
              filter === tab.key
                ? 'border-b-2 border-p-blue-dark font-semibold text-p-blue-dark'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
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
                    {exec.duration_ms !== null && (
                      <span className="ml-auto text-xs text-gray-400">
                        {formatDuration(exec.duration_ms)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-400">{formatTime(exec.started_at)}</p>
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
          </div>
        )}
      </div>
    </aside>
  )
}
