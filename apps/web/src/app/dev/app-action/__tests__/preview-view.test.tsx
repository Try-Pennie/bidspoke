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
  it('presses zoom in four times, then pans to the captured view, then marks the page ready', async () => {
    vi.useFakeTimers()
    const { AppActionPreview, DESIGN_VIEW, DESIGN_ZOOM_PRESSES, PRESS_EVERY_MS } = await import('../AppActionPreview')
    render(<AppActionPreview />)
    act(() => { vi.advanceTimersByTime(DESIGN_ZOOM_PRESSES * PRESS_EVERY_MS) })
    expect(clicks).toHaveBeenCalledTimes(4)
    expect(panTo).not.toHaveBeenCalled()
    expect(document.body.dataset.previewReady).toBeUndefined()
    act(() => { vi.advanceTimersByTime(PRESS_EVERY_MS) })
    expect(panTo).toHaveBeenCalledWith(DESIGN_VIEW)
    act(() => { vi.advanceTimersByTime(PRESS_EVERY_MS) })
    expect(document.body.dataset.previewReady).toBe('1')
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
