'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { CheckCircle, XCircle, Clock, RefreshCw, Loader2 } from 'lucide-react'
import { getDateLabel, formatTime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

type ExecRow = {
  id: string
  status: string
  source: string
  started_at: string
  duration_ms: number | null
  error_message: string | null
}

function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const STATUS_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  completed: { icon: CheckCircle, color: 'text-green-500' },
  failed:    { icon: XCircle,     color: 'text-red-500'   },
  running:   { icon: Loader2,     color: 'text-amber-400' },
}

interface Props {
  workflowId: string
  selectedId?: string
  onSelect: (id: string) => void
  refreshSignal?: number  // increment to trigger a refresh
}

type StatusFilter = 'all' | 'failed' | 'completed'

const FILTER_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all',       label: 'All'       },
  { key: 'failed',    label: 'Failed'    },
  { key: 'completed', label: 'Completed' },
]

export default function ExecutionListPanel({ workflowId, selectedId, onSelect, refreshSignal }: Props) {
  const [executions, setExecutions] = useState<ExecRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())

  function toggleError(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setExpandedErrors((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function load() {
    setLoading(true)
    api.executions
      .list(workflowId)
      .then(setExecutions)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workflowId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshSignal) load() }, [refreshSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = filter === 'all' ? executions : executions.filter((e) => e.status === filter)

  // Group by date
  const groups: { label: string; items: ExecRow[] }[] = []
  for (const exec of filtered) {
    const label = getDateLabel(exec.started_at)
    const existing = groups.find((g) => g.label === label)
    if (existing) existing.items.push(exec)
    else groups.push({ label, items: [exec] })
  }

  return (
    <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Executions</p>
        <button
          onClick={load}
          className="rounded p-1 text-gray-400 hover:bg-gray-100"
          title="Refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div className="flex border-b border-gray-100">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`flex-1 py-1.5 text-xs transition-colors ${
              filter === tab.key
                ? 'border-b-2 border-indigo-500 font-semibold text-indigo-600'
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
          groups.map(({ label, items }) => (
            <div key={label}>
              <div className="sticky top-0 bg-gray-50 px-3 py-1.5 border-b border-gray-100">
                <p className="text-xs font-medium text-gray-400">{label}</p>
              </div>
              {items.map((exec) => {
                const cfg = STATUS_ICON[exec.status] ?? STATUS_ICON['failed']
                const Icon = cfg.icon
                const isSelected = exec.id === selectedId
                return (
                  <button
                    key={exec.id}
                    onClick={() => onSelect(exec.id)}
                    className={`w-full border-b border-gray-50 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
                      isSelected ? 'border-l-2 border-l-indigo-400 bg-indigo-50' : ''
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-3 w-3 flex-shrink-0 ${cfg.color}`} />
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
                        className={`mt-0.5 text-xs text-red-400 hover:text-red-600 cursor-pointer ${
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
          ))
        )}
      </div>
    </aside>
  )
}
