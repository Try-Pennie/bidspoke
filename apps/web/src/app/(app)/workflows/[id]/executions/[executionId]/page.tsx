'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { ArrowLeft, LayoutTemplate, CheckCircle, XCircle, Clock, SkipForward, RefreshCw, Copy, Check } from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

type Execution = Awaited<ReturnType<typeof api.executions.get>>

const STATUS_STYLES: Record<string, { icon: React.ReactNode; label: string; bg: string; text: string }> = {
  completed:            { icon: <CheckCircle className="h-4 w-4" />, label: 'Completed',   bg: 'bg-green-50',  text: 'text-green-700' },
  failed:               { icon: <XCircle className="h-4 w-4" />,    label: 'Failed',       bg: 'bg-red-50',    text: 'text-red-700'   },
  skipped:              { icon: <SkipForward className="h-4 w-4" />, label: 'Skipped',      bg: 'bg-gray-50',   text: 'text-gray-500'  },
  running:              { icon: <Clock className="h-4 w-4" />,       label: 'Running',      bg: 'bg-p-blue-light', text: 'text-p-blue-dark' },
  failed_with_fallback: { icon: <RefreshCw className="h-4 w-4" />,   label: 'Fallback',     bg: 'bg-yellow-50', text: 'text-yellow-700'},
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.running
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.bg} ${s.text}`}>
      {s.icon}
      {s.label}
    </span>
  )
}

function formatDuration(ms: number | null) {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function buildReport(execution: Execution): string {
  const lines: string[] = []
  lines.push(`# Execution ${execution.id}`)
  lines.push('')
  lines.push(`Status: ${execution.status}`)
  lines.push(`Source: ${execution.source}`)
  lines.push(`Duration: ${formatDuration(execution.duration_ms)}`)
  lines.push(`Started: ${execution.started_at}`)
  lines.push(`Trace ID: ${execution.trace_id}`)
  if (execution.error_message) {
    lines.push(`Error: ${execution.error_message}`)
  }
  lines.push('')
  lines.push('## Trigger payload')
  lines.push('```json')
  lines.push(JSON.stringify(execution.trigger_payload, null, 2))
  lines.push('```')
  lines.push('')
  lines.push(`## Steps (${execution.steps.length})`)
  lines.push('')
  execution.steps.forEach((step, i) => {
    lines.push(`### ${i + 1}. ${step.step_namespace} (${step.step_type})`)
    lines.push(`Status: ${step.status} · Duration: ${formatDuration(step.duration_ms)}${step.retries_used > 0 ? ` · Retries: ${step.retries_used}` : ''}`)
    if (step.error_message) {
      lines.push(`Error: ${step.error_message}${step.error_type ? ` (${step.error_type})` : ''}`)
    }
    lines.push('')
    lines.push('Input:')
    lines.push('```json')
    lines.push(JSON.stringify(step.input, null, 2))
    lines.push('```')
    lines.push('Output:')
    lines.push('```json')
    lines.push(JSON.stringify(step.output, null, 2))
    lines.push('```')
    lines.push('')
  })
  return lines.join('\n')
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-gray-400 italic">null</span>
  return (
    <pre className="overflow-auto rounded bg-gray-50 p-3 text-xs text-gray-700 max-h-48">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export default function ExecutionDetailPage() {
  const params = useParams()
  const router = useRouter()
  const workflowId = params.id as string
  const executionId = params.executionId as string

  const [execution, setExecution] = useState<Execution | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function copyReport() {
    if (!execution) return
    const text = buildReport(execution)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers / contexts where clipboard API rejects
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        // swallow — nothing else to do
      }
      document.body.removeChild(ta)
    }
  }

  useEffect(() => {
    api.executions.get(executionId)
      .then(setExecution)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [executionId])

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <button
            onClick={() => router.push(`/workflows/${workflowId}?execution=${executionId}`)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-graphite"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to workflow
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={copyReport}
              disabled={!execution}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy report'}
            </button>
            <button
              onClick={() => router.push(`/workflows/${workflowId}?execution=${executionId}`)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige"
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              View on canvas
            </button>
          </div>
        </div>

        {loading && (
          <div className="space-y-6">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-7 w-24 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:grid-cols-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
            <div className="space-y-3">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-6 w-6 rounded-full" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                    <Skeleton className="h-6 w-20 rounded-full" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Skeleton className="h-24 rounded-lg" />
                    <Skeleton className="h-24 rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {execution && (
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-3xl font-bold text-graphite">Execution detail</h1>
                <p className="mt-1 font-mono text-xs text-gray-400">{execution.id}</p>
              </div>
              <StatusBadge status={execution.status} />
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:grid-cols-4">
              <div>
                <p className="text-xs font-medium text-gray-500">Source</p>
                <p className="mt-1 font-mono text-sm text-graphite">{execution.source}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Duration</p>
                <p className="mt-1 text-sm text-graphite">{formatDuration(execution.duration_ms)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Started</p>
                <p className="mt-1 text-sm text-graphite">{formatDatetime(execution.started_at)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Trace ID</p>
                <p className="mt-1 font-mono text-xs text-gray-500 truncate">{execution.trace_id}</p>
              </div>
            </div>

            {/* Error */}
            {execution.error_message && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                <p className="mb-1 text-xs font-medium text-red-600">Error</p>
                <p className="font-mono text-sm text-red-800">{execution.error_message}</p>
              </div>
            )}

            {/* Trigger payload */}
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Trigger payload</h2>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <JsonBlock value={execution.trigger_payload} />
              </div>
            </div>

            {/* Steps */}
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Steps</h2>
              {execution.steps.length === 0 ? (
                <p className="text-sm text-gray-400">No steps recorded.</p>
              ) : (
                <div className="space-y-3">
                  {execution.steps.map((step, i) => (
                    <div
                      key={step.id}
                      className={`rounded-xl border bg-white p-4 ${
                        step.status === 'failed' ? 'border-red-200' : 'border-gray-200'
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-500">
                            {i + 1}
                          </span>
                          <div>
                            <p className="font-mono text-sm font-semibold text-graphite">{step.step_namespace}</p>
                            <p className="text-xs text-gray-400">{step.step_type} · {formatDuration(step.duration_ms)}</p>
                          </div>
                        </div>
                        <StatusBadge status={step.status} />
                      </div>

                      {step.error_message && (
                        <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                          <p className="font-mono text-xs text-red-700">{step.error_message}</p>
                          {step.error_type && (
                            <p className="mt-0.5 text-xs text-red-400">{step.error_type} error{step.retries_used > 0 ? ` · ${step.retries_used} retr${step.retries_used === 1 ? 'y' : 'ies'}` : ''}</p>
                          )}
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="mb-1 text-xs font-medium text-gray-500">Input</p>
                          <JsonBlock value={step.input} />
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-gray-500">Output</p>
                          <JsonBlock value={step.output} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </NavLayout>
  )
}
