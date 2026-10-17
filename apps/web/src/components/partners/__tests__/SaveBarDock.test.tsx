/**
 * The dock that slides the Saved bar away (#2322): the frame after the bar goes
 * already draws it leaving, never a blank frame first; any other bar goes at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { SAVE_BAR_LEAVE_MS, SaveBarDock } from '../SaveBar'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SaveBarDock', () => {
  it('draws the Saved bar leaving on the very render it goes, then removes it', () => {
    const { container, rerender } = render(<SaveBarDock bar={<p>Saved</p>} slideOut />)
    rerender(<SaveBarDock bar={null} slideOut={false} />)
    expect(container.querySelector('.save-bar-leaving')).toHaveTextContent('Saved')
    act(() => { vi.advanceTimersByTime(SAVE_BAR_LEAVE_MS) })
    expect(container).toBeEmptyDOMElement()
  })

  it('never blanks between the bar and its leaving: what it shows stays mounted through the change', () => {
    let mounts = 0
    function Saved() { useEffect(() => { mounts += 1 }, []); return <p>Saved</p> }
    const bar = <Saved />
    const { rerender } = render(<SaveBarDock bar={bar} slideOut />)
    rerender(<SaveBarDock bar={null} slideOut={false} />)
    expect(mounts).toBe(1)
  })

  it('takes any other bar away at once', () => {
    const { container, rerender } = render(<SaveBarDock bar={<p>1 unsaved change</p>} slideOut={false} />)
    rerender(<SaveBarDock bar={null} slideOut={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
