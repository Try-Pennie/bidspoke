'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { StatsResponse, ConfigWarningsResponse } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatDatetime } from '@/lib/dates'
import { AlertCircle, CheckCircle2, ArrowRight, AlertTriangle, TrendingDown } from 'lucide-react'

type Window = 7 | 14 | 30

function useCountUp(target: number | null, duration = 500): number | null {
  const [display, setDisplay] = useState<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const prevTargetRef = useRef<number>(0)

  useEffect(() => {
    if (target === null) {
      setDisplay(null)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      return
    }
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      setDisplay(target)
      prevTargetRef.current = target
      return
    }
    const from = prevTargetRef.current
    const start = performance.now()
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(Math.round(from + (target! - from) * eased))
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        prevTargetRef.current = target!
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [target, duration])

  return display
}

function fmt(ms: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtCost(usd: number | null | undefined) {
  if (usd == null || usd === 0) return '—'
  if (usd < 0.01) return `<$0.01`
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString()}`
}

type ChartTooltip = {
  date: string; completed: number; exited: number; failed: number; degraded: number; total: number; x: number
}

function VolumeChart({ data }: { data: StatsResponse['by_day'] }) {
  const maxTotal = Math.max(...data.map((d) => d.total), 1)
  const n = data.length
  const CHART_H = 112
  const TOOLTIP_W = 152
  const [tooltip, setTooltip] = useState<ChartTooltip | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const showLabelAt = (i: number) =>
    i === 0 || i === n - 1 || n <= 7 || i % Math.ceil(n / 6) === 0

  return (
    <div>
      <div ref={chartRef} className="relative" style={{ height: CHART_H }}>
        {/* Tooltip */}
        {tooltip && (() => {
          const w = chartRef.current?.offsetWidth ?? 600
          const left = Math.max(0, Math.min(tooltip.x - TOOLTIP_W / 2, w - TOOLTIP_W))
          const label = new Date(tooltip.date + 'T12:00:00Z')
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
          return (
            <div
              className="absolute top-1 z-10 pointer-events-none rounded-lg border border-gray-200 bg-white shadow-sm px-3 py-2.5 text-xs"
              style={{ left, width: TOOLTIP_W }}
            >
              <p className="mb-2 font-medium text-gray-600">{label}</p>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-gray-500">
                    <span className="h-2 w-2 flex-shrink-0 rounded-sm bg-p-blue-dark" />Completed
                  </span>
                  <span className="tabular-nums font-medium text-gray-700">{tooltip.completed}</span>
                </div>
                {tooltip.degraded > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-gray-500">
                      <span className="h-2 w-2 flex-shrink-0 rounded-sm bg-amber-400" />Degraded
                    </span>
                    <span className="tabular-nums font-medium text-amber-600">{tooltip.degraded}</span>
                  </div>
                )}
                {tooltip.exited > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-gray-500">
                      <span className="h-2 w-2 flex-shrink-0 rounded-sm bg-slate-400" />Exited
                    </span>
                    <span className="tabular-nums font-medium text-gray-700">{tooltip.exited}</span>
                  </div>
                )}
                {tooltip.failed > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-gray-500">
                      <span className="h-2 w-2 flex-shrink-0 rounded-sm bg-red-400" />Failed
                    </span>
                    <span className="tabular-nums font-medium text-red-600">{tooltip.failed}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-1.5 mt-1">
                  <span className="text-gray-500">Total</span>
                  <span className="tabular-nums font-semibold text-gray-700">{tooltip.total}</span>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <div
            key={pct}
            className="absolute left-0 right-0 border-t border-gray-100"
            style={{ top: Math.round(CHART_H * (1 - pct)) }}
          />
        ))}

        {/* Bars */}
        <div className="absolute inset-0 flex items-end">
          {data.map((d) => {
            const completedH = (d.completed / maxTotal) * CHART_H
            const degradedH = (d.degraded / maxTotal) * CHART_H
            const exitedH = (d.exited / maxTotal) * CHART_H
            const failedH = (d.failed / maxTotal) * CHART_H
            const totalH = completedH + degradedH + exitedH + failedH

            return (
              <div
                key={d.date}
                className="flex flex-1 justify-center items-end h-full cursor-default"
                onMouseEnter={(e) => {
                  if (!chartRef.current) return
                  const rect = chartRef.current.getBoundingClientRect()
                  const col = e.currentTarget.getBoundingClientRect()
                  setTooltip({
                    date: d.date, completed: d.completed, exited: d.exited,
                    failed: d.failed, degraded: d.degraded, total: d.total,
                    x: col.left + col.width / 2 - rect.left,
                  })
                }}
                onMouseLeave={() => setTooltip(null)}
              >
                {totalH > 0 ? (
                  <div
                    className="relative overflow-hidden rounded-t-[2px]"
                    style={{ width: 'clamp(3px, 42%, 14px)', height: Math.max(totalH, 2) }}
                  >
                    <div className="absolute bottom-0 left-0 right-0 bg-p-blue-dark" style={{ height: completedH }} />
                    {degradedH > 0 && (
                      <div className="absolute left-0 right-0 bg-amber-400" style={{ height: degradedH, bottom: completedH }} />
                    )}
                    {exitedH > 0 && (
                      <div className="absolute left-0 right-0 bg-slate-400" style={{ height: exitedH, bottom: completedH + degradedH }} />
                    )}
                    {failedH > 0 && (
                      <div className="absolute left-0 right-0 bg-red-400" style={{ height: failedH, bottom: completedH + degradedH + exitedH }} />
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

      {/* Date labels */}
      <div className="mt-2 flex">
        {data.map((d, i) => {
          const labelDate = new Date(d.date + 'T12:00:00Z')
          const label = labelDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return (
            <div key={d.date} className="flex-1 flex justify-center">
              {showLabelAt(i) && (
                <span className="text-[10px] leading-none text-gray-500">{label}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const [window, setWindow] = useState<Window>(7)
  const [data, setData] = useState<StatsResponse | null>(null)
  const [configWarnings, setConfigWarnings] = useState<ConfigWarningsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    function load(showSkeleton = false) {
      if (document.hidden) return
      if (showSkeleton) setLoading(true)
      setError(null)
      api.stats.get(window)
        .then((d) => { setData(d); setLastUpdated(new Date()) })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false))
      // Config warnings are workflow-config state, not windowed run stats, so
      // they load independently and a failure here never blocks the dashboard.
      api.configWarnings.get()
        .then(setConfigWarnings)
        .catch(() => {})
    }

    load(true)
    const interval = setInterval(load, 60_000)
    const onVisibility = () => load()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [window])

  const s = data?.summary
  const animatedRate = useCountUp(s?.success_rate ?? null)
  const animatedTotal = useCountUp(s?.total ?? null)
  const totalCost = data?.by_workflow.reduce((sum, wf) => sum + (wf.cost_usd ?? 0), 0) ?? 0

  return (
    <NavLayout>
      <div className="p-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
              <span className={`h-2 w-2 rounded-full ${
                loading || !s || s.total === 0 ? 'bg-gray-300' :
                s.success_rate >= 95 ? 'bg-green-500' :
                s.success_rate >= 80 ? 'bg-amber-400' :
                'bg-red-500'
              }`} />
              <h1 className="text-2xl font-semibold text-graphite">Last {window} days</h1>
            </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-gray-500">
                Updated {lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-0.5">
            {([7, 14, 30] as Window[]).map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  window === w
                    ? 'bg-p-blue-dark text-white'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
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
                <Skeleton className="mb-3 h-3 w-20" />
                <Skeleton className="mb-4 h-14 w-32" />
                <Skeleton className="h-4 w-52" />
              </div>
              <div className="grid grid-cols-3 gap-4 lg:flex lg:flex-col">
                {[0, 1, 2].map((i) => (
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
                <p className="mb-3 text-xs text-gray-500">Success rate</p>
                <p className={`text-5xl font-bold tabular-nums leading-none lg:text-6xl ${
                  !s || s.total === 0 ? 'text-gray-300' :
                  s.success_rate >= 95 ? 'text-green-600' :
                  s.success_rate >= 80 ? 'text-amber-500' :
                  'text-red-500'
                }`}>
                  {!s || s.total === 0 ? '—' : `${animatedRate ?? s.success_rate}%`}
                </p>
                {s && s.total > 0 && (
                  <p className="mt-3 text-sm text-gray-500">
                    {(() => {
                      const parts: React.ReactNode[] = []
                      if (s.failed > 0) parts.push(<span className="font-medium text-red-600">{s.failed} failed</span>)
                      if (s.degraded > 0) parts.push(<span className="font-medium text-amber-600">{s.degraded} degraded</span>)
                      if (s.exited > 0) parts.push(<span>{s.exited} exited early</span>)
                      if (parts.length === 0) return <span className="text-green-700">All {s.total} runs completed</span>
                      return (
                        <>
                          {s.total} runs:{' '}
                          {parts.map((p, i) => <span key={i}>{i > 0 ? ', ' : ''}{p}</span>)}
                        </>
                      )
                    })()}
                  </p>
                )}
              </div>

              {/* Secondary stats */}
              <div className="grid grid-cols-3 gap-4 lg:flex lg:flex-col">
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <p className="text-xs text-gray-500">Total runs</p>
                  <p className="mt-1.5 text-3xl font-bold tabular-nums text-graphite">{animatedTotal ?? s?.total ?? 0}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <p className="text-xs text-gray-500">Avg duration</p>
                  <p className="mt-1.5 text-3xl font-bold text-graphite">{fmt(s?.avg_duration_ms ?? null)}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <p className="text-xs text-gray-500">Est. cost</p>
                  <p className="mt-1.5 text-3xl font-bold tabular-nums text-graphite">{fmtCost(totalCost)}</p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Volume chart */}
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-base font-semibold text-graphite">Execution volume</p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-p-blue-dark" />Completed</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" />Degraded</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-400" />Exited</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-400" />Failed</span>
            </div>
          </div>
          {loading ? (
            <Skeleton className="h-36 w-full rounded-lg" />
          ) : data && data.by_day.length > 0 ? (
            <VolumeChart data={data.by_day} />
          ) : (
            <div className="flex h-36 items-center justify-center text-sm text-gray-500">No executions in this window</div>
          )}
        </div>

        {/* Workflows + failures */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* By workflow */}
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-base font-semibold text-graphite">By workflow</p>
            </div>
            {loading ? (
              <div className="divide-y divide-gray-100">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="ml-auto h-4 w-10" />
                    <Skeleton className="h-4 w-10" />
                    <Skeleton className="h-4 w-14" />
                    <Skeleton className="h-4 w-14" />
                  </div>
                ))}
              </div>
            ) : !data || data.by_workflow.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle2 className="mb-2 h-6 w-6 text-gray-300" />
                <p className="text-sm font-medium text-gray-700">No executions</p>
                <p className="mt-0.5 text-xs text-gray-500">Try a longer window to see historical data.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-beige">
                  <tr>
                    <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-500">Workflow</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Runs</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Completed</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Successful</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Degraded</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500">Failed</th>
                    <th className="px-5 py-2.5 text-right text-xs font-semibold text-gray-500">Est. cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.by_workflow.map((wf) => {
                    const outcomeCompleted = Math.max(0, (wf.completed ?? 0) - (wf.successful ?? 0))
                    return (
                      <tr key={wf.workflow_id} className="hover:bg-beige">
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 flex-shrink-0 rounded-full ${
                              wf.success_rate == null ? 'bg-gray-300' :
                              wf.success_rate >= 95 ? 'bg-green-500' :
                              wf.success_rate >= 80 ? 'bg-amber-400' :
                              'bg-red-500'
                            }`} />
                            <Link
                              href={`/workflows/${wf.workflow_id}`}
                              className="font-medium text-graphite hover:text-p-blue-dark"
                            >
                              {wf.name}
                            </Link>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                          <div>{wf.total || '—'}</div>
                          {wf.total > 0 && (
                            <div className="text-xs text-gray-500">{fmt(wf.avg_duration_ms)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                          <div>{outcomeCompleted || '—'}</div>
                          {outcomeCompleted > 0 && (
                            <div className="text-xs text-gray-500">{fmt(wf.avg_duration_completed_ms)}</div>
                          )}
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${wf.successful ? 'text-green-600' : 'text-gray-500'}`}>
                          <div>{wf.successful || '—'}</div>
                          {wf.successful > 0 && (
                            <div className="text-xs text-gray-500">{fmt(wf.avg_duration_successful_ms)}</div>
                          )}
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${wf.degraded ? 'text-amber-600' : 'text-gray-500'}`}>
                          <div>{wf.degraded || '—'}</div>
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${wf.failed ? 'text-red-500' : 'text-gray-500'}`}>
                          <div>{wf.failed || '—'}</div>
                          {wf.failed > 0 && (
                            <div className="text-xs text-gray-500">{fmt(wf.avg_duration_failed_ms)}</div>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">{fmtCost(wf.cost_usd)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent failures */}
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-base font-semibold text-graphite">Recent failures</p>
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
                <p className="mt-0.5 text-xs text-gray-500">All executions completed successfully in this window.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {data.recent_failures.map((f) => (
                  <div
                    key={f.id}
                    role="link"
                    tabIndex={0}
                    onClick={() => router.push(`/workflows/${f.workflow_id}?execution=${f.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        router.push(`/workflows/${f.workflow_id}?execution=${f.id}`)
                      }
                    }}
                    className="cursor-pointer px-5 py-3 transition-colors hover:bg-beige focus:bg-beige focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-p-blue-dark"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
                          <span className="truncate text-sm font-medium text-graphite">
                            {f.workflow_name}
                          </span>
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
                        <span className="text-xs text-gray-500">{formatDatetime(f.started_at)}</span>
                        <Link
                          href={`/workflows/${f.workflow_id}/executions/${f.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-0.5 text-xs text-p-blue-dark hover:text-p-blue-dark"
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

        {configWarnings && configWarnings.workflows.length > 0 && (
          <div className="mt-6 rounded-xl border border-red-200 bg-white">
            <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-5 py-3">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-500" />
              <p className="text-base font-semibold text-graphite">Configuration warnings</p>
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                {configWarnings.workflows.reduce((n, w) => n + w.nodes.length, 0)}
              </span>
            </div>
            <div className="px-5 py-3">
              <p className="mb-3 text-xs text-gray-500">
                These steps have a timeout set below the minimum that reliably works for their node type. On a cold run
                the step exceeds it before the work starts, so it times out and fails on every retry. Open the workflow
                and raise each timeout to at least the listed minimum.
              </p>
              <div className="divide-y divide-gray-100">
                {configWarnings.workflows.map((w) => (
                  <div key={w.workflow_id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-graphite">{w.workflow_name}</span>
                      <Link
                        href={`/workflows/${w.workflow_id}?node=${w.nodes[0].node_id}`}
                        className="flex flex-shrink-0 items-center gap-0.5 text-xs text-p-blue-dark hover:text-p-blue-dark"
                      >
                        Open <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                    <ul className="space-y-0.5">
                      {w.nodes.map((n) => (
                        <li key={n.node_id}>
                          <Link
                            href={`/workflows/${w.workflow_id}?node=${n.node_id}`}
                            className="-mx-1 flex items-baseline gap-2 rounded px-2 py-0.5 text-xs hover:bg-gray-50"
                            title="Open this node on the canvas"
                          >
                            <span className="truncate font-mono text-gray-600">{n.label || n.namespace}</span>
                            <span className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] text-gray-500">{n.type}</span>
                            <span className="flex-shrink-0 text-gray-500">
                              set to {n.configured_ms}ms, needs at least {n.floor_ms}ms
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {configWarnings && configWarnings.under_provisioned?.length > 0 && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-white">
            <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-3">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500" />
              <p className="text-base font-semibold text-graphite">Timeouts below suggested</p>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {configWarnings.under_provisioned.reduce((n, w) => n + w.nodes.length, 0)}
              </span>
            </div>
            <div className="px-5 py-3">
              <p className="mb-3 text-xs text-gray-500">
                These steps have a timeout below what their recent runs need. Slower-than-typical runs hit the timeout
                and burn retries; values below p99 mean most runs time out in practice. The suggested value is p99 with
                headroom from recent history.
              </p>
              <div className="divide-y divide-gray-100">
                {configWarnings.under_provisioned.map((w) => (
                  <div key={w.workflow_id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-graphite">{w.workflow_name}</span>
                      <Link
                        href={`/workflows/${w.workflow_id}?node=${w.nodes[0].node_id}`}
                        className="flex flex-shrink-0 items-center gap-0.5 text-xs text-p-blue-dark hover:text-p-blue-dark"
                      >
                        Open <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                    <ul className="space-y-0.5">
                      {w.nodes.map((n) => (
                        <li key={n.node_id}>
                          <Link
                            href={`/workflows/${w.workflow_id}?node=${n.node_id}`}
                            className="-mx-1 flex items-baseline gap-2 rounded px-2 py-0.5 text-xs hover:bg-gray-50"
                            title="Open this node on the canvas"
                          >
                            <span className="truncate font-mono text-gray-600">{n.label || n.namespace}</span>
                            <span className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] text-gray-500">{n.type}</span>
                            {n.severity === 'red' && (
                              <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700">most runs time out</span>
                            )}
                            <span className="flex-shrink-0 text-gray-500">
                              set to {n.configured_ms.toLocaleString()}ms, suggested {n.suggested_ms.toLocaleString()}ms (p99 {n.p99_ms.toLocaleString()}ms over {n.sample_size.toLocaleString()} runs)
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {configWarnings && configWarnings.over_provisioned?.length > 0 && (
          <div className="mt-6 rounded-xl border border-amber-200 bg-white">
            <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-3">
              <TrendingDown className="h-4 w-4 flex-shrink-0 text-amber-500" />
              <p className="text-base font-semibold text-graphite">Timeouts that could be lower</p>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {configWarnings.over_provisioned.reduce((n, w) => n + w.nodes.length, 0)}
              </span>
            </div>
            <div className="px-5 py-3">
              <p className="mb-3 text-xs text-gray-500">
                These steps have a timeout set far above what their recent runs need. Not a failure risk, but a tighter
                timeout means a stuck call fails fast instead of hanging. The suggested value is p99 with headroom over
                the last 7 days. Lowering is optional.
              </p>
              <div className="divide-y divide-gray-100">
                {configWarnings.over_provisioned.map((w) => (
                  <div key={w.workflow_id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-graphite">{w.workflow_name}</span>
                      <Link
                        href={`/workflows/${w.workflow_id}?node=${w.nodes[0].node_id}`}
                        className="flex flex-shrink-0 items-center gap-0.5 text-xs text-p-blue-dark hover:text-p-blue-dark"
                      >
                        Open <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                    <ul className="space-y-0.5">
                      {w.nodes.map((n) => (
                        <li key={n.node_id}>
                          <Link
                            href={`/workflows/${w.workflow_id}?node=${n.node_id}`}
                            className="-mx-1 flex items-baseline gap-2 rounded px-2 py-0.5 text-xs hover:bg-gray-50"
                            title="Open this node on the canvas"
                          >
                            <span className="truncate font-mono text-gray-600">{n.label || n.namespace}</span>
                            <span className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] text-gray-500">{n.type}</span>
                            <span className="flex-shrink-0 text-gray-500">
                              set to {n.configured_ms}ms, suggested ~{n.suggested_ms}ms (p99 {n.p99_ms}ms over {n.sample_size} runs)
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </NavLayout>
  )
}
