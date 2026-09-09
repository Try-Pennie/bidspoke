'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { ArrowLeft, LayoutTemplate, CheckCircle, RefreshCw, Copy, Check, AlertTriangle, ChevronRight } from 'lucide-react'
import { formatDatetime, formatLogTime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'
import { ExecutionNotFoundNotice } from '@/components/ExecutionNotFoundNotice'
import { ExpandableError } from '@/components/ExpandableError'
import { BackToTop } from '@/components/BackToTop'
import { useExecution } from '@/hooks/useExecution'
import { LeadMargin } from './LeadMargin'
import { STATUS_STYLES, ExecutionStatusBadge } from '@/components/ExecutionStatusBadge'

type Execution = Awaited<ReturnType<typeof api.executions.get>>
type Step = Execution['steps'][number]

interface BidGroupOutputShape {
  winner: { partner: string; bid: number } | null
  all_bids?: PartnerBidOutputShape[]
  mode?: string
  reason?: string
  _route?: 'winner' | 'no_winner'
}

type BidOutcome = 'won' | 'outbid' | 'declined' | 'skipped' | 'error'

interface PartnerBidOutputShape {
  partner: string
  bid: number | null
  accepted: boolean
  skipped: boolean
  skip_reason?: string
  cap_count?: number
  resolver_type?: 'formula' | 'api' | 'matrix' | null
  status?: number | null
  /** Legacy key for executions persisted before the 2026-06-11 output rename
   *  (status used to be http_status). Removable once pre-rename executions
   *  age out of the 90-day retention window. */
  http_status?: number | null
  response_headers?: Record<string, string> | null
  raw_response?: unknown
  outcome?: BidOutcome
  outcome_reason?: string
  error?: string
  error_type?: 'transient' | 'permanent' | null
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
  debug: 'text-gray-500',
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.unknown
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

type AlertReason = NonNullable<Execution['slack_alert_reason']>

function AlertTldr({
  type,
  reason,
  durationMs,
}: {
  type: 'failure' | 'duration'
  reason: AlertReason
  durationMs: number | null
}) {
  // Severity colour: red for failure, amber for duration. Border + background only —
  // mirrors the existing error callout pattern further down the page.
  const styles = type === 'failure'
    ? { border: 'border-red-200', bg: 'bg-red-50', label: 'text-red-700', body: 'text-red-900', title: 'Failure alert' }
    : { border: 'border-amber-200', bg: 'bg-amber-50', label: 'text-amber-700', body: 'text-amber-900', title: 'Slow execution alert' }

  // Structured one-liner — always renders, even before Claude fills in .summary.
  const headline = (() => {
    if (type === 'duration') {
      const tookS = durationMs !== null ? formatDuration(durationMs) : '?'
      const thresholdS = reason.threshold_ms ? `${(reason.threshold_ms / 1000).toFixed(0)}s` : '?'
      const stepS = formatDuration(reason.step_duration_ms)
      const pct = durationMs && durationMs > 0 ? Math.round((reason.step_duration_ms / durationMs) * 100) : null
      return (
        <>
          Took <strong>{tookS}</strong>, exceeded the <strong>{thresholdS}</strong> threshold. Bottleneck:{' '}
          <code className="rounded bg-white/60 px-1 py-0.5 font-mono text-xs">{reason.step_namespace}</code>{' '}
          ({stepS}{pct !== null ? `, ${pct}% of total` : ''}).
        </>
      )
    }
    const errLabel = reason.error_type === 'transient' ? 'transient' : 'permanent'
    return (
      <>
        Step{' '}
        <code className="rounded bg-white/60 px-1 py-0.5 font-mono text-xs">{reason.step_namespace}</code>{' '}
        failed with a <strong>{errLabel}</strong> error.
      </>
    )
  })()

  return (
    <div className={`rounded-xl border ${styles.border} ${styles.bg} p-4`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${styles.label}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold uppercase tracking-wide ${styles.label}`}>{styles.title}</p>
          <p className={`mt-1 text-sm ${styles.body}`}>{headline}</p>
          {reason.summary ? (
            <p className={`mt-2 text-sm ${styles.body}`}>{reason.summary}</p>
          ) : (
            <p className={`mt-2 text-xs italic ${styles.label}`}>Summary generating…</p>
          )}
          {type === 'failure' && reason.error_message && (
            <pre className={`mt-2 whitespace-pre-wrap rounded bg-white/60 p-2 font-mono text-xs ${styles.body}`}>
              {reason.error_message}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
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
  // outcome stamp from bid-group is the authoritative source; outcome_reason
  // is the engine-generated human-readable why. Fall back to the pre-outcome
  // heuristic only for legacy executions that pre-date these fields.
  if (attempt.outcome === 'won') {
    return { result: 'Won', tone: 'green', why: attempt.outcome_reason ?? '' }
  }
  if (attempt.outcome === 'outbid') {
    return { result: 'Outbid', tone: 'gray', why: attempt.outcome_reason ?? 'Lost on amount' }
  }
  if (attempt.outcome === 'error') {
    const msg = attempt.outcome_reason ?? attempt.error ?? 'Partner errored'
    // Timeout is a transient error type; show that explicitly so it doesn't
    // look like an API/auth failure.
    const isTimeout = /within \d+ms|timed? ?out/i.test(msg)
    return { result: isTimeout ? 'Timed out' : 'Errored', tone: 'red', why: msg }
  }
  if (attempt.outcome === 'declined') {
    return { result: 'Rejected', tone: 'red', why: attempt.outcome_reason ?? 'Partner declined' }
  }
  if (attempt.outcome === 'skipped') {
    return { result: 'Skipped', tone: 'gray', why: attempt.outcome_reason ?? '' }
  }
  if (attempt.accepted && attempt.outcome === undefined) {
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

function readOutboundBody(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  if ('resolved' in v && v.resolved && typeof v.resolved === 'object') {
    const r = v.resolved as Record<string, unknown>
    if ('outbound_body' in r) return r.outbound_body
  }
  if ('outbound_body' in v) return v.outbound_body
  return null
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const output = (groupStep.output ?? {}) as BidGroupOutputShape
  const noWinner = output._route === 'no_winner' || !output.winner
  const reason = output.reason ?? 'unknown'
  const mode = output.mode ?? '—'

  // Build {attempt, step?} pairs so we can read raw_response/headers from the
  // attempt JSON and duration/input from the per-partner step row when present.
  // attemptSteps carry per-partner timing and step status; the bid_group's
  // all_bids array is the fallback when step rows aren't recorded (e.g. old runs).
  const pairs: Array<{ attempt: PartnerBidOutputShape; step?: Step }> = attemptSteps.length > 0
    ? attemptSteps.map((s) => ({
        attempt: (s.output as PartnerBidOutputShape) ?? { partner: s.step_namespace, bid: null, accepted: false, skipped: false },
        step: s,
      }))
    : (output.all_bids ?? []).map((a) => ({ attempt: a }))

  const winnerSlug = output.winner?.partner

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

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
            ? <span className="font-medium text-red-700">No winner: {reason.replace(/_/g, ' ')}</span>
            : <span className="font-medium text-green-700">Winner: {winnerSlug} (${output.winner?.bid ?? 0})</span>}
        </div>
      </div>

      {pairs.length === 0 ? (
        <p className="text-xs text-gray-500">No partner attempts recorded.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="w-6 px-2 py-2"></th>
                <th className="px-3 py-2 font-medium">Partner</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 text-right font-medium">Bid</th>
                <th className="px-3 py-2 font-medium">Why</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pairs.map(({ attempt: a, step }, i) => {
                const d = describeAttempt(a)
                const isWinner = a.outcome === 'won' || (a.partner === winnerSlug && a.accepted)
                const isOpen = expanded.has(i)
                return (
                  <BidAttemptRow
                    key={`${a.partner}-${i}`}
                    index={i}
                    attempt={a}
                    step={step}
                    describe={d}
                    isWinner={isWinner}
                    isOpen={isOpen}
                    onToggle={() => toggle(i)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BidAttemptRow({
  index,
  attempt,
  step,
  describe,
  isWinner,
  isOpen,
  onToggle,
}: {
  index: number
  attempt: PartnerBidOutputShape
  step?: Step
  describe: { result: string; tone: 'green' | 'gray' | 'red' | 'amber'; why: string }
  isWinner: boolean
  isOpen: boolean
  onToggle: () => void
}) {
  // step.input carries { template, resolved } where resolved.outbound_body is
  // the JSON we sent over the wire. raw_response on the attempt is the parsed
  // response. status/response_headers were added to PartnerBidOutput so
  // they ride along on the attempt too.
  const outboundBody = step ? readOutboundBody(step.input) : null
  const duration = step?.duration_ms ?? null
  const httpStatus = attempt.status ?? attempt.http_status ?? null
  const headers = attempt.response_headers ?? null
  const rawResponse = attempt.raw_response ?? null
  // The detail row is what the toggle controls, so it needs an id to point at.
  const detailId = `bid-attempt-${index}-detail`

  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-gray-50 ${isWinner ? 'bg-green-50/40 hover:bg-green-50/60' : ''}`}
        onClick={onToggle}
      >
        <td className="w-6 px-2 py-2 text-gray-500">
          {/*
            A real button, not a decorative chevron (#497). The row keeps its own
            onClick so a mouse user can still hit anywhere, which is exactly why
            this one has to stop propagation: without that, a click here would
            toggle twice and look like nothing happened at all.
          */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            aria-expanded={isOpen}
            aria-controls={detailId}
            aria-label={`Details for ${attempt.partner}`}
            className="flex items-center rounded text-gray-500 hover:text-graphite focus:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-graphite">{attempt.partner}</td>
        <td className="px-3 py-2 text-gray-600">{describeMode(attempt)}</td>
        <td className="px-3 py-2"><ToneBadge tone={isWinner ? 'green' : describe.tone}>{isWinner ? 'Won' : describe.result}</ToneBadge></td>
        <td className="px-3 py-2 text-right font-mono text-graphite">{attempt.bid !== null ? `$${attempt.bid}` : '—'}</td>
        <td className="px-3 py-2 text-gray-600">{describe.why || (isWinner ? '' : '—')}</td>
        <td className="px-3 py-2 text-right font-mono text-gray-500">{formatDuration(duration)}</td>
      </tr>
      {isOpen && (
        <tr id={detailId} className={isWinner ? 'bg-green-50/20' : 'bg-gray-50/60'}>
          <td colSpan={7} className="px-3 py-3">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <div>
                  <span className="text-gray-500">HTTP status:</span>{' '}
                  <span className="font-mono text-graphite">{httpStatus !== null ? httpStatus : '—'}</span>
                </div>
                <div>
                  <span className="text-gray-500">Duration:</span>{' '}
                  <span className="font-mono text-graphite">{formatDuration(duration)}</span>
                </div>
                <div>
                  <span className="text-gray-500">Resolver:</span>{' '}
                  <span className="font-mono text-graphite">{attempt.resolver_type ?? '—'}</span>
                </div>
                {attempt.outcome && (
                  <div>
                    <span className="text-gray-500">Outcome:</span>{' '}
                    <span className="font-mono text-graphite">{attempt.outcome}</span>
                  </div>
                )}
              </div>

              {attempt.outcome_reason && (
                <p className="text-xs text-gray-700">
                  <span className="text-gray-500">Why: </span>
                  {attempt.outcome_reason}
                </p>
              )}

              {attempt.error && (
                <div className="rounded border border-red-200 bg-red-50 p-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-red-600">
                    Error{attempt.error_type ? ` · ${attempt.error_type}` : ''}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-red-800">{attempt.error}</p>
                </div>
              )}

              {headers && Object.keys(headers).length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">Response headers</p>
                  <pre className="overflow-auto rounded bg-white p-2 text-[11px] text-gray-700 ring-1 ring-gray-200">
                    {Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </pre>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">Request body sent</p>
                  {outboundBody === null
                    ? <p className="rounded bg-white p-2 text-[11px] italic text-gray-500 ring-1 ring-gray-200">Not recorded</p>
                    : <JsonBlock value={outboundBody} />}
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">Raw response</p>
                  {rawResponse === null
                    ? <p className="rounded bg-white p-2 text-[11px] italic text-gray-500 ring-1 ring-gray-200">Not recorded</p>
                    : <JsonBlock value={rawResponse} />}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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
  if (value === null || value === undefined) return <span className="text-gray-500 italic">null</span>
  // No height cap — let the block grow with the JSON so reads don't require an
  // inner scroll. Huge payloads still get a soft cap via max-h-[80vh] so they
  // don't blow out the page; horizontal overflow stays scrollable.
  return (
    <pre className="overflow-auto rounded bg-gray-50 p-3 text-xs text-gray-700 max-h-[80vh]">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

// Renders the {template, resolved} input shape side-by-side when present;
// falls back to a single JsonBlock for legacy rows.
function StepInputBlock({ value }: { value: unknown }) {
  if (
    typeof value === 'object'
    && value !== null
    && 'template' in value
    && 'resolved' in value
  ) {
    const v = value as { template: unknown; resolved: unknown }
    return (
      <div className="space-y-2">
        <div>
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">Template</p>
          <JsonBlock value={v.template} />
        </div>
        <div>
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">Resolved</p>
          <JsonBlock value={v.resolved} />
        </div>
      </div>
    )
  }
  return <JsonBlock value={value} />
}

export default function ExecutionDetailPage() {
  const params = useParams()
  const workflowId = params.id as string
  const executionId = params.executionId as string

  const { execution, loading, error, notFound } = useExecution(executionId)
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

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={`/workflows/${workflowId}?execution=${executionId}`}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-graphite"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to workflow
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={copyReport}
              disabled={!execution}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy report'}
            </button>
            <Link
              href={`/workflows/${workflowId}?execution=${executionId}`}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige"
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
              View on canvas
            </Link>
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

        {error && (notFound ? (
          <ExecutionNotFoundNotice
            executionId={executionId}
            action={
              // inline-block is load-bearing: this is a bordered pill with vertical
              // padding sitting in a plain block div, and an anchor is inline by
              // default, so without it the padding would stop expanding the box.
              <Link
                href={`/workflows/${workflowId}`}
                className="inline-block rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige"
              >
                Back to the workflow
              </Link>
            }
          />
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ))}

        {execution && (
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-3xl font-bold text-graphite">Execution detail</h1>
                <p className="mt-1 font-mono text-xs text-gray-500">{execution.id}</p>
              </div>
              <ExecutionStatusBadge status={execution.status} startedAt={execution.started_at} />
            </div>

            {/* Degraded explainer — the lead was served, but a post-response writeback failed (#310) */}
            {execution.status === 'degraded' && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Degraded</p>
                    <p className="mt-1 text-sm text-amber-900">
                      The lead was served a correct response, but a post-response writeback (e.g. the Salesforce
                      patch) failed and was dead-lettered for retry. This run is not a failure. Check the steps below
                      for the writeback error.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Alert TLDR — only shown when this execution triggered a Slack alert */}
            {execution.slack_alert_type && execution.slack_alert_reason && (
              <AlertTldr
                type={execution.slack_alert_type}
                reason={execution.slack_alert_reason}
                durationMs={execution.duration_ms}
              />
            )}

            {/* Replay lineage */}
            {(execution.parent_execution_id || (execution.child_executions?.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-beige px-4 py-3 text-xs text-gray-600">
                {execution.parent_execution_id && (
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-gray-500" />
                    <span>Replay of</span>
                    <Link
                      href={`/workflows/${workflowId}/executions/${execution.parent_execution_id}`}
                      className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                    >
                      {execution.parent_execution_id.slice(0, 8)}…
                    </Link>
                  </span>
                )}
                {(execution.child_executions?.length ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-gray-500" />
                    <span>{execution.child_executions.length === 1 ? 'Replayed once:' : `Replayed ${execution.child_executions.length} times:`}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {execution.child_executions.map((c) => (
                        <Link
                          key={c.id}
                          href={`/workflows/${workflowId}/executions/${c.id}`}
                          className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                        >
                          {c.id.slice(0, 8)}…
                        </Link>
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
                <ExpandableError text={execution.error_message} className="font-mono text-sm text-red-800" />
              </div>
            )}

            {/* Trigger payload */}
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Trigger payload</h2>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <JsonBlock value={execution.trigger_payload} />
              </div>
            </div>

            {/* What the lead earned: the buyer's bid beside the rate we quoted
                its source, and the difference (#1160). Placed above the bid
                attempts because it is the outcome those attempts produced, and
                it renders for code node bidding flows too, which have no bid
                group step at all. */}
            <LeadMargin economics={execution.lead_economics ?? null} />

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
                <p className="text-sm text-gray-500">No steps recorded.</p>
              ) : (() => {
                const visibleSteps = execution.steps.filter(
                  (step) => step.step_type !== 'branch_end' && step.step_type !== 'parallel_end'
                )
                const runStartMs = new Date(execution.started_at).getTime()
                // Waterfall scale: prefer the execution's total duration; fall back to the
                // latest step completion for in-progress runs. Offsets are wall-clock from
                // the trigger, so parallel steps render with overlapping bars (correct).
                const latestEndMs = visibleSteps.reduce((max, s) => {
                  if (!s.completed_at) return max
                  return Math.max(max, new Date(s.completed_at).getTime() - runStartMs)
                }, 0)
                const totalSpanMs = Math.max(1, execution.duration_ms ?? latestEndMs)
                return (
                <div className="space-y-3">
                  {visibleSteps.map((step, i) => {
                    // Steps inherited from a prior run (resumes) predate this execution's
                    // start, so elapsed-from-trigger and the waterfall don't apply to them.
                    const startedAtMs = new Date(step.started_at).getTime()
                    const isPreRun = startedAtMs < runStartMs
                    const startOffsetMs = Math.max(0, startedAtMs - runStartMs)
                    const elapsedMs = !isPreRun && step.completed_at
                      ? new Date(step.completed_at).getTime() - runStartMs
                      : null
                    const barLeftPct = (startOffsetMs / totalSpanMs) * 100
                    const barWidthPct = Math.max(0.5, ((step.duration_ms ?? 0) / totalSpanMs) * 100)
                    return (
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
                            <p className="text-xs text-gray-500">
                              {step.step_type} · {formatDuration(step.duration_ms)}
                              {elapsedMs !== null && (
                                <>
                                  {' · '}
                                  <span className="text-gray-500" title="Elapsed from trigger to this step's completion">
                                    +{formatDuration(elapsedMs)} from trigger
                                  </span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        <StatusBadge status={step.status} />
                      </div>

                      {/* Waterfall: where this step sits within the whole run */}
                      {!isPreRun && (
                        <div
                          className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-100"
                          title={`Starts at +${formatDuration(startOffsetMs)}, runs for ${formatDuration(step.duration_ms)}`}
                        >
                          <div
                            className={`h-full rounded-full ${step.status === 'failed' ? 'bg-red-400' : 'bg-gray-400'}`}
                            style={{ marginLeft: `${barLeftPct}%`, width: `${barWidthPct}%` }}
                          />
                        </div>
                      )}

                      {step.error_message && (
                        <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                          <ExpandableError text={step.error_message} className="font-mono text-xs text-red-700" />
                          {step.error_type && (
                            <p className="mt-0.5 text-xs text-red-400">{step.error_type} error{step.retries_used > 0 ? ` · ${step.retries_used} retr${step.retries_used === 1 ? 'y' : 'ies'}` : ''}</p>
                          )}
                        </div>
                      )}

                      <div className={`grid gap-3 ${step.input !== null ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        {step.input !== null && (
                          <div>
                            <p className="mb-1 text-xs font-medium text-gray-500">Input</p>
                            <StepInputBlock value={step.input} />
                          </div>
                        )}
                        <div>
                          <p className="mb-1 text-xs font-medium text-gray-500">Output</p>
                          <JsonBlock value={step.output} />
                        </div>
                      </div>

                      {step.logs && step.logs.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-medium text-gray-500">Logs <span className="font-normal text-gray-500">(ET)</span></p>
                          <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
                            {step.logs.map((entry, j) => (
                              <div key={j} className={LOG_LEVEL_CLASS[entry.level] ?? 'text-gray-100'}>
                                <span className="text-gray-500">{formatLogTime(entry.ts)}</span>{' '}
                                <span className="font-semibold">{entry.level}</span>{' '}
                                {entry.message}
                              </div>
                            ))}
                          </pre>
                        </div>
                      )}
                    </div>
                    )
                  })}
                </div>
                )
              })()}
            </div>

          </div>
        )}
      </div>
      <BackToTop />
    </NavLayout>
  )
}
