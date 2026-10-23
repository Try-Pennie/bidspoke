/**
 * The pure halves of Sign in with Google (#2338, build PR 13; R17, "My own
 * Google account, Signed in as you"): the bodies the two routes read, the PKCE
 * pair, the redirect URI, the authorize link, and the sentence each refusal
 * says. The routes (routes/api/connections.ts) hold the order and the calls.
 *
 * WHERE EACH HALF RUNS (Dan's decision of 2026-10-22). The bidding Worker
 * starts the sign in and finishes it, since it holds the signed in person's
 * JWT and the state, and seals the new login's client id; the ops Worker
 * holds the sign in app's secret and makes the code exchange
 * (OpsConnections.exchangeOAuthCode). The bidding Worker never holds the
 * secret, and the authorize link names only the app's public client id
 * (OpsConnections.signInClient).
 *
 * Google sends the browser back to the Connections page's callback, a page of
 * the web app, which posts the code and state here with the person's JWT, so
 * the finish is held to both the state and the signed in person.
 */
import { CATALOGUE, googleDelegationScopes } from '@bidspoke/service-catalogue/schema'

/** Google's authorize endpoint (Google Identity, OAuth 2.0 for Web Server Applications). */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Where the web app takes the person after Google: the Connections page's sign in return. */
export const GOOGLE_SIGN_IN_CALLBACK_PATH = '/connections/google/callback'

/**
 * What the person is asked to allow: who they are (openid, email), so the
 * connection names whom it acts as, and the catalogue's Google scopes, the
 * same four a company mailbox is granted, since the same actions run as either.
 */
export function googleSignInScopes(): string[] {
  return ['openid', 'email', ...googleDelegationScopes(CATALOGUE)]
}

/** The redirect URI: the web app's origin (APP_URL) and the callback page. Null unless https. */
export function googleRedirectUri(appUrl: string | undefined): string | null {
  if (typeof appUrl !== 'string') return null
  try {
    const url = new URL(appUrl.trim())
    return url.protocol === 'https:' ? `${url.origin}${GOOGLE_SIGN_IN_CALLBACK_PATH}` : null
  } catch {
    return null
  }
}

