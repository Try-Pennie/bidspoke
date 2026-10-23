/**
 * How a development preview sets the canvas's view to the one a settled design's
 * canvas was captured at, as a person would (#2338, #2339): shared by the
 * Connection field and App Action previews.
 */

/**
 * Pans the canvas so its view starts at `to`, by a drag on its empty pane, the
 * way a person moves it: React Flow keeps its viewport inside the canvas, out
 * of the preview's reach.
 */
export function panTo(to: { x: number; y: number }) {
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
