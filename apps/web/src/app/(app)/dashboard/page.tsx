'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { StatsResponse } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatDatetime } from '@/lib/dates'
import { AlertCircle, CheckCircle2, ArrowRight, Clock } from 'lucide-react'

type Window = 7 | 14 | 30

function fmt(ms: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function VolumeChart({ data }: { data: StatsResponse['by_day'] }) {
  const maxTotal = Math.max(...data.map((d) => d.total), 1)
  const H = 100
  const LABEL_H = 20
  const VW = 560
  const n = data.length
  const slotW = VW / n
  const barW = Math.max(slotW * 0.55, 2)

  return (
    <svg viewBox={`0 0 ${VW} ${H + LABEL_H}`} className="w-full" height={H + LABEL_H} preserveAspectRatio="none">
      {data.map((d, i) => {
        const x = i * slotW + (slotW - barW) / 2

        const completedH = (d.completed / maxTotal) * H
        const exitedH = (d.exited / maxTotal) * H
        const failedH = (d.failed / maxTotal) * H

        const completedY = H - completedH
        const exitedY = completedY - exitedH
        const failedY = exitedY - failedH

        const showLabel = i === 0 || i === n - 1 || n <= 7 || i % Math.ceil(n / 6) === 0
        const labelDate = new Date(d.date + 'T12:00:00Z')
        const label = labelDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

        return (
          <g key={d.date}>
            {d.total === 0 && (
              <rect x={x} y={H - 2} width={barW} height={2} fill="#f1f5f9" rx="1" />
            )}
            {d.completed > 0 && (
              <rect x={x} y={completedY} width={barW} height={completedH} fill="#818cf8" rx="1.5" />
            )}
            {d.exited > 0 && (
              <rect x={x} y={exitedY} width={barW} height={exitedH} fill="#cbd5e1" rx="1.5" />
            )}
            {d.failed > 0 && (
              <rect x={x} y={failedY} width={barW} height={failedH} fill="#fca5a5" rx="1.5" />
            )}
            {showLabel && (
              <text
                x={x + barW / 2}
                y={H + 14}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
                fontFamily="ui-sans-serif,system-ui,sans-serif"
              >
                {label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export default function DashboardPage() {
  const [window, setWindow] = useState<Window>(7)
  const [data, setData] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.stats.get(window)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [window])

  const s = data?.summary

  return (
    <NavLayout>
      <div className="p-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Dashboard</h1>
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-0.5">
            {([7, 14, 30] as Window[]).map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  window === w
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {loading ? (
            [...Array(4)].map((_, i) => (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
                <Skeleton className="mb-2 h-3 w-20" />
                <Skeleton className="h-8 w-16" />
              </div>
            ))
          ) : (
            <>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Total executions</p>
                <p className="mt-1.5 text-3xl font-bold text-gray-900">{s?.total ?? 0}</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Success rate</p>
                <p className={`mt-1.5 text-3xl font-bold ${
                  (s?.success_rate ?? 0) >= 95 ? 'text-green-600' :
                  (s?.success_rate ?? 0) >= 80 ? 'text-amber-500' : 'text-red-500'
                }`}>
                  {s?.total === 0 ? '—' : `${s?.success_rate ?? 0}%`}
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Avg duration</p>
                <p className="mt-1.5 text-3xl font-bold text-gray-900">{fmt(s?.avg_duration_ms ?? null)}</p>
                {s?.p95_duration_ms != null && (
                  <p className="mt-0.5 text-xs text-gray-400">p95 {fmt(s.p95_duration_ms)}</p>
                )}
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Failed</p>
                <p className={`mt-1.5 text-3xl font-bold ${(s?.failed ?? 0) > 0 ? 'text-red-500' : 'text-gray-900'}`}>
                  {s?.failed ?? 0}
                </p>
                {(s?.exited ?? 0) > 0 && (
                  <p className="mt-0.5 text-xs text-gray-400">{s?.exited} exited early</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Volume chart */}
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Execution volume</p>
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-indigo-400" />Completed</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-300" />Exited</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-300" />Failed</span>
            </div>
          </div>
          {loading ? (
            <Skeleton className="h-36 w-full rounded-lg" />
          ) : data && data.by_day.length > 0 ? (
            <VolumeChart data={data.by_day} />
          ) : (
            <div className="flex h-36 items-center justify-center text-sm text-gray-400">No executions in this window</div>
          )}
        </div>

        {/* Workflows + failures */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* By workflow */}
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-sm font-semibold text-gray-900">By workflow</p>
            </div>
            {loading ? (
              <div className="divide-y divide-gray-100">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="ml-auto h-4 w-10" />
                    <Skeleton className="h-4 w-10" />
                    <Skeleton className="h-4 w-14" />
                  </div>
                ))}
              </div>
            ) : !data || data.by_workflow.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">No executions in this window</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-5 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Workflow</th>
                    <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Runs</th>
                    <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Success</th>
                    <th className="px-5 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Avg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.by_workflow.map((wf) => (
                    <tr key={wf.workflow_id} className="hover:bg-gray-50">
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/workflows/${wf.workflow_id}`}
                          className="font-medium text-gray-900 hover:text-indigo-600"
                        >
                          {wf.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{wf.total}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={`font-medium ${
                          wf.success_rate >= 95 ? 'text-green-600' :
                          wf.success_rate >= 80 ? 'text-amber-500' : 'text-red-500'
                        }`}>
                          {wf.success_rate}%
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">{fmt(wf.avg_duration_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent failures */}
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-sm font-semibold text-gray-900">Recent failures</p>
            </div>
            {loading ? (
              <div className="divide-y divide-gray-100">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="px-5 py-3">
                    <Skeleton className="mb-1.5 h-4 w-36" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                ))}
              </div>
            ) : !data || data.recent_failures.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle2 className="mb-2 h-6 w-6 text-green-400" />
                <p className="text-sm font-medium text-gray-700">No failures</p>
                <p className="mt-0.5 text-xs text-gray-400">All executions completed successfully in this window.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {data.recent_failures.map((f) => (
                  <div key={f.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
                          <Link
                            href={`/workflows/${f.workflow_id}`}
                            className="truncate text-sm font-medium text-gray-900 hover:text-indigo-600"
                          >
                            {f.workflow_name}
                          </Link>
                          {f.source && (
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-500">
                              {f.source}
                            </span>
                          )}
                        </div>
                        {f.error_message && (
                          <p className="mt-0.5 truncate pl-5 text-xs text-gray-500">{f.error_message}</p>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1">
                        <span className="text-xs text-gray-400">{formatDatetime(f.started_at)}</span>
                        <Link
                          href={`/workflows/${f.workflow_id}/executions/${f.id}`}
                          className="flex items-center gap-0.5 text-xs text-indigo-500 hover:text-indigo-700"
                        >
                          View <ArrowRight className="h-3 w-3" />
                        </Link>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Slowest step types hint */}
        {!loading && data && data.by_partner.length > 0 && (
          <div className="mt-6 rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-sm font-semibold text-gray-900">Partner performance</p>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-5 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Partner</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Bids sent</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Accepted</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Win rate</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Avg bid</th>
                  <th className="px-5 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-400">Skipped</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.by_partner.map((p) => (
                  <tr key={p.slug} className="hover:bg-gray-50">
                    <td className="px-5 py-2.5">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <span className="ml-1.5 font-mono text-xs text-gray-400">{p.slug}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{p.bids_sent}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{p.accepted}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span className={`font-medium ${
                        p.win_rate >= 50 ? 'text-green-600' :
                        p.win_rate >= 25 ? 'text-amber-500' : 'text-red-500'
                      }`}>
                        {p.bids_sent === 0 ? '—' : `${p.win_rate}%`}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                      {p.avg_bid != null ? `$${p.avg_bid.toLocaleString()}` : '—'}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-gray-400">{p.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && data && data.summary.total > 0 && data.summary.p95_duration_ms != null && data.summary.p95_duration_ms > 5000 && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <Clock className="h-4 w-4 flex-shrink-0" />
            <span>p95 duration is over 5s. Check the execution detail view to identify slow steps.</span>
          </div>
        )}
      </div>
    </NavLayout>
  )
}
