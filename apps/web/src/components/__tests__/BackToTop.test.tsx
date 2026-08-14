import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BackToTop } from '../BackToTop'

/**
 * Issue #441. The execution detail page runs long (trigger payload, error
 * blocks, the per-step list, bid attempts), and getting back to the header from
 * the bottom means a lot of scrolling.
 *
 * The thing that would have made this ship broken: the page does NOT scroll on
 * the window. NavLayout puts the content in `<main className="overflow-auto">`,
 * so `window.scrollTo` is a no-op here. The button finds its own scrollable
 * ancestor at runtime and falls back to the window only when there is none, and
 * both paths are asserted below.
 */
/**
 * A container that genuinely scrolls, set up BEFORE mounting.
 *
 * Order matters: the component locates its scroll container in an effect on
 * mount, so metrics applied after render would arrive too late and it would fall
 * back to the window, which is exactly the bug this component exists to avoid.
 * jsdom also reports clientHeight/scrollHeight as 0 and never scrolls, so they
 * have to be defined explicitly.
 */
function mountInScroller(scrollTop = 0, { clientHeight = 600, scrollHeight = 5000 } = {}) {
  const el = document.createElement('div')
  el.style.overflowY = 'auto'
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true })
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo
  document.body.appendChild(el)
  render(<BackToTop />, { container: el })
  return el
}

/** Move the container and let the component react. */
function scrollTo(el: HTMLElement, top: number) {
  ;(el as unknown as { scrollTop: number }).scrollTop = top
  act(() => { el.dispatchEvent(new Event('scroll')) })
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})
afterEach(() => vi.unstubAllGlobals())

describe('BackToTop visibility (#441)', () => {
  it('is hidden at the top of the page', () => {
    mountInScroller(0)
    expect(screen.queryByRole('button', { name: /back to top/i })).toBeNull()
  })

  it('appears once scrolled past one viewport', () => {
    const el = mountInScroller(0)
    scrollTo(el, 900)
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument()
  })

  it('stays hidden just below one viewport, so it does not flicker in on a nudge', () => {
    const el = mountInScroller(0)
    scrollTo(el, 400)
    expect(screen.queryByRole('button', { name: /back to top/i })).toBeNull()
  })

  it('hides again after scrolling back up', () => {
    const el = mountInScroller(0)
    scrollTo(el, 900)
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument()
    scrollTo(el, 10)
    expect(screen.queryByRole('button', { name: /back to top/i })).toBeNull()
  })
})

describe('BackToTop scrolling (#441)', () => {
  it('scrolls the container it lives in, not the window', async () => {
    const windowScroll = vi.fn()
    vi.stubGlobal('scrollTo', windowScroll)
    const el = mountInScroller(0)
    scrollTo(el, 900)

    await userEvent.click(screen.getByRole('button', { name: /back to top/i }))

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    expect(windowScroll).not.toHaveBeenCalled()
  })

  it('honours a reduced-motion preference by jumping instead of animating', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const el = mountInScroller(0)
    scrollTo(el, 900)

    await userEvent.click(screen.getByRole('button', { name: /back to top/i }))

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
  })
})

describe('BackToTop accessibility (#441)', () => {
  it('has an accessible name, since it is icon-only', () => {
    const el = mountInScroller(0)
    scrollTo(el, 900)
    expect(screen.getByRole('button', { name: 'Back to top' })).toBeInTheDocument()
  })

  it('is reachable and operable from the keyboard', async () => {
    const el = mountInScroller(0)
    scrollTo(el, 900)

    await userEvent.tab()
    const btn = screen.getByRole('button', { name: /back to top/i })
    expect(btn).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(el.scrollTo).toHaveBeenCalled()
  })
})
