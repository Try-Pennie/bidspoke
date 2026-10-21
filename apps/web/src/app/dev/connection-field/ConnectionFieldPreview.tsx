'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import { ConnectionField } from '@/components/connections/ConnectionField'
import { realClock } from '@/components/ui/Combobox'
import { Select } from '@/components/ui/Select'
import { chosenIdOf, PREVIEW_STEP, PREVIEW_WORKFLOW, previewLoadList, stillClock, type PreviewFrame } from './connection-field-preview-source'

/**
 * A step's Connection field (#2338, build PR 11) as the canvas will show it,
 * one frame at a time (?frame=<id>), for the design score and the screenshots
 * (L606), with no auth and no network.
 *
 * The canvas, its header and the step panel's own header are the real
 * WorkflowCanvas and ConfigPanel, open on the design's workflow. The field is
 * mounted on a step in #2339, not here, so the panel's body is this preview's
 * own: the step's fields as the settled design draws them around the real
 * ConnectionField (Display name and Step ID as the product draws them today,
 * Operation and Object the app's Select), drawn into the panel's body in place
 * of the Salesforce step's form.
 */
export function ConnectionFieldPreview({ frame }: { frame: PreviewFrame }) {
  const [body, setBody] = useState<HTMLElement | null>(null)
  useEffect(() => {
    // The step is opened as a person opens it, by a click on its card once the canvas has
    // laid it out, so the canvas keeps the view it opened with (focusing a step zooms to it).
    // The click waits for the canvas's opening fit, which runs once its layout settles; then the
    // canvas is panned, as a person drags it, to the view the settled design was captured at.
    let clickAt: ReturnType<typeof setTimeout> | null = null
    const find = () => {
      const card = document.querySelector<HTMLElement>('.react-flow__node[data-id="n1"]')
      if (card && clickAt === null) clickAt = setTimeout(() => { card.click(); panTo(DESIGN_VIEW) }, 1000)
      const el = document.getElementById('step-panel-body')
      if (el) setBody(el)
      return el !== null
    }
    if (find()) return
    const watch = new MutationObserver(() => { if (find()) watch.disconnect() })
    watch.observe(document.body, { childList: true, subtree: true })
    return () => { watch.disconnect(); if (clickAt !== null) clearTimeout(clickAt) }
  }, [])

  return (
    <>
      {/* The Salesforce step's own form is hidden; the preview's body takes its place. */}
      <style>{'#step-panel-body > :not([data-preview-step]) { display: none; }'}</style>
      <WorkflowCanvas workflow={PREVIEW_WORKFLOW} mode="edit" />
      {body && createPortal(<StepBody frame={frame} />, body)}
    </>
  )
}

/** Where the settled design's captured canvas was scrolled to (its viewport's translate). */
const DESIGN_VIEW = { x: 425, y: 242.75 }

/**
 * Pans the canvas so its view starts at `to`, by a drag on its empty pane, the
 * way a person moves it: React Flow keeps its viewport inside the canvas, out
 * of the preview's reach.
 */
function panTo(to: { x: number; y: number }) {
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')
  const pane = document.querySelector<HTMLElement>('.react-flow__pane')
  if (!viewport || !pane) return
  const now = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
  const dx = to.x - now.m41
  const dy = to.y - now.m42
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
  const box = pane.getBoundingClientRect()
  const x = box.left + 20
  const y = box.top + 20
  // Built as PointerEvents, which keep a fraction of a pixel where a MouseEvent rounds it away, so
  // the view lands where the design's did, its background dots included.
  const at = (type: string, cx: number, cy: number, target: EventTarget) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: type === 'mouseup' ? 0 : 1 }))
  at('mousedown', x, y, pane)
  at('mousemove', x + dx / 2, y + dy / 2, window)
  at('mousemove', x + dx, y + dy, window)
  at('mouseup', x + dx, y + dy, window)
}

function StepBody({ frame }: { frame: PreviewFrame }) {
  const [connection, setConnection] = useState<string | null>(() => chosenIdOf(frame))
  const loadList = useMemo(() => previewLoadList(frame), [frame])
  const clock = useMemo(() => (frame === 'loading' ? stillClock(6000) : realClock), [frame])
  const [opened, setOpened] = useState(false)
  // The menu-open frame shows the list open, as a person pressing the arrow key would.
  useEffect(() => {
    if (frame !== 'menu-open' || opened) return
    const box = document.getElementById('step-connection')
    if (!box) return
    const t = setTimeout(() => {
      box.focus()
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      setOpened(true)
    }, 300)
    return () => clearTimeout(t)
  }, [frame, opened])

  return (
    <div data-preview-step className="p-4 space-y-5">
      <div>
        <label htmlFor="step-display-name" className="mb-1 block text-xs font-medium text-gray-600">Display name</label>
        <input id="step-display-name" className="input" placeholder={PREVIEW_STEP.stepId} defaultValue={PREVIEW_STEP.displayName} />
        <p className="mt-1 text-xs text-gray-500">How this step appears on the canvas. Leave blank to use the step ID.</p>
      </div>
      <div>
        <label htmlFor="step-id" className="mb-1 block text-xs font-medium text-gray-600">Step ID</label>
        <input id="step-id" className="input" defaultValue={PREVIEW_STEP.stepId} />
        <p className="mt-1 text-xs text-gray-500">Unique identifier used to reference this step&apos;s output in later steps. E.g. steps.credit_check.score</p>
      </div>
      <section className="space-y-4">
        <ConnectionField id="step-connection" service="salesforce" value={connection} onChange={setConnection} loadList={loadList} clock={clock} />
        <div>
          <label htmlFor="step-operation" className="mb-1 block text-xs font-medium text-gray-600">Operation</label>
          <Select id="step-operation" value="query" onChange={() => {}} options={[{ value: 'query', label: PREVIEW_STEP.operation }]} />
        </div>
        <div>
          <label htmlFor="step-object" className="mb-1 block text-xs font-medium text-gray-600">Object</label>
          <Select id="step-object" value="prospect" onChange={() => {}} options={[{ value: 'prospect', label: PREVIEW_STEP.object }]} />
        </div>
      </section>
    </div>
  )
}
