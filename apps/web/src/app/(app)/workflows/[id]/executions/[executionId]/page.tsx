'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { ArrowLeft, LayoutTemplate, CheckCircle, XCircle, Clock, SkipForward, RefreshCw, Copy, Check, AlertTriangle } from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

type Execution = Awaited<ReturnType<typeof api.executions.get>>
type Step = Execution['steps'][number]

interface BidGroupOutputShape {
  winner: { partner: string; bid: number } | null
  all_bids?: PartnerBidOutputShape[]
  mode?: string
  reason?: string
  _route?: 'winner' | 'no_winner'
}

interface PartnerBidOutputShape {
  partner: string
  bid: number | null
  accepted: boolean
  skipped: boolean
  skip_reason?: string
  cap_count?: number
  resolver_type?: 'formula' | 'api' | 'matrix' | null
  matrix?: {
    config_id: string
    matched_row_id: string | null
    last_synced_at: string | null
    is_sell_off?: boolean
    reason?: string
  } | null
}

const LOG_LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-300',
  warn: 'text-yellow-300',
  info: 'text-blue-300',
  log: 'text-gray-100',
  debug: 'text-gray-400',
}

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
    if (step.input !== null) {
      lines.push('Input:')
      lines.push('```json')
      lines.push(JSON.stringify(step.input, null, 2))
      lines.push('```')
    }
    lines.push('Output:')
    lines.push('```json')
    lines.push(JSON.stringify(step.output, null, 2))
    lines.push('```')
    lines.push('')
  })
  return lines.join('\n')
}

function describeAttempt(attempt: PartnerBidOutputShape): { result: string; tone: 'green' | 'gray' | 'red' | 'amber'; why: string } {
  if (attempt.accepted) {
    return { result: 'Bid', tone: 'green', why: '' }
  }
  if (attempt.skipped) {
    if (attempt.skip_reason === 'duplicate') return { result: 'Skipped', tone: 'gray', why: 'Dedup match' }
    if (attempt.skip_reason === 'cap_exceeded') return { result: 'Skipped', tone: 'gray', why: `Daily cap${attempt.cap_count !== undefined ? ` (${attempt.cap_count})` : ''}` }
    if (attempt.skip_reason === 'circuit_open') return { result: 'Skipped', tone: 'amber', why: 'Circuit breaker open' }
    if (attempt.skip_reason === 'partner_inactive') return { result: 'Skipped', tone: 'gray', why: 'Partner inactive' }
    if (attempt.skip_reason === 'bid_below_min') return { result: 'No bid', tone: 'amber', why: `Below min${attempt.bid !== null ? ` ($${attempt.bid})` : ''}` }
    if (attempt.skip_reason === 'rejected') return { result: 'Rejected', tone: 'red', why: 'Partner declined' }
    return { result: 'Skipped', tone: 'gray', why: attempt.skip_reason ?? '' }
  }
  if (attempt.bid === null) {
    if (attempt.matrix?.reason === 'no_matching_cell') {
      return { result: 'No bid', tone: 'red', why: 'No matrix row matched the lead' }
    }
    if (attempt.matrix?.reason?.startsWith('missing_payload_field:')) {
      const field = attempt.matrix.reason.split(':')[1]
      return { result: 'No bid', tone: 'red', why: `Missing payload field: ${field}` }
    }
    if (attempt.matrix?.reason === 'config_inactive') {
      return { result: 'No bid', tone: 'amber', why: 'Matrix config inactive' }
    }
    return { result: 'No bid', tone: 'gray', why: attempt.matrix?.reason ?? 'Resolver returned null' }
  }
  return { result: 'No bid', tone: 'gray', why: '' }
}

function describeMode(attempt: PartnerBidOutputShape): string {
  if (attempt.resolver_type === 'matrix') return attempt.matrix?.is_sell_off ? 'Matrix (sell-off)' : 'Matrix'
  if (attempt.resolver_type === 'formula') return 'Formula'
  if (attempt.resolver_type === 'api') return 'API'
  return '—'
}

