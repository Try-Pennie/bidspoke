'use client'

import { useEffect } from 'react'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import { panTo } from '../canvas-view'
import { PREVIEW_WORKFLOW } from './app-action-preview-source'

/** How many presses of the canvas's zoom in button the settled design's canvas was captured after (0.5 to 1.0368). */
export const DESIGN_ZOOM_PRESSES = 4
/** The wait before the first press, for the canvas's opening fit, and between presses. */
export const PRESS_EVERY_MS = 600
/** Where the settled design's captured canvas was then scrolled to (its viewport's translate, docs/design/app-action-node-card/chrome.html). */
export const DESIGN_VIEW = { x: 383.13, y: 46.0128 }

/**
 * The App Action step's card as the canvas draws it (#2339), on the workflow the
 * settled design's canvas was captured from, with its step in place of the
 * Salesforce step: the real WorkflowCanvas in edit mode, no step opened, zoomed
 * and scrolled as the capture was, by pressing the canvas's own zoom in button
 * and dragging its pane as a person does. When the last press has settled the page is marked
 * data-preview-ready, which the design score waits for. Next's development
 * badge is hidden: it is no part of the product. No auth and no network.
 */
export function AppActionPreview() {
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    for (let i = 1; i <= DESIGN_ZOOM_PRESSES; i++) {
      timers.push(setTimeout(() => document.querySelector<HTMLElement>('.react-flow__controls-zoomin')?.click(), i * PRESS_EVERY_MS))
    }
    timers.push(setTimeout(() => panTo(DESIGN_VIEW), (DESIGN_ZOOM_PRESSES + 1) * PRESS_EVERY_MS))
    timers.push(setTimeout(() => { document.body.dataset.previewReady = '1' }, (DESIGN_ZOOM_PRESSES + 2) * PRESS_EVERY_MS))
    return () => {
      for (const t of timers) clearTimeout(t)
      delete document.body.dataset.previewReady
    }
  }, [])

  return (
    <>
      <style>{'nextjs-portal { display: none !important; }'}</style>
      <WorkflowCanvas workflow={PREVIEW_WORKFLOW} mode="edit" />
    </>
  )
}
