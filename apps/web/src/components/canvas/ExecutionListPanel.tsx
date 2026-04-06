'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { CheckCircle, XCircle, Clock, RefreshCw, Loader2 } from 'lucide-react'

type ExecRow = {
  id: string
  status: string
  source: string
  started_at: string
  duration_ms: number | null
  error_message: string | null
}

function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yestStart = new Date(todayStart.getTime() - 86_400_000)
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (dStart.getTime() === todayStart.getTime()) return 'Today'
  if (dStart.getTime() === yestStart.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
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

export default function ExecutionListPanel({ workflowId, selectedId, onSelect, refreshSignal }: Props) {
  const [executions, setExecutions] = useState<ExecRow[]>([])
  const [loading, setLoading] = useState(true)

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

  // Group by date
  const groups: { label: string; items: ExecRow[] }[] = []
  for (const exec of executions) {
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

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-4 text-xs text-gray-400">Loading…</p>
        ) : executions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-400">No executions yet.</p>
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
                      <span className="text-xs font-medium capitalize text-gray-700">
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
                      <p className="mt-0.5 truncate text-xs text-red-400">
                        {exec.error_message.length > 60 ? exec.error_message.slice(0, 60) + '…' : exec.error_message}
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