function base64url(bytes: Uint8Array): string {
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE verifier: 32 random bytes, 43 base64url characters (RFC 7636 4.1). */
export function pkceVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Its S256 challenge (RFC 7636 4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

export interface AuthorizeLink {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  /** The account Google offers first: the person's own email, or the account a Reconnect signed in as. */
  loginHint: string | null
}

/**
 * The link the browser is sent to. access_type offline with prompt consent, so
 * Google answers a refresh token every time, a Reconnect included (it answers
 * one only on a consent).
 */
export function googleAuthorizeUrl(link: AuthorizeLink): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', link.clientId)
  url.searchParams.set('redirect_uri', link.redirectUri)
  url.searchParams.set('scope', googleSignInScopes().join(' '))
  url.searchParams.set('state', link.state)
  url.searchParams.set('code_challenge', link.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  if (link.loginHint) url.searchParams.set('login_hint', link.loginHint)
  return url.toString()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const MAX_BODY = 8192

function parse(text: string): Record<string, unknown> | string {
  if (text.length > MAX_BODY) return `the body is over ${MAX_BODY} bytes`
  try {
    const raw = JSON.parse(text) as unknown
    return isRecord(raw) ? raw : 'the body is not an object'
  } catch {
    return 'the body is not JSON'
  }
}

/** POST /google/sign-in: a new connection's name, or the connection a Reconnect signs in again. */
export type SignInStartBody = { ok: true; kind: 'new'; name: string } | { ok: true; kind: 'reconnect'; connectionId: string } | { ok: false; problem: string }

export function readSignInStartBody(text: string): SignInStartBody {
  const r = parse(text)
  if (typeof r === 'string') return { ok: false, problem: r }
  const extra = Object.keys(r).filter((k) => k !== 'name' && k !== 'connection_id')
  if (extra.length > 0) return { ok: false, problem: 'the body holds a key a sign in does not read' }
  if (r.connection_id !== undefined) {
    if (r.name !== undefined) return { ok: false, problem: 'the body names both a new connection and one to reconnect' }
    if (typeof r.connection_id !== 'string' || !UUID.test(r.connection_id)) return { ok: false, problem: 'connection_id is not a uuid' }
    return { ok: true, kind: 'reconnect', connectionId: r.connection_id.toLowerCase() }
  }
  const name = r.name ?? ''
  if (typeof name !== 'string') return { ok: false, problem: 'name is not text' }
  return { ok: true, kind: 'new', name }
}

/** POST /google/sign-in/finish: what Google put on the callback's address. */
export type SignInFinishBody = { ok: true; state: string; code: string | null; error: string | null } | { ok: false; problem: string }

/** Google's error codes are short names (access_denied); anything else is kept as unknown, never echoed. */
const GOOGLE_ERROR = /^[a-z_]{1,64}$/

export function readSignInFinishBody(text: string): SignInFinishBody {
  const r = parse(text)
  if (typeof r === 'string') return { ok: false, problem: r }
  const extra = Object.keys(r).filter((k) => !['state', 'code', 'error'].includes(k))
  if (extra.length > 0) return { ok: false, problem: 'the body holds a key a sign in does not read' }
  if (typeof r.state !== 'string' || !UUID.test(r.state)) return { ok: false, problem: 'state is not one Bidspoke issues' }
  const code = r.code ?? null
  const error = r.error ?? null
  if (code !== null && (typeof code !== 'string' || code === '' || code.length > 4096)) return { ok: false, problem: 'code is not text of 1 to 4096 characters' }
  if (error !== null && typeof error !== 'string') return { ok: false, problem: 'error is not text' }
  if ((code === null) === (error === null)) return { ok: false, problem: 'the body carries neither a code nor an error, or both' }
  return { ok: true, state: r.state.toLowerCase(), code, error: error === null ? null : GOOGLE_ERROR.test(error) ? error : 'unknown' }
}

// ── What each refusal says (R14's pattern: what failed, what was saved, what to do) ──

export const SIGN_IN_REFUSAL_CODES = [
  /** The body is not one the page sends. */
  'sign_in_request_invalid',
  /** The ops Worker holds no sign in app yet (OpsConnections.signInClient: sign_in_app_unset). */
  'google_sign_in_unset',
  /** The ops Worker's sign in app cannot be read, or Google is not offered there. */
  'google_sign_in_misconfigured',
  /** The bidding Worker's APP_URL does not give an https redirect URI. */
  'google_sign_in_no_return',
  /** The state could not be written or claimed. */
  'google_sign_in_unavailable',
  /** The person did not allow Bidspoke (Google's access_denied). */
  'google_sign_in_denied',
  /** Google answered another error on the callback. */
  'google_sign_in_failed',
  /** The state is older than 10 minutes. */
  'google_sign_in_expired',
  /** The state was already used: a callback finished once already. */
  'google_sign_in_used',
  /** No state of this person: never started, another person's, or another organization's. */
  'google_sign_in_unknown',
  /** Google refused the code (expired, used, or another app's), so nothing was stored. */
  'google_code_refused',
  /** A Reconnect of a connection that is not signed in as a person, or not Google. */
  'google_sign_in_not_person',
  /** A Reconnect by someone other than the person the connection signs in as. */
  'google_sign_in_not_owner',
] as const
export type SignInRefusalCode = (typeof SIGN_IN_REFUSAL_CODES)[number]

const SENTENCES: Readonly<Record<SignInRefusalCode, string>> = {
  sign_in_request_invalid: 'The page sent something Bidspoke cannot read. Nothing was saved. Reload the page and sign in again.',
  google_sign_in_unset: 'Sign in with Google is not set up on Bidspoke yet. Nothing was saved. Ask Dan to set it up.',
  google_sign_in_misconfigured: 'Sign in with Google is set up wrongly on Bidspoke. Nothing was saved. Tell Dan.',
  google_sign_in_no_return: 'Bidspoke does not know where Google should send you back. Nothing was saved. Tell Dan.',
  google_sign_in_unavailable: 'Bidspoke\'s database did not answer. Nothing was saved. Sign in with Google again in a minute.',
  google_sign_in_denied: 'You did not allow Bidspoke into your Google account. Nothing was saved. Sign in with Google again and allow it to connect.',
  google_sign_in_failed: 'Google could not finish the sign in. Nothing was saved. Sign in with Google again.',
  google_sign_in_expired: 'The sign in took more than 10 minutes, so it has expired. Nothing was saved. Sign in with Google again.',
  google_sign_in_used: 'This sign in was already finished. Nothing more was saved. Open the Connections page to see the connection.',
  google_sign_in_unknown: 'Bidspoke did not start this sign in for you. Nothing was saved. Start it again from the Connections page.',
  google_code_refused: 'Google did not accept the sign in. Nothing was saved. Sign in with Google again.',
  google_sign_in_not_person: 'This connection is not signed in with a Google account, so it is not reconnected this way. Nothing was changed.',
  google_sign_in_not_owner: 'Only the person this connection signs in as can reconnect it. Nothing was changed. Ask them to reconnect it, or add your own.',
}

export function signInRefusalSentence(code: SignInRefusalCode): string {
  return SENTENCES[code]
}
