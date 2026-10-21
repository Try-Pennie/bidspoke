'use client'

import { useMemo } from 'react'
import NavLayout from '@/components/NavLayout'
import { ConnectionsScreen, type ConnectionsClock } from '@/components/connections/ConnectionsScreen'
import { PREVIEW_NOW, PREVIEW_ORG_NAMES, previewFrame, previewScript, previewServices, previewSource } from './connections-preview-source'

/**
 * The Connections page drawn from the settled design's fixture, one frame at a
 * time (?frame=<id>), inside the app's own chrome with Connections the current
 * nav item.
 *
 * A settled frame (docs/design/connections-page/settled.json, the design
 * score's built side) loads through the page's own calls, answered from the
 * fixture, on a clock that starts at the fixture's moment and runs. A frame
 * the design never drew (SCRIPTED_FRAMES) is reached by its events instead,
 * applied by the reducer before the first paint, on a clock that stands still,
 * so a state that counts its seconds always reads the same. ?google=<n> adds n
 * made up entries to the Google list, for a picture at production length.
 */
export function ConnectionsPreview({ frame, moreGoogle }: { frame: string | undefined; moreGoogle: number }) {
  const source = useMemo(() => previewSource(frame, moreGoogle), [frame, moreGoogle])
  const script = useMemo(() => previewScript(frame), [frame])
  const clock = useMemo<ConnectionsClock>(() => {
    if (script) return { now: () => PREVIEW_NOW, every: () => () => {} }
    const started = Date.now()
    return {
      now: () => PREVIEW_NOW + (Date.now() - started),
      every: (ms, fn) => {
        const id = setInterval(fn, ms)
        return () => clearInterval(id)
      },
    }
  }, [script])
  const { chosen } = previewFrame(frame)
  const services = useMemo(() => previewServices(), [])
  return (
    <NavLayout activeHref="/connections">
      <ConnectionsScreen
        key={frame ?? 'healthy'}
        source={source}
        clock={clock}
        orgNames={script ? script.orgNames : PREVIEW_ORG_NAMES}
        services={services}
        initialChosen={script ? undefined : chosen}
        initialEvents={script?.events}
        noInitialLoad={script !== null}
        initialFocus={script?.focus}
        initialLeaveTo={script?.leaveTo}
      />
    </NavLayout>
  )
}
