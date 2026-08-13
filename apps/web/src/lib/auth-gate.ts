import { isPermittedDomain } from './auth-allowlist'
import { isPublicPath } from './public-paths'

/**
 * The login gate's decision, as a pure function (#728).
 *
 * It used to live inline in middleware.ts, where it could not be unit tested,
 * and the only test of it asserted that /workflows ends at /login. That passes
 * with the middleware deleted, because the API client redirects to /login on any
 * 401: the assertion observed the union of three separate gates and could not
 * tell which one acted. Being unable to distinguish "the gate ran and allowed"
 * from "the gate never ran" is the failure mode itself, so every outcome now
 * carries its own value on a response header.
 */

export const GATE_HEADER = 'x-bidspoke-gate'

/**
 * The result of reading the allowlist. `error` is a distinct state on purpose:
 * the read used to be destructured as `{ data: entry }` with the error dropped,
 * so a failed lookup silently became a genuine denial and sent a real employee
 * to /access-denied with nothing saying why.
 */
export type AllowlistLookup =
  | { status: 'found' }
  | { status: 'absent' }
  | { status: 'error'; message: string }

export type GateValue =
  | 'allow'
  | 'redirect-login'
  | 'redirect-domain'
  | 'redirect-not-allowlisted'
  | 'gate-unavailable'
  | 'redirect-signed-in'

export type GateDecision =
  | { action: 'allow'; gate: GateValue }
  | { action: 'redirect'; pathname: string; search: string | null; gate: GateValue }

export interface GateInput {
  pathname: string
  /** The signed-in user's email, or null when there is no session. */
  email: string | null
  /** Only consulted on a protected path for a permitted domain. */
  allowlist: AllowlistLookup
}

export function decideGate({ pathname, email, allowlist }: GateInput): GateDecision {
  const publicPath = isPublicPath(pathname)
  const signedIn = email !== null

  if (!signedIn) {
    return publicPath
      ? { action: 'allow', gate: 'allow' }
      : { action: 'redirect', pathname: '/login', search: null, gate: 'redirect-login' }
  }

  // A signed-in user has no reason to be on the login page.
  if (pathname.startsWith('/login')) {
    return { action: 'redirect', pathname: '/workflows', search: null, gate: 'redirect-signed-in' }
  }

  // The remaining public paths (/auth/**, /access-denied, /docs, /llms.txt) are
  // reachable either way, and /access-denied MUST stay reachable or a refusal
  // would have nowhere terminal to land.
  if (publicPath) return { action: 'allow', gate: 'allow' }

  // The domain rule is the one that cannot be relaxed through the UI, so it is
  // checked before the allowlist and through the shared helper rather than a
  // second inlined copy of the suffix test.
  if (!isPermittedDomain(email)) {
    return { action: 'redirect', pathname: '/access-denied', search: null, gate: 'redirect-domain' }
  }

  if (allowlist.status === 'error') {
    // Fail closed, and say which kind of closed. /access-denied is a public path,
    // so it is terminal: this cannot loop. Redirecting to /login would loop
    // instead, because /login is public and the allowlist is never read there,
    // so the error state never recurs to break the cycle.
    return {
      action: 'redirect',
      pathname: '/access-denied',
      search: 'reason=gate_unavailable',
      gate: 'gate-unavailable',
    }
  }

  if (allowlist.status === 'absent') {
    return { action: 'redirect', pathname: '/access-denied', search: null, gate: 'redirect-not-allowlisted' }
  }

  return { action: 'allow', gate: 'allow' }
}
