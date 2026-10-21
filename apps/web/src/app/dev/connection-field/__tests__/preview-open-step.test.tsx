/**
 * The Connection field preview opens the design's step as a person does, by a
 * click on its card once the canvas has settled (#2338 build PR 11), and that
 * click never lands after the preview has gone, however the panel was found.
 * The canvas is stood in for, so the test reads only the preview's own timing.
 */
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/canvas/WorkflowCanvas', () => ({
  default: () => (
    <div>
      <div className="react-flow__node" data-id="n1" />
      <div id="step-panel-body" />
    </div>
  ),
}))
vi.mock('@/components/connections/ConnectionField', () => ({ ConnectionField: () => <div data-part="connection-field" /> }))
vi.mock('@/components/ui/Select', () => ({ Select: () => null }))

/** Every click the preview makes on the card, read from the element itself. */
const clicks = vi.spyOn(HTMLElement.prototype, 'click')

afterEach(() => { vi.useRealTimers(); clicks.mockClear() })

describe('the preview opening its step', () => {
  it("clicks the step's card a second after the canvas shows it", async () => {
    vi.useFakeTimers()
    const { ConnectionFieldPreview } = await import('../ConnectionFieldPreview')
    render(<ConnectionFieldPreview frame="step-healthy" />)
    act(() => { vi.advanceTimersByTime(999) })
    expect(clicks).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(clicks).toHaveBeenCalledTimes(1)
  })

  it('never clicks after the preview is gone, even when the panel was there at once', async () => {
    vi.useFakeTimers()
    const { ConnectionFieldPreview } = await import('../ConnectionFieldPreview')
    const { unmount } = render(<ConnectionFieldPreview frame="step-healthy" />)
    // The panel body is in the document on the first look, the path that once left the timer running.
    expect(document.getElementById('step-panel-body')).not.toBeNull()
    unmount()
    // A click on a card that has gone reaches no handler, so the timer itself is what must be gone.
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(clicks).not.toHaveBeenCalled()
  })
})
