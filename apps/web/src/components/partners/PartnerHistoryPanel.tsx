'use client'

/**
 * The History tab (#2141, PR10 of #2114): every change to the partner from
 * every source the route merges (partner settings, the buyer profile, bid
 * matrices and their syncs, sub-account IDs, held clicks), grouped by Eastern
 * day, each with its time and who made it: a person by name, a job by name, or
 * "Changed directly in the database". The settled design draws it (rounds 29
 * and 30): a day heading, then the time and editor beside each change, the old
 * value struck through, an arrow, the new value in bold, and no History heading
 * repeating the tab's name.
 *
 * The history is read when the tab is first shown, not with the page: the panel
 * stays mounted, and a read nobody looks at is not made. Any failure, whichever
 * read the route names, is one error state with Try again, never a partial list
 * (L530, L11). An answer the route could not read to the end says how far back
 * it is complete. A raw path nothing names is shown and logged with its count
 * (L96).
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type Partner, type PartnerHistory } from '@/lib/api'
import { formatEtClock, formatEtDayTime } from '@/lib/dates'
import { Button } from '@/components/ui/form'
import { describeEntry, groupByEtDay, nextPickupExpiry, pickupNote, type HistoryLine } from './history/describe-history'

type Read = { kind: 'idle' } | { kind: 'reading' } | { kind: 'failed' } | { kind: 'read'; history: PartnerHistory }

function Line({ line }: { line: HistoryLine }) {
  if (line.kind === 'text') return <p>{line.text}</p>
  if (line.kind === 'set') {
    return (
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-graphite">{line.label}</span>{' '}
        <strong className="font-semibold text-navy">{line.value}</strong>
      </p>
    )
  }
  return (
    // The spaces between the parts are text, so a screen reader and a copy read
    // "Leads per day from 250 to 500", while flex drops them on screen.
    <p className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-graphite">{line.label}</span>{' '}
      <span className="sr-only">from</span>{' '}
      <del className="text-gray-600">{line.from}</del>{' '}
      <span aria-hidden="true" className="text-gray-600">{'→'}</span>{' '}
      <span className="sr-only">to</span>{' '}
      <strong className="font-semibold text-navy">{line.to}</strong>
    </p>
  )
}

export function PartnerHistoryPanel({ partner, shown, clock = Date.now }: { partner: Partner; shown: boolean; clock?: () => number }) {
  const [read, setRead] = useState<Read>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const [wanted, setWanted] = useState(shown)
  const [now, setNow] = useState(() => clock())
  useEffect(() => { if (shown) setWanted(true) }, [shown])

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    setRead({ kind: 'reading' })
    api.partners.history(partner.id)
      .then((history) => {
        if (cancelled) return
        setNow(clock())
        setRead({ kind: 'read', history })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // The route names the read that failed (history_unavailable); the
        // person is told the one thing they can do, and the console keeps the rest.
        console.error('[partner-history] history read failed', err)
        setRead({ kind: 'failed' })
      })
    return () => { cancelled = true }
    // clock is a seam for tests, not an input that should trigger a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner.id, wanted, attempt])

  const described = useMemo(() => {
    if (read.kind !== 'read') return null
    return new Map(read.history.entries.map((e) => [e.key, describeEntry(e)]))
  }, [read])

  // One warning per read, with the count, for the paths no registry entry names.
  useEffect(() => {
    if (!described || read.kind !== 'read') return
    const paths = [...described.values()].flatMap((d) => d.unregistered)
    if (paths.length > 0) console.warn('[partner-history] history_unregistered_path', { partnerId: read.history.partnerId, count: paths.length, paths })
  }, [described, read])

  // A pickup note stands only while bidding may still be catching up; drop it when that passes.
  useEffect(() => {
    if (read.kind !== 'read') return
    const expiry = nextPickupExpiry(read.history.entries, now)
    if (expiry === null) return
    const timer = setTimeout(() => setNow(clock()), Math.max(0, expiry - now) + 1)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, now])

  if (read.kind === 'failed') {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-red-700">
        <span className="flex-1">Could not load history. Try again.</span>
        <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      </div>
    )
  }
  if (read.kind !== 'read' || !described) {
    return <p role="status" className="text-xs text-gray-600">{read.kind === 'reading' ? 'Reading the history…' : ''}</p>
  }
  const { history } = read
  if (history.entries.length === 0) return <p className="text-sm text-gray-700">No change to {partner.name} is recorded.</p>

  return (
    <div className="space-y-4">
      {groupByEtDay(history.entries, now).map((day) => (
        <section key={day.key} aria-labelledby={`history-day-${day.key}`}>
          <h3 id={`history-day-${day.key}`} className="pb-1 text-sm font-semibold text-graphite">{day.heading}</h3>
          <ol>
            {day.entries.map((e) => {
              const note = pickupNote(e, now)
              return (
                <li key={e.key} className="grid grid-cols-[150px_1fr] gap-2.5 border-t border-gray-200 py-1.5">
                  <div className="flex flex-col text-xs text-gray-600">
                    <span>{formatEtClock(e.at)} ET</span>{' '}
                    <span>{e.editorLabel}</span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 text-xs text-graphite [overflow-wrap:anywhere]">
                    {described.get(e.key)!.lines.map((line, i) => <Line key={i} line={line} />)}
                    {note && <p className="text-gray-600">{note}</p>}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
      {!history.complete && history.completeSince && (
        <p className="text-xs text-gray-600">History is complete back to {formatEtDayTime(history.completeSince)} ET; older changes are not listed.</p>
      )}
    </div>
  )
}
