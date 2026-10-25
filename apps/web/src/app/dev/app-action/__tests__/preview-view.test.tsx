/**
 * The App Action card preview reaches the view the settled design's canvas was
 * captured at (#2339) as a person would: four presses of the canvas's zoom in
 * button, then a drag of its pane, and only then marks itself ready for the
 * design score. The canvas is stood in for, so the test reads only the timing.
 */
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/canvas/WorkflowCanvas', () => ({
  default: () => <button className="react-flow__controls-zoomin" type="button" />,
}))
const panTo = vi.fn()
vi.mock('../../canvas-view', () => ({ panTo: (to: unknown) => panTo(to) }))

const clicks = vi.spyOn(HTMLElement.prototype, 'click')

afterEach(() => { vi.useRealTimers(); clicks.mockClear(); panTo.mockClear() })

describe('the preview reaching the design view', () => {
  it('waits for the canvas to settle, presses zoom in four times, then pans to the captured view, then marks the page ready', async () => {
    vi.useFakeTimers()
    const { AppActionPreview, DESIGN_VIEW, DESIGN_ZOOM_PRESSES, PRESS_EVERY_MS, SETTLE_MS } = await import('../AppActionPreview')
    render(<AppActionPreview />)
    act(() => { vi.advanceTimersByTime(SETTLE_MS) })
    expect(clicks).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(DESIGN_ZOOM_PRESSES * PRESS_EVERY_MS) })
    expect(clicks).toHaveBeenCalledTimes(4)
    expect(panTo).not.toHaveBeenCalled()
    expect(document.body.dataset.previewReady).toBeUndefined()
    act(() => { vi.advanceTimersByTime(PRESS_EVERY_MS) })
    expect(panTo).toHaveBeenCalledWith(DESIGN_VIEW)
    act(() => { vi.advanceTimersByTime(PRESS_EVERY_MS) })
    expect(document.body.dataset.previewReady).toBe('1')
  })

  it('in a send frame, then opens the step, expands Test this node and ticks the box, as a person would, before marking ready (#2339)', async () => {
    vi.useFakeTimers()
    const { AppActionPreview, DESIGN_ZOOM_PRESSES, PRESS_EVERY_MS, SEND_VIEW, SETTLE_MS } = await import('../AppActionPreview')
    render(<AppActionPreview frame="send-ticked" />)
    act(() => { vi.advanceTimersByTime(SETTLE_MS + (DESIGN_ZOOM_PRESSES + 1) * PRESS_EVERY_MS) })
    expect(panTo).toHaveBeenCalledWith(SEND_VIEW)
    const node = document.createElement('div')
    node.className = 'react-flow__node'
    node.dataset.id = 'n1'
    const toggle = document.createElement('button')
    toggle.textContent = 'Test this node'
    const tick = document.createElement('button')
    tick.setAttribute('role', 'checkbox')
    document.body.append(node, toggle, tick)
    const order: string[] = []
    node.addEventListener('click', () => order.push('node'))
    toggle.addEventListener('click', () => order.push('test'))
    tick.addEventListener('click', () => order.push('tick'))
    act(() => { vi.advanceTimersByTime(3 * PRESS_EVERY_MS) })
    expect(order).toEqual(['node', 'test', 'tick'])
    expect(document.body.dataset.previewReady).toBeUndefined()
    act(() => { vi.advanceTimersByTime(PRESS_EVERY_MS) })
    expect(document.body.dataset.previewReady).toBe('1')
    node.remove(); toggle.remove(); tick.remove()
  })

  it('stops pressing once the preview is gone, and clears its ready mark', async () => {
    vi.useFakeTimers()
    const { AppActionPreview, PRESS_EVERY_MS } = await import('../AppActionPreview')
    const { unmount } = render(<AppActionPreview />)
    unmount()
    act(() => { vi.advanceTimersByTime(10 * PRESS_EVERY_MS) })
    expect(clicks).not.toHaveBeenCalled()
    expect(document.body.dataset.previewReady).toBeUndefined()
  })
})
