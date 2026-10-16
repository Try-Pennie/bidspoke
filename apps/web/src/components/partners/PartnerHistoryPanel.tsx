'use client'

/**
 * The History tab (#2137): when the partner was last saved and by whom, and for
 * a buyer the buyer profile's saves (moved here from the Buyer profile tab, so
 * the history is said once). PR10 (#2141) replaces the contents with every
 * change to the partner, by person and by job.
 *
 * The profile's history is read when the tab is first shown, not with the page:
 * the panel stays mounted, and a read nobody looks at is not made. A failed read
 * is its own state with Try again, never an empty list (L10).
 */
import { useEffect, useState } from 'react'
import { api, type Partner } from '@/lib/api'
import { errorSentence } from '@/lib/error-sentence'
import { formatEtDayTime } from '@/lib/dates'
import { Button } from '@/components/ui/form'
import { BuyerProfileHistory, type HistoryEntry } from './buyer-profile/BuyerProfileHistory'

/** "Last saved Oct 13, 2:05 PM ET by Brian Nelms." (formatEtDayTime, no year), the editor by name where the row carries one. */
export function lastSavedSentence(partner: Pick<Partner, 'updated_at' | 'updated_by_name' | 'updated_by_email'>): string {
  const who = partner.updated_by_name ?? partner.updated_by_email?.split('@')[0] ?? 'someone not on record'
  // A stamp that does not read as a time is said as unknown, never as a wrong date (L50).
  const when = Number.isNaN(Date.parse(partner.updated_at)) ? 'at an unknown time' : `${formatEtDayTime(partner.updated_at)} ET`
  return `Last saved ${when} by ${who}.`
}

export function PartnerHistoryPanel({ partner, isBuyer, shown }: { partner: Partner; isBuyer: boolean; shown: boolean }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [wanted, setWanted] = useState(shown)
  useEffect(() => { if (shown) setWanted(true) }, [shown])

  useEffect(() => {
    if (!isBuyer || !wanted) return
    let cancelled = false
    setError(null)
    api.buyerProfiles.history(partner.id)
      .then((h) => { if (!cancelled) setEntries(h.entries) })
      .catch((err: unknown) => { if (!cancelled) setError(errorSentence(err, 'the read failed')) })
    return () => { cancelled = true }
  }, [partner.id, isBuyer, wanted, attempt])

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-700">{lastSavedSentence(partner)}</p>
      {isBuyer && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-gray-500">Buyer profile saves</h3>
          {error ? (
            <div role="alert" className="flex items-center gap-3 text-sm text-red-700">
              <span className="flex-1">Could not load the buyer profile history: {error}</span>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            </div>
          ) : entries === null ? (
            <p role="status" className="text-xs text-gray-600">Reading the history…</p>
          ) : (
            <BuyerProfileHistory entries={entries} />
          )}
        </div>
      )}
    </div>
  )
}
