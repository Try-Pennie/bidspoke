'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import type { OngoingIncident, OngoingIncidentsResponse } from '@/lib/api'
import { Button } from '@/components/ui/form'
import { ongoingIncidentSentence } from '@/lib/incidents'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; incidents: OngoingIncident[]; hasMore: boolean }

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'The request failed.')

/**
 * Each open incident as one red line under the dashboard header, above the
 * success rate (#2101, settled with Dan on 2026-10-14, docs/design/incidents-card.html).
 * Nothing shows while it loads or when none is open. A failed read is its own
 * neutral error with a retry, so it never reads as "no ongoing incident".
 */
export function OngoingIncidents({
  load = api.incidents.ongoing,
  now = Date.now,
  refreshKey = 0,
  onCount,
}: {
  load?: () => Promise<OngoingIncidentsResponse>
  now?: () => number
  /** Changes whenever the page refreshes, so an incident that ended leaves the line. */
  refreshKey?: number
  /** How many are open once known, or null when the read failed. */
  onCount?: (n: number | null) => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const alive = useRef(true)
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Only the latest read may answer: an older one arriving last would bring back
  // an incident that has since ended.
  const latest = useRef(0)

  const read = useCallback(() => {
    const mine = ++latest.current
    const current = () => alive.current && latest.current === mine
    load().then(
      (res) => {
        if (!current()) return
        setState({ kind: 'loaded', incidents: res.incidents, hasMore: res.has_more })
        onCountRef.current?.(res.incidents.length)
      },
      (e) => {
        if (!current()) return
        setState({ kind: 'failed', message: messageOf(e) })
        onCountRef.current?.(null)
      },
    )
  }, [load])

  // The first read, then a quiet re-read on every page refresh: the lines shown
  // stay until the answer arrives.
  useEffect(() => { read() }, [read, refreshKey])

  if (state.kind === 'loading') return null

  if (state.kind === 'failed') {
    return (
      <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-graphite">Ongoing incidents could not be checked</p>
          <p className="mt-0.5 text-gray-600">{state.message}</p>
        </div>
        <Button variant="secondary" onClick={read}>Retry</Button>
      </div>
    )
  }

  if (state.incidents.length === 0) return null

  return (
    <section aria-label="Ongoing incidents" className="mb-6">
      <ul className="space-y-2">
        {state.incidents.map((incident) => (
          <li key={incident.id} className="flex items-baseline gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm">
            <span className="whitespace-nowrap font-semibold text-red-700">Ongoing incident</span>
            <span className="text-graphite">{ongoingIncidentSentence(incident, now())}</span>
          </li>
        ))}
      </ul>
      {state.hasMore && <p className="mt-2 text-sm text-graphite">More incidents are open than are listed here.</p>}
    </section>
  )
}
