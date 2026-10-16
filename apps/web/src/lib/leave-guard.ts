'use client'

/**
 * The one leave guard of the app (#2138, PM-5, L247): every way away from a
 * page holding something unsaved is judged by the state it reaches, not by one
 * spelling of navigation. A page mounts `useLeaveGuard` while it can lose
 * something (a dirty draft, or a save whose outcome is not known yet), and:
 *
 * - a same origin link click anywhere in the app (the sidebar included) is
 *   held by one capture phase listener and asked about;
 * - browser back or forward is held by a sentinel history entry and a
 *   `popstate` handler, and asked about;
 * - a refresh or a closed tab gets the browser's own leave warning, because
 *   browsers allow no page dialog there and show their own fixed text;
 * - every navigation the app starts itself asks through `leaveThen` (the
 *   partner list, sign out), and the API client's 401 and 403 redirects ask
 *   `holdAuthRedirect` first, so an expired session keeps the draft on screen.
 *
 * lib/__guards__/leave-guard-navigation-guard.test.ts fails on a
 * router.push, router.replace, router.back or forward, history.back, forward
 * or go, or a change to location anywhere in apps/web/src outside this file
 * and an allowlist naming each site's reason.
 */
import { useEffect, useRef } from 'react'

/** Where the person was going, in the words the leave dialog names it by. */
export type LeaveDestination =
  /** Another partner chosen in the list. */
  | { kind: 'partner'; name: string }
  /** Another page or view of the app, by its link's name. */
  | { kind: 'page'; name: string }
  /** Closing the open partner. */
  | { kind: 'close' }
  /** Browser back. */
  | { kind: 'back' }
  | { kind: 'sign-out' }

export interface LeaveRequest {
  destination: LeaveDestination
  /** Goes where the person was going. The guard stops asking first. */
  proceed: () => void
}

export interface LeaveGuardOptions {
  /** Whether leaving now would lose something: a dirty draft, or a save not yet confirmed. */
  blocking: boolean
  /** Ask the person (the page's own dialog). Called only while blocking. */
  onAsk: (request: LeaveRequest) => void
  /** The API answered 401 or 403 while blocking: the redirect was held, so say why. */
  onAuthRejected?: (status: 401 | 403) => void
}

interface Registered {
  blocking: () => boolean
  ask: (request: LeaveRequest) => void
  authRejected: (status: 401 | 403) => void
  /** Stop asking: the person chose to leave. */
  release: () => void
}

const guards: Registered[] = []

/** The newest mounted guard that would lose something, or null. */
function blockingGuard(): Registered | null {
  for (let i = guards.length - 1; i >= 0; i--) if (guards[i].blocking()) return guards[i]
  return null
}

/**
 * Go somewhere the app chose (a partner in the list, sign out): straight away
 * when nothing would be lost, otherwise only once the person says so.
 */
export function leaveThen(destination: LeaveDestination, proceed: () => void): void {
  const guard = blockingGuard()
  if (!guard) {
    proceed()
    return
  }
  guard.ask({ destination, proceed: () => { guard.release(); proceed() } })
}

/**
 * Whether an auth redirect must wait (a 401 or 403 from the API). True when a
 * page would lose something: the redirect is not made, the page is told, and
 * it keeps the draft on screen with the reason.
 */
export function holdAuthRedirect(status: 401 | 403): boolean {
  const guard = blockingGuard()
  if (!guard) return false
  guard.authRejected(status)
  return true
}

/** The browser's own leave warning: raised only while something would be lost. */
export function beforeUnloadListener(blocking: () => boolean): (e: BeforeUnloadEvent) => void {
  return (e) => {
    if (!blocking()) return
    e.preventDefault()
    // Older browsers raise the warning only when returnValue is set.
    e.returnValue = ''
  }
}

const SENTINEL = '__bidspokeLeaveGuard'

function onSentinel(): boolean {
  const state: unknown = window.history.state
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[SENTINEL] === true
}

/**
 * A copy of the current entry on top of history, so browser back lands on the
 * page itself and can be asked about. The state is copied whole, so the App
 * Router's own fields go with it and it treats the entry as its own.
 */
function pushSentinel() {
  if (onSentinel()) return
  const state: unknown = window.history.state
  window.history.pushState({ ...(typeof state === 'object' && state !== null ? state : {}), [SENTINEL]: true }, '', window.location.href)
}

/** A link's name as the person read it: its accessible label, its text, or its path. */
function linkName(anchor: HTMLAnchorElement, url: URL): string {
  return anchor.getAttribute('aria-label')?.trim() || anchor.textContent?.trim() || url.pathname
}

/** The capture phase listener holding a same origin link click while the guard blocks. */
function linkClickListener(guard: Registered): (e: MouseEvent) => void {
  return (e) => {
    if (!guard.blocking()) return
    // A modified click opens a new tab or window, which loses nothing.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!(anchor instanceof HTMLAnchorElement)) return
    if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return
    const url = new URL(anchor.href, window.location.href)
    // Another site is a whole page load, which the browser's own warning covers.
    if (url.origin !== window.location.origin) return
    // A jump within this page (the skip link) goes nowhere.
    if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return
    e.preventDefault()
    e.stopPropagation()
    guard.ask({
      destination: { kind: 'page', name: linkName(anchor, url) },
      proceed: () => {
        guard.release()
        // The same click again, now let through, so a Next Link navigates on
        // the client as it would have; a link no longer on the page is followed.
        if (anchor.isConnected) anchor.click()
        else window.location.assign(url.href)
      },
    })
  }
}

/**
 * Mount while the page can lose something. `blocking` is read on every event,
 * so it is always current; the history sentinel and the browser's warning are
 * armed only while it is true.
 */
export function useLeaveGuard({ blocking, onAsk, onAuthRejected }: LeaveGuardOptions): void {
  const blockingRef = useRef(blocking)
  blockingRef.current = blocking
  const onAskRef = useRef(onAsk)
  onAskRef.current = onAsk
  const onAuthRef = useRef(onAuthRejected)
  onAuthRef.current = onAuthRejected
  const leaving = useRef(false)
  const guardRef = useRef<Registered | null>(null)
  if (guardRef.current === null) {
    guardRef.current = {
      blocking: () => blockingRef.current && !leaving.current,
      ask: (request) => onAskRef.current(request),
      authRejected: (status) => onAuthRef.current?.(status),
      release: () => { leaving.current = true },
    }
  }

  useEffect(() => {
    const guard = guardRef.current!
    guards.push(guard)
    const onClick = linkClickListener(guard)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      const at = guards.indexOf(guard)
      if (at >= 0) guards.splice(at, 1)
    }
  }, [])

  useEffect(() => {
    if (!blocking) return
    // Something new would be lost: a release given for an earlier leave (whose
    // navigation kept this page, a link to itself, say) no longer stands.
    leaving.current = false
    const guard = guardRef.current!
    const onUnload = beforeUnloadListener(guard.blocking)
    window.addEventListener('beforeunload', onUnload)
    pushSentinel()
    const onPop = () => {
      if (!guard.blocking()) return
      // Back moved off the sentinel: put it back so the person stays, then ask.
      // A back pressed while the dialog is open lands here too, and the dialog
      // shell maps it to Keep editing.
      pushSentinel()
      guard.ask({ destination: { kind: 'back' }, proceed: () => { guard.release(); window.history.go(-2) } })
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('popstate', onPop)
    }
  }, [blocking])
}
