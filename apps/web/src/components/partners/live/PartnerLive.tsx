'use client'

/**
 * The partners page live channel on screen (#2135, PR4 of #2114).
 *
 * - PartnerLiveProvider gives the page the browser's join of partners:<org>;
 *   with no provider (a unit test of the form, or no Supabase settings) the
 *   form has no live channel and shows no status.
 * - LiveStatusLine is the header's three states, told apart at a glance (the
 *   time taking action rule): Live; paused while it reconnects, with the
 *   seconds since it dropped; failed, with Retry.
 * - LiveSectionNote shows, on a section, who just updated it or that it was
 *   changed directly in the database.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/form'
import { createClient } from '@/lib/supabase/client'
import type { JoinFn, LiveClock, LiveStatus } from '@/lib/partner-live-channel'
import { browserJoin } from '@/lib/partner-live-join'
import type { SectionNote } from '@/lib/partner-live-page'

export interface PartnerLiveDeps {
  join: JoinFn
  clock: LiveClock
}

export const PartnerLiveContext = createContext<PartnerLiveDeps | null>(null)

const browserClock: LiveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}

/** The page's live channel through the signed in browser client. */
export function PartnerLiveProvider({ children }: { children: ReactNode }) {
  const [live] = useState(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null
    const joined = browserJoin(createClient())
    return { deps: { join: joined.join, clock: browserClock }, dispose: joined.dispose }
  })
  useEffect(() => () => live?.dispose(), [live])
  return <PartnerLiveContext.Provider value={live?.deps ?? null}>{children}</PartnerLiveContext.Provider>
}

/** The header's live status: Live, paused with the seconds, or failed with Retry. */
export function LiveStatusLine({ status, now, onRetry }: { status: LiveStatus | null; now: number; onRetry: () => void }) {
  if (!status) return null
  const seconds = (since: number) => Math.max(0, Math.floor((now - since) / 1000))
  if (status.kind === 'live') return <p role="status" className="outcome outcome-done mt-1">Live</p>
  if (status.kind === 'connecting' || status.kind === 'reconnecting') {
    return (
      <p role="status" className="outcome outcome-working mt-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {status.kind === 'connecting' ? 'Connecting live updates' : 'Live updates paused. Reconnecting'}, {seconds(status.since)} s
      </p>
    )
  }
  return (
    <div role="alert" className="mt-1 flex items-center gap-2">
      <p className="outcome outcome-failed">Live updates failed: {status.reason}</p>
      <Button variant="secondary" onClick={onRetry}>Retry</Button>
    </div>
  )
}

/** Notes by registry section, for LiveSectionNote. */
export const LiveNotesContext = createContext<readonly SectionNote[]>([])

/**
 * The notes for the registry sections a block of the page shows. Sections are
 * the registry's (partner-draft.ts), so a note lands wherever its field is,
 * whatever the block's heading says; live-section-notes-guard.test.ts holds
 * every registry section to a place that shows it.
 */
export function LiveSectionNote({ sections }: { sections: readonly string[] }) {
  const notes = useContext(LiveNotesContext)
  const lines = [...new Set(notes.filter((n) => n.sections.some((s) => sections.includes(s))).map((n) => n.text))]
  if (lines.length === 0) return null
  return (
    <div className="space-y-0.5">
      {lines.map((text) => <p key={text} className="text-xs text-gray-600">{text}</p>)}
    </div>
  )
}

/** The notes no section holds, said once at the top of the page. */
export function LivePageNotes() {
  const notes = useContext(LiveNotesContext)
  const lines = [...new Set(notes.filter((n) => n.sections.length === 0).map((n) => n.text))]
  if (lines.length === 0) return null
  return (
    <div className="mb-4 space-y-0.5">
      {lines.map((text) => <p key={text} className="text-xs text-gray-600">{text}</p>)}
    </div>
  )
}
