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
  const n = data.length
  const CHART_H = 96

  const showLabelAt = (i: number) =>
    i === 0 || i === n - 1 || n <= 7 || i % Math.ceil(n / 6) === 0

  return (
    <div>
      <div className="relative" style={{ height: CHART_H }}>
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <div
            key={pct}
            className="absolute left-0 right-0 border-t border-gray-100"
            style={{ top: Math.round(CHART_H * (1 - pct)) }}
          />
        ))}
        <div className="absolute inset-0 flex items-end">
          {data.map((d) => {
            const completedH = (d.completed / maxTotal) * CHART_H
            const exitedH = (d.exited / maxTotal) * CHART_H
            const failedH = (d.failed / maxTotal) * CHART_H
            const totalH = completedH + exitedH + failedH

            return (
              <div key={d.date} className="flex flex-1 justify-center items-end h-full">
                {totalH > 0 ? (
                  <div
                    className="relative overflow-hidden rounded-t-[2px]"
                    style={{ width: 'clamp(3px, 42%, 14px)', height: Math.max(totalH, 2) }}
                  >
                    <div className="absolute bottom-0 left-0 right-0 bg-indigo-400" style={{ height: completedH }} />
                    {exitedH > 0 && (
                      <div className="absolute left-0 right-0 bg-slate-300" style={{ height: exitedH, bottom: completedH }} />
                    )}
                    {failedH > 0 && (
                      <div className="absolute left-0 right-0 bg-red-300" style={{ height: failedH, bottom: completedH + exitedH }} />
                    )}
                  </div>
                ) : (
                  <div className="rounded-sm bg-gray-100" style={{ width: 'clamp(3px, 42%, 14px)', height: 2 }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-2 flex">
        {data.map((d, i) => {
          const labelDate = new Date(d.date + 'T12:00:00Z')
          const label = labelDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return (
            <div key={d.date} className="flex-1 flex justify-center">
              {showLabelAt(i) && (
                <span className="text-[10px] leading-none text-gray-400">{label}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
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
          <h1 className="text-2xl font-semibold text-gray-900">Last {window} days</h1>
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

        {/* KPI section */}
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {loading ? (
            <>
              <div className="rounded-xl border border-gray-200 bg-white p-6 lg:col-span-2">
                <Skeleton className="mb-3 h-3 w-24" />
                <Skeleton className="mb-4 h-14 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
              <div className="grid grid-cols-2 gap-4 lg:flex lg:flex-col">
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-xl border border-gray-200 bg-white p-5">
                    <Skeleton className="mb-2 h-3 w-20" />
                    <Skeleton className="h-8 w-16" />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* Health card — dominant */}
              <div className={`rounded-xl border p-6 lg:col-span-2 ${
                !s || s.total === 0 ? 'border-gray-200 bg-white' :
                s.success_rate >= 95 ? 'border-green-100 bg-green-50' :
                s.success_rate >= 80 ? 'border-amber-100 bg-amber-50' :
                'border-red-100 bg-red-50'
              }`}>
                <div className="mb-3 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${
                    !s || s.total === 0 ? 'bg-gray-300' :
                    s.success_rate >= 95 ? 'bg-green-500' :
                    s.success_rate >= 80 ? 'bg-amber-400' :
                    'bg-red-500'
                  }`} />
                  <p className="text-xs text-gray-400">Success rate</p>
                </div>
                <p className={`text-5xl font-bold tabular-nums leading-none lg:text-6xl ${
                  !s || s.total === 0 ? 'text-gray-300' :
                  s.success_rate >= 95 ? 'text-green-600' :
                  s.success_rate >= 80 ? 'text-amber-500' :
                  'text-red-500'
                }`}>
                  {!s || s.total === 0 ? '—' : `${s.success_rate}%`}
                </p>
                {s && s.total > 0 && (
                  <p className="mt-3 text-sm text-gray-500">
                    {s.failed > 0 ? (
                      <>
                        <span className="font-medium text-red-600">{s.failed} failed</span>
                        {s.exited > 0 && <span>, {s.exited} exited early</span>}
                        {' — '}{s.total} total runs
                      </>
                    ) : s.exited > 0 ? (
                      <>{s.exited} exited early — {s.total} total runs</>
                    ) : (
                      <span className="text-green-700">All {s.total} runs completed</span>
                    )}
                  </p>
                )}
              </div>

              {/* Secondary stats */}
              <div className="grid grid-cols-2 gap-4 lg:flex lg:flex-col">
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <p className="text-xs text-gray-400">Total runs</p>
                  <p className="mt-1.5 text-3xl font-bold tabular-nums text-gray-900">{s?.total ?? 0}</p>
                </div>
                <div className={`rounded-xl border p-5 ${
                  s?.p95_duration_ms != null && s.p95_duration_ms > 5000
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-gray-200 bg-white'
                }`}>
                  <p className="text-xs text-gray-400">Avg duration</p>
                  <p className="mt-1.5 text-3xl font-bold text-gray-900">{fmt(s?.avg_duration_ms ?? null)}</p>
                  {s?.p95_duration_ms != null && (
                    <div className={`mt-1 flex items-center gap-1 text-xs ${
                      s.p95_duration_ms > 5000 ? 'text-amber-600' : 'text-gray-400'
                    }`}>
                      {s.p95_duration_ms > 5000 && <Clock className="h-3 w-3 flex-shrink-0" />}
                      <span>p95 {fmt(s.p95_duration_ms)}</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Volume chart */}
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-base font-semibold text-gray-900">Execution volume</p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
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
              <p className="text-base font-semibold text-gray-900">By workflow</p>
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
                    <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-500">Workflow</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Runs</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Success</th>
                    <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500">Avg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.by_workflow.map((wf) => (
                    <tr key={wf.workflow_id} className="hover:bg-gray-50">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${
                            wf.success_rate >= 95 ? 'bg-green-500' :
                            wf.success_rate >= 80 ? 'bg-amber-400' :
                            'bg-red-500'
                          }`} />
                          <Link
                            href={`/workflows/${wf.workflow_id}`}
                            className="font-medium text-gray-900 hover:text-indigo-600"
                          >
                            {wf.name}
                          </Link>
                        </div>
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
              <p className="text-base font-semibold text-gray-900">Recent failures</p>
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
              <p className="text-base font-semibold text-gray-900">Partner performance</p>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">Partner</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Bids sent</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Accepted</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Win rate</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Avg bid</th>
                  <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">Skipped</th>
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
          </div>
        )}

      </div>
    </NavLayout>
  )
}
