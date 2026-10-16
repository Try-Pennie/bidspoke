/**
 * The one leave guard (#2138, PM-5): what it holds, what it lets through, and
 * that the browser's own warning is raised only while something would be lost.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { beforeUnloadListener, holdAuthRedirect, leaveThen, useLeaveGuard, type LeaveRequest } from '../leave-guard'

function Guarded({ blocking, onAsk, onAuthRejected }: { blocking: boolean; onAsk: (r: LeaveRequest) => void; onAuthRejected?: (s: 401 | 403) => void }) {
  useLeaveGuard({ blocking, onAsk, onAuthRejected })
  return (
    <>
      {/* A plain anchor stands in for any same origin link, a Next Link included. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/workflows" onClick={(e) => { e.preventDefault(); followed('/workflows') }}>Workflows</a>
      <a href="#main-content">Skip to main content</a>
      <a href="https://example.com/elsewhere">Elsewhere</a>
      <a href="/docs" target="_blank" rel="noreferrer">Docs</a>
    </>
  )
}
const followed = vi.fn()

afterEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/partners')
})

function unloadEvent() {
  const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  Object.defineProperty(e, 'returnValue', { value: undefined, writable: true })
  return e
}

describe('the browser leave warning', () => {
  it('calls preventDefault and sets returnValue only while something would be lost', () => {
    let blocking = true
    const listener = beforeUnloadListener(() => blocking)
    const armed = unloadEvent()
    listener(armed)
    expect(armed.defaultPrevented).toBe(true)
    expect(armed.returnValue).toBe('')
    blocking = false
    const clean = unloadEvent()
    listener(clean)
    expect(clean.defaultPrevented).toBe(false)
    expect(clean.returnValue).toBeUndefined()
  })

  it('is on the window only while the page blocks', () => {
    const { rerender } = render(<Guarded blocking onAsk={vi.fn()} />)
    const dirty = unloadEvent()
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    rerender(<Guarded blocking={false} onAsk={vi.fn()} />)
    const clean = unloadEvent()
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
  })
})

describe('a link click while blocking', () => {
  it('is held and asked about, naming the link, and proceeding follows it once', () => {
    const onAsk = vi.fn()
    const { getByText } = render(<Guarded blocking onAsk={onAsk} />)
    fireEvent.click(getByText('Workflows'))
    expect(followed).not.toHaveBeenCalled()
    expect(onAsk).toHaveBeenCalledTimes(1)
    const request = onAsk.mock.calls[0][0] as LeaveRequest
    expect(request.destination).toEqual({ kind: 'page', name: 'Workflows' })
    request.proceed()
    expect(followed).toHaveBeenCalledTimes(1)
    expect(followed).toHaveBeenCalledWith('/workflows')
  })

  it('a ctrl, cmd, shift or middle click is not held: it opens a new tab, which loses nothing', () => {
    const onAsk = vi.fn()
    const { getByText } = render(<Guarded blocking onAsk={onAsk} />)
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) fireEvent.click(getByText('Workflows'), mod)
    expect(onAsk).not.toHaveBeenCalled()
    expect(followed).toHaveBeenCalledTimes(4)
  })

  it('the skip link, another site and a new tab link are not held', () => {
    const onAsk = vi.fn()
    const { getByText } = render(<Guarded blocking onAsk={onAsk} />)
    for (const text of ['Skip to main content', 'Elsewhere', 'Docs']) {
      const link = getByText(text)
      // Keep jsdom from attempting the navigation itself.
      link.addEventListener('click', (e) => e.preventDefault())
      fireEvent.click(link)
    }
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('nothing is held while the page does not block', () => {
    const onAsk = vi.fn()
    const { getByText } = render(<Guarded blocking={false} onAsk={onAsk} />)
    fireEvent.click(getByText('Workflows'))
    expect(onAsk).not.toHaveBeenCalled()
    expect(followed).toHaveBeenCalledTimes(1)
  })
})

describe('browser back while blocking', () => {
  it('a sentinel entry is pushed; a back press puts it back and asks; proceeding goes back past both', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    const onAsk = vi.fn()
    render(<Guarded blocking onAsk={onAsk} />)
    expect(push).toHaveBeenCalledTimes(1)
    // The browser has moved back to the entry under the sentinel.
    window.history.replaceState(null, '', '/partners')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(push).toHaveBeenCalledTimes(2)
    const request = onAsk.mock.calls[0][0] as LeaveRequest
    expect(request.destination).toEqual({ kind: 'back' })
    expect(go).not.toHaveBeenCalled()
    request.proceed()
    expect(go).toHaveBeenCalledWith(-2)
    push.mockRestore()
    go.mockRestore()
  })
})

describe('the sentinel once the page is clean again (L710)', () => {
  it('a Back that lands on the copy under the sentinel goes on back once, so the first Back is never dead', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Guarded blocking onAsk={vi.fn()} />)
    rerender(<Guarded blocking={false} onAsk={vi.fn()} />)
    // The browser has moved back off the sentinel onto the same page's entry under it.
    window.history.replaceState(null, '', '/partners')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(back).toHaveBeenCalledTimes(1)
    // Only that once: a later Back is the person's own and goes where they ask.
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })

  it('a page that never pushed a sentinel leaves Back alone', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    render(<Guarded blocking={false} onAsk={vi.fn()} />)
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(back).not.toHaveBeenCalled()
    back.mockRestore()
  })
})

describe('navigations the app starts (leaveThen)', () => {
  it('go straight away with no guard, or a guard with nothing to lose', () => {
    const go = vi.fn()
    leaveThen({ kind: 'sign-out' }, go)
    expect(go).toHaveBeenCalledTimes(1)
    render(<Guarded blocking={false} onAsk={vi.fn()} />)
    leaveThen({ kind: 'sign-out' }, go)
    expect(go).toHaveBeenCalledTimes(2)
  })

  it('ask a blocking guard, and once the person proceeds the guard stops asking', () => {
    const onAsk = vi.fn()
    const { getByText } = render(<Guarded blocking onAsk={onAsk} />)
    const go = vi.fn()
    leaveThen({ kind: 'partner', name: 'AmOne' }, go)
    expect(go).not.toHaveBeenCalled()
    const request = onAsk.mock.calls[0][0] as LeaveRequest
    expect(request.destination).toEqual({ kind: 'partner', name: 'AmOne' })
    request.proceed()
    expect(go).toHaveBeenCalledTimes(1)
    // Released: a link click no longer asks.
    fireEvent.click(getByText('Workflows'))
    expect(onAsk).toHaveBeenCalledTimes(1)
  })
})

describe('a release does not outlive the draft it was given for', () => {
  it('when the page stays mounted after leaving (a link to itself), the next unsaved draft is guarded again', () => {
    const onAsk = vi.fn()
    const { getByText, rerender } = render(<Guarded blocking onAsk={onAsk} />)
    leaveThen({ kind: 'page', name: 'Partners' }, vi.fn())
    ;(onAsk.mock.calls[0][0] as LeaveRequest).proceed()
    // The draft was discarded and the page stayed; then the person edits again.
    rerender(<Guarded blocking={false} onAsk={onAsk} />)
    rerender(<Guarded blocking onAsk={onAsk} />)
    fireEvent.click(getByText('Workflows'))
    expect(onAsk).toHaveBeenCalledTimes(2)
    const e = unloadEvent()
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('auth redirects (holdAuthRedirect)', () => {
  it('are made when nothing would be lost, and held, with the page told, when something would', () => {
    expect(holdAuthRedirect(401)).toBe(false)
    const onAuthRejected = vi.fn()
    const { rerender } = render(<Guarded blocking onAsk={vi.fn()} onAuthRejected={onAuthRejected} />)
    expect(holdAuthRedirect(401)).toBe(true)
    expect(onAuthRejected).toHaveBeenCalledWith(401)
    rerender(<Guarded blocking={false} onAsk={vi.fn()} onAuthRejected={onAuthRejected} />)
    expect(holdAuthRedirect(403)).toBe(false)
  })
})
