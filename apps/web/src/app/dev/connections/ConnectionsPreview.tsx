'use client'

import { useMemo } from 'react'
import NavLayout from '@/components/NavLayout'
import { ConnectionsScreen, type ConnectionsClock } from '@/components/connections/ConnectionsScreen'
import { PREVIEW_NOW, PREVIEW_ORG_NAMES, previewFrame, previewSource } from './connections-preview-source'

/**
 * The Connections page drawn from the settled design's fixture, one frame at a
 * time (?frame=<id>, the design score's built side), inside the app's own
 * chrome with Connections the current nav item. The clock starts at the
 * fixture's moment and runs from there, so a waiting state counts its seconds.
 * ?google=<n> adds n made up entries to the Google list, for a picture at
 * production length.
 */
export function ConnectionsPreview({ frame, moreGoogle }: { frame: string | undefined; moreGoogle: number }) {
  const source = useMemo(() => previewSource(frame, moreGoogle), [frame, moreGoogle])
  const clock = useMemo<ConnectionsClock>(() => {
    const started = Date.now()
    return {
      now: () => PREVIEW_NOW + (Date.now() - started),
      every: (ms, fn) => {
        const id = setInterval(fn, ms)
        return () => clearInterval(id)
      },
    }
  }, [])
  const { chosen } = previewFrame(frame)
  return (
    <NavLayout activeHref="/connections">
      <ConnectionsScreen key={frame ?? 'healthy'} source={source} clock={clock} orgNames={PREVIEW_ORG_NAMES} initialChosen={chosen} />
    </NavLayout>
  )
}