function ToneBadge({ tone, children }: { tone: 'green' | 'gray' | 'red' | 'amber'; children: React.ReactNode }) {
  const cls = {
    green: 'bg-green-50 text-green-700',
    gray: 'bg-gray-100 text-gray-600',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
}

function BidGroupSummary({ groupStep, attemptSteps }: { groupStep: Step; attemptSteps: Step[] }) {
  const output = (groupStep.output ?? {}) as BidGroupOutputShape
  const noWinner = output._route === 'no_winner' || !output.winner
  const reason = output.reason ?? 'unknown'
  const mode = output.mode ?? '—'

  // Prefer per-attempt step rows (one per partner) when available, since they carry
  // per-partner timing and step status. Fall back to the bid_group's all_bids array
  // for the data we need to render the table.
  const attempts: PartnerBidOutputShape[] = attemptSteps.length > 0
    ? attemptSteps.map((s) => (s.output as PartnerBidOutputShape) ?? { partner: s.step_namespace, bid: null, accepted: false, skipped: false })
    : (output.all_bids ?? [])

  const winnerSlug = output.winner?.partner

  const headerTone = noWinner ? 'border-red-200 bg-red-50/30' : 'border-green-200 bg-green-50/30'
  const headerIcon = noWinner ? <AlertTriangle className="h-4 w-4 text-red-600" /> : <CheckCircle className="h-4 w-4 text-green-600" />

  return (
    <div className={`rounded-xl border ${headerTone} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {headerIcon}
          <h3 className="font-mono text-sm font-semibold text-graphite">{groupStep.step_namespace}</h3>
          <span className="text-xs text-gray-500">{mode}</span>
        </div>
        <div className="text-xs text-gray-600">
          {noWinner
            ? <span className="font-medium text-red-700">No winner — {reason.replace(/_/g, ' ')}</span>
            : <span className="font-medium text-green-700">Winner: {winnerSlug} (${output.winner?.bid ?? 0})</span>}
        </div>
      </div>

      {attempts.length === 0 ? (
        <p className="text-xs text-gray-500">No partner attempts recorded.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Partner</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 text-right font-medium">Bid</th>
                <th className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {attempts.map((a, i) => {
                const d = describeAttempt(a)
                const isWinner = a.partner === winnerSlug && a.accepted
                return (
                  <tr key={`${a.partner}-${i}`} className={isWinner ? 'bg-green-50/40' : undefined}>
                    <td className="px-3 py-2 font-mono text-graphite">{a.partner}</td>
                    <td className="px-3 py-2 text-gray-600">{describeMode(a)}</td>
                    <td className="px-3 py-2"><ToneBadge tone={isWinner ? 'green' : d.tone}>{isWinner ? 'Won' : d.result}</ToneBadge></td>
                    <td className="px-3 py-2 text-right font-mono text-graphite">{a.bid !== null ? `$${a.bid}` : '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{d.why || (isWinner ? '' : '—')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function findBidGroupSummaries(steps: Step[]): Array<{ groupStep: Step; attemptSteps: Step[] }> {
  const groups: Array<{ groupStep: Step; attemptSteps: Step[] }> = []
  for (const step of steps) {
    if (step.step_type !== 'bid_group') continue
    const nodeId = (step as { step_node_id?: string }).step_node_id
    const attemptSteps = nodeId
      ? steps.filter((s) => s.step_type === 'partner_bid' && (s as { parallel_group_id?: string }).parallel_group_id === nodeId)
      : []
    groups.push({ groupStep: step, attemptSteps })
  }
  return groups
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

            {/* Replay lineage */}
            {(execution.parent_execution_id || (execution.child_executions?.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-beige px-4 py-3 text-xs text-gray-600">
                {execution.parent_execution_id && (
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-gray-400" />
                    <span>Replay of</span>
                    <button
                      onClick={() => router.push(`/workflows/${workflowId}/executions/${execution.parent_execution_id}`)}
                      className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                    >
                      {execution.parent_execution_id.slice(0, 8)}…
                    </button>
                  </span>
                )}
                {(execution.child_executions?.length ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-gray-400" />
                    <span>{execution.child_executions.length === 1 ? 'Replayed once:' : `Replayed ${execution.child_executions.length} times:`}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {execution.child_executions.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => router.push(`/workflows/${workflowId}/executions/${c.id}`)}
                          className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                        >
                          {c.id.slice(0, 8)}…
                        </button>
                      ))}
                    </span>
                  </span>
                )}
              </div>
            )}

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

            {/* Bid group summary — surfaced above the steps so "why no bid?" is one click away */}
            {(() => {
              const summaries = findBidGroupSummaries(execution.steps)
              if (summaries.length === 0) return null
              return (
                <div>
                  <h2 className="mb-3 text-sm font-semibold text-gray-700">Bid attempts</h2>
                  <div className="space-y-3">
                    {summaries.map(({ groupStep, attemptSteps }) => (
                      <BidGroupSummary key={groupStep.id} groupStep={groupStep} attemptSteps={attemptSteps} />
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Steps */}
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Steps</h2>
              {execution.steps.length === 0 ? (
                <p className="text-sm text-gray-400">No steps recorded.</p>
              ) : (
                <div className="space-y-3">
                  {execution.steps
                    .filter((step) => step.step_type !== 'branch_end' && step.step_type !== 'parallel_end')
                    .map((step, i) => (
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

                      <div className={`grid gap-3 ${step.input !== null ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        {step.input !== null && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-gray-500">Input</p>
                            <JsonBlock value={step.input} />
                          </div>
                        )}
                        <div>
                          <p className="mb-1 text-xs font-medium text-gray-500">Output</p>
                          <JsonBlock value={step.output} />
                        </div>
                      </div>

                      {step.logs && step.logs.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-medium text-gray-500">Logs</p>
                          <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
                            {step.logs.map((entry, j) => (
                              <div key={j} className={LOG_LEVEL_CLASS[entry.level] ?? 'text-gray-100'}>
                                <span className="text-gray-500">{entry.ts.slice(11, 23)}</span>{' '}
                                <span className="font-semibold">{entry.level}</span>{' '}
                                {entry.message}
                              </div>
                            ))}
                          </pre>
                        </div>
                      )}
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
