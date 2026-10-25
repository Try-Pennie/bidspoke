/**
 * Google's return from Sign in with Google (#2338, build PR 13). Dan's decision
 * D1 of 2026-10-23: there is no page of its own. The callback route, the
 * redirect URI the sign in app names, only hands what Google put on its address
 * to the Connections page, which finishes the sign in in the add form (or the
 * Reconnect dialog) the person left: the working line under its buttons while
 * it runs, the new connection opened when it is saved, the reason in red
 * (FieldError, D2) when it is not.
 */

/** The finish's body: Google's code, or its error, with the state it carried. */
export type SignInFinishBody = { state: string; code: string } | { state: string; error: string }

/** What came back: the state, when Google carried one, and the finish to post, when there is one. */
export interface SignInReturn {
  state: string | null
  body: SignInFinishBody | null
}

/** When the address holds no sign in: opened by hand, or Google sent nothing. */
export const NO_SIGN_IN = 'This page holds no sign in to finish. Nothing was saved. Sign in with Google again.'

/** The working line's words while the finish runs (D1). */
export const FINISHING_LABEL = 'Finishing the sign in with Google'

type Params = { get(name: string): string | null } | null

/** What Google put on the callback's address, read once. */
export function signInReturnOf(params: Params): SignInReturn {
  const state = params?.get('state') || null
  const code = params?.get('code') || ''
  const error = params?.get('error') || ''
  if (state === null) return { state: null, body: null }
  if (code !== '') return { state, body: { state, code } }
  if (error !== '') return { state, body: { state, error } }
  return { state, body: null }
}

/** Where the callback sends the browser: the Connections page, carrying only Google's state and its code or error. */
export function signInReturnHref(params: Params): string {
  const ret = signInReturnOf(params)
  const q = new URLSearchParams({ google_sign_in: 'return' })
  if (ret.state !== null) q.set('state', ret.state)
  if (ret.body && 'code' in ret.body) q.set('code', ret.body.code)
  if (ret.body && 'error' in ret.body) q.set('error', ret.body.error)
  return `/connections?${q.toString()}`
}

/** The return the Connections page was opened with, or null when it was not opened from Google. */
export function connectionsSignInReturn(params: Params): SignInReturn | null {
  return params?.get('google_sign_in') === 'return' ? signInReturnOf(params) : null
}
