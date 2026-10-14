'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { Incident, IncidentsResponse } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button, Outcome } from '@/components/ui/form'
import { emptyIncidentsText, groupIncidentsByDay, durationColumnText, incidentTimeRange, signalText, slackPagesText } from '@/lib/incidents'

type Days = 7 | 14 | 30

type FirstPage =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; incidents: Incident[]; nextOffset: number | null; pages: number }

type More = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; message: string }

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'The request failed.')

function IncidentRow({ incident }: { incident: Incident }) {
  return (
    <li className="grid grid-cols-[170px_190px_1fr_210px_110px] items-baseline gap-3 border-t border-gray-100 px-5 py-2.5 text-sm first:border-t-0">
      <span className="tabular-nums text-gray-600">{incidentTimeRange(incident)}</span>
      <span className="font-medium text-graphite">{signalText(incident)}</span>
      <span className="min-w-0 text-gray-600">{incident.subject_name}</span>
      <span className="text-gray-600">{durationColumnText(incident)}</span>
      <span className="text-right text-xs text-gray-600">{slackPagesText(incident.pages_sent)}</span>
    </li>
  )
}

/**
 * The Incidents card (#2101), at the bottom of the dashboard as settled with Dan
 * on 2026-10-14 (docs/design/incidents-card.html): the incidents that closed in
 * the page's window, grouped by ET day. Open incidents are the line under the
 * page header instead (OngoingIncidents), so each is stated once.
 */
export function IncidentsSection({
  days,
  load = api.incidents.list,
  now = Date.now,
  refreshKey = 0,
  hasOngoing = false,
}: {
  days: Days
  load?: (days: Days, offset: number) => Promise<IncidentsResponse>
  now?: () => number
  /** Changes whenever the page refreshes, so the card refreshes with it. */
  refreshKey?: number
  /** Whether an ongoing incident is shown above, so an empty card says "other". */
  hasOngoing?: boolean
}) {
  const [first, setFirst] = useState<FirstPage>({ kind: 'loading' })
  const [more, setMore] = useState<More>({ kind: 'idle' })
  const alive = useRef(true)
  // Each first page read starts a new generation; an answer from an older one (a
  // window switched, or a refresh overlapping it) is dropped, never shown.
  const generation = useRef(0)
  // The current state, for a refresh to decide whether replacing the list would
  // throw away pages somebody asked for.
  const firstRef = useRef(first)
  firstRef.current = first

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadFirst = useCallback((quiet: boolean) => {
    const mine = ++generation.current
    const current = () => alive.current && generation.current === mine
    if (!quiet) setFirst({ kind: 'loading' })
    setMore({ kind: 'idle' })
    load(days, 0).then(
      (res) => { if (current()) setFirst({ kind: 'loaded', incidents: res.incidents, nextOffset: res.has_more ? res.next_offset : null, pages: 1 }) },
      (e) => { if (current()) setFirst({ kind: 'failed', message: messageOf(e) }) },
    )
  }, [load, days])

  useEffect(() => { loadFirst(false) }, [loadFirst])

  // A page refresh refreshes the first page in place, unless more pages are open.
  const lastRefresh = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey === lastRefresh.current) return
    lastRefresh.current = refreshKey
    const current = firstRef.current
    if (current.kind === 'loaded' && current.pages > 1) return
    loadFirst(current.kind === 'loaded')
  }, [refreshKey, loadFirst])

  function loadMore() {
    if (first.kind !== 'loaded' || first.nextOffset === null) return
    const offset = first.nextOffset
    const mine = generation.current
    const current = () => alive.current && generation.current === mine
    setMore({ kind: 'loading' })
    load(days, offset).then(
      (res) => {
        if (!current()) return
        setFirst((prev) => prev.kind === 'loaded'
          ? { kind: 'loaded', incidents: [...prev.incidents, ...res.incidents], nextOffset: res.has_more ? res.next_offset : null, pages: prev.pages + 1 }
          : prev)
        setMore({ kind: 'idle' })
      },
      (e) => { if (current()) setMore({ kind: 'failed', message: `More incidents could not be loaded: ${messageOf(e)}` }) },
    )
  }

  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white" aria-labelledby="incidents-heading">
      <div className="border-b border-gray-100 px-5 py-3">
        <h2 id="incidents-heading" className="text-base font-semibold text-graphite">Incidents</h2>
      </div>

      {first.kind === 'loading' && (
        <div role="status" className="divide-y divide-gray-100">
          <span className="sr-only">Loading incidents</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3" aria-hidden="true">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      )}

      {first.kind === 'failed' && (
        <div role="alert" className="flex items-start gap-3 px-5 py-4">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-red-700">Incidents could not be loaded</p>
            <p className="mt-0.5 text-gray-600">{first.message}</p>
          </div>
          <Button variant="secondary" onClick={() => loadFirst(false)}>Retry</Button>
        </div>
      )}

      {first.kind === 'loaded' && first.incidents.length === 0 && (
        <div className="flex flex-col items-center py-8 text-center">
          <CheckCircle2 className="mb-2 h-6 w-6 text-green-500" aria-hidden="true" />
          <p className="text-sm font-medium text-gray-700">{emptyIncidentsText(days, now(), hasOngoing)}</p>
        </div>
      )}

      {first.kind === 'loaded' && first.incidents.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <div className="min-w-[860px]">
              {groupIncidentsByDay(first.incidents, now()).map((day, idx) => (
                <div key={day.key}>
                  <h3 className={`bg-beige px-5 py-2 text-xs font-semibold text-gray-600 ${idx > 0 ? 'border-t border-gray-100' : ''}`}>
                    {day.heading}
                  </h3>
                  <ul>
                    {day.incidents.map((incident) => <IncidentRow key={incident.id} incident={incident} />)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
          {(first.nextOffset !== null || more.kind === 'failed') && (
            <div className="flex items-center gap-3 border-t border-gray-100 px-5 py-3">
              {first.nextOffset !== null && (
                <Button variant="secondary" onClick={loadMore} busy={more.kind === 'loading'}>Show more</Button>
              )}
              {more.kind === 'failed' && <Outcome state={{ kind: 'failed', message: more.message }} />}
            </div>
          )}
        </>
      )}
    </section>
  )
}
