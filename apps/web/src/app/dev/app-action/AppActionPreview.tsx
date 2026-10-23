'use client'

import { useEffect } from 'react'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import { panTo } from '../canvas-view'
import { ConnectionListProvider } from '@/components/canvas/connection-names'
import { isTestSendFrame, PREVIEW_WORKFLOW, SEND_CONNECTIONS, SEND_WORKFLOW, type PreviewFrame } from './app-action-preview-source'

/** How many presses of the canvas's zoom in button the settled design's canvas was captured after (0.5 to 1.0368). */
export const DESIGN_ZOOM_PRESSES = 4
/** The wait before the first press, for the canvas's opening fit, and between presses. */
export const PRESS_EVERY_MS = 600
/** Where the settled design's captured canvas was then scrolled to (its viewport's translate, docs/design/app-action-node-card/chrome.html). */
export const DESIGN_VIEW = { x: 383.13, y: 46.0128 }
/** Where the send frames' canvas was scrolled to (docs/design/app-action-test-send/chrome.html): x is 383.13 plus a quarter of a thousandth of a pixel, measured, where the capture's card lands, so each glyph rasterises as it did there. */
export const SEND_VIEW = { x: 383.13024, y: 46.0128 }

/**
 * The App Action step's card as the canvas draws it (#2339), on the workflow the
 * settled design's canvas was captured from, with its step in place of the
 * Salesforce step: the real WorkflowCanvas in edit mode, no step opened, zoomed
 * and scrolled as the capture was, by pressing the canvas's own zoom in button
 * and dragging its pane as a person does. When the last press has settled the page is marked
 * data-preview-ready, which the design score waits for. Next's development
 * badge is hidden: it is no part of the product. No auth and no network.
 */
export function AppActionPreview({ frame = 'app-action-card' }: { frame?: PreviewFrame }) {
  const send = isTestSendFrame(frame)
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let step = 0
    const then = (act: () => void) => { step++; timers.push(setTimeout(act, step * PRESS_EVERY_MS)) }
    for (let i = 1; i <= DESIGN_ZOOM_PRESSES; i++) then(() => document.querySelector<HTMLElement>('.react-flow__controls-zoomin')?.click())
    then(() => panTo(send ? SEND_VIEW : DESIGN_VIEW))
    // The send frames (#2339): the step opened, as a person opens it, and its Test this node expanded.
    if (send) {
      then(() => document.querySelector<HTMLElement>('.react-flow__node[data-id="n1"]')?.click())
      then(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Test this node')?.click())
      if (frame === 'send-ticked') then(() => document.querySelector<HTMLElement>('[role="checkbox"]')?.click())
    }
    then(() => { document.body.dataset.previewReady = '1' })
    return () => {
      for (const t of timers) clearTimeout(t)
      delete document.body.dataset.previewReady
    }
  }, [frame, send])

  return (
    <>
      <style>{'nextjs-portal { display: none !important; }'}</style>
      {send ? (
        <ConnectionListProvider load={loadSendConnections}>
          <WorkflowCanvas workflow={SEND_WORKFLOW} mode="edit" />
        </ConnectionListProvider>
      ) : (
        <WorkflowCanvas workflow={PREVIEW_WORKFLOW} mode="edit" />
      )}
    </>
  )
}

const loadSendConnections = () => Promise.resolve(SEND_CONNECTIONS)
