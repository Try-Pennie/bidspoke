'use client'

import { useEffect } from 'react'
import { ConnectionFieldPreview } from '../connection-field/ConnectionFieldPreview'
import { askOf, staleOf, type PreviewFrame } from './canvas-save-conflict-preview-source'

/**
 * The canvas save conflict (#2599), one frame at a time (?frame=<id>), for the
 * design score and the screenshots (L606), with no auth and no network. The
 * canvas is the one the settled design's chrome was captured from (the
 * Connection field preview's healthy step, its Salesforce step open), showing
 * the fixture's refusal through the real WorkflowCanvas and SaveConflictBar.
 * A frame that asks presses the strip's button as a person would, once the
 * step is open and the canvas has settled, so its dialog opens over that view.
 * Once settled the page sets data-preview-ready on the body, which the design
 * score waits for before its picture.
 */
export function CanvasSaveConflictPreview({ frame }: { frame: PreviewFrame }) {
  useEffect(() => {
    const label = askOf(frame)
    const timers: ReturnType<typeof setTimeout>[] = []
    // Marks the page ready for the design score's picture (its --ready selector), once settled.
    const ready = () => { document.body.dataset.previewReady = 'true' }
    const find = () => {
      if (!document.querySelector('#step-panel-body [data-preview-step]')) return false
      // The step opens a second after the canvas lays out, then the view is panned; act after both.
      timers.push(setTimeout(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-part="save-conflict"] button')).find((b) => b.textContent === label)
        if (button) button.click()
        timers.push(setTimeout(() => {
          // A press from page script is no pointer to the browser, so the dialog's focused Cancel
          // shows the keyboard focus ring; a person pressing with a mouse sees none, as the design
          // draws. Focus is taken off it so the picture is the mouse user's.
          if (button) (document.activeElement as HTMLElement | null)?.blur()
          ready()
        }, 300))
      }, 1500))
      return true
    }
    if (find()) return () => timers.forEach(clearTimeout)
    const watch = new MutationObserver(() => { if (find()) watch.disconnect() })
    watch.observe(document.body, { childList: true, subtree: true })
    return () => { watch.disconnect(); timers.forEach(clearTimeout) }
  }, [frame])

  return (
    <>
      {/* Next's development indicator is not the product, and the captured chrome has none. */}
      <style>{'nextjs-portal { display: none; }'}</style>
      <ConnectionFieldPreview frame="step-healthy" saveConflict={staleOf(frame)} />
    </>
  )
}
