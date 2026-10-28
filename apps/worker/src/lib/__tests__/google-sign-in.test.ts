/**
 * The pure halves of Sign in with Google (#2338, build PR 13; R17).
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE, googleDelegationScopes } from '@bidspoke/service-catalogue/schema'
import {
  GOOGLE_AUTHORIZE_URL, SIGN_IN_REFUSAL_CODES, googleAuthorizeUrl, googleRedirectUri, googleSignInScopes, pkceChallenge, pkceVerifier, readSignInFinishBody,
  readSignInStartBody, signInRefusalSentence,
} from '../google-sign-in'

const STATE = '5e6c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
const CONN = 'c0000000-0000-4000-8000-000000000001'

describe('the authorize link', () => {
  it('asks who the person is and the catalogue\'s Google scopes, the ones a company mailbox is granted', () => {
    expect(googleSignInScopes()).toEqual(['openid', 'email', ...googleDelegationScopes(CATALOGUE)])
    expect(googleSignInScopes()).toHaveLength(6)
  })

  it('names the app\'s client id, the redirect, the state and an S256 challenge, offline with consent so a refresh token always comes', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: 'app.apps.googleusercontent.com', redirectUri: 'https://bidspoke.trypennie.dev/connections/google/callback', state: STATE, challenge: 'chal', loginHint: 'dan@trypennie.com' }))
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'app.apps.googleusercontent.com', redirect_uri: 'https://bidspoke.trypennie.dev/connections/google/callback',
      scope: googleSignInScopes().join(' '), state: STATE, code_challenge: 'chal', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
      login_hint: 'dan@trypennie.com',
    })
    // Never a secret: the bidding Worker holds none to send.
    expect(url.searchParams.has('client_secret')).toBe(false)
  })

  it('leaves the hint out when there is none', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: 'a', redirectUri: 'https://x.example/cb', state: STATE, challenge: 'c', loginHint: null }))
    expect(url.searchParams.has('login_hint')).toBe(false)
  })

  it('returns to the Connections page on the app\'s own https origin, and to nothing else', () => {
    expect(googleRedirectUri('https://bidspoke.trypennie.dev')).toBe('https://bidspoke.trypennie.dev/connections/google/callback')
    expect(googleRedirectUri('https://bidspoke.trypennie.dev/some/path')).toBe('https://bidspoke.trypennie.dev/connections/google/callback')
    expect(googleRedirectUri('http://bidspoke.trypennie.dev')).toBeNull()
    expect(googleRedirectUri('not a url')).toBeNull()
    expect(googleRedirectUri(undefined)).toBeNull()
  })

  it('makes a 43 character verifier, fresh each time, and its RFC 7636 challenge', async () => {
    const v = pkceVerifier()
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkceVerifier()).not.toBe(v)
    // RFC 7636 appendix B's own example.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('the start body', () => {
  it('reads a new connection\'s name, or the connection a Reconnect signs in again', () => {
    expect(readSignInStartBody(JSON.stringify({ name: 'My Google' }))).toEqual({ ok: true, kind: 'new', name: 'My Google' })
    expect(readSignInStartBody(JSON.stringify({ connection_id: CONN.toUpperCase() }))).toEqual({ ok: true, kind: 'reconnect', connectionId: CONN })
    expect(readSignInStartBody('{}')).toEqual({ ok: true, kind: 'new', name: '' })
  })

  it.each([
    ['not JSON', 'nope'],
    ['an organization', JSON.stringify({ name: 'x', organization_id: CONN })],
    ['both', JSON.stringify({ name: 'x', connection_id: CONN })],
    ['a connection id that is not a uuid', JSON.stringify({ connection_id: 'abc' })],
    ['a name that is not text', JSON.stringify({ name: 7 })],
  ])('refuses %s', (_what, text) => {
    expect(readSignInStartBody(text).ok).toBe(false)
  })
})

describe('the finish body', () => {
  it('reads the state with Google\'s code, or with Google\'s error', () => {
    expect(readSignInFinishBody(JSON.stringify({ state: STATE, code: '4/0Ab' }))).toEqual({ ok: true, state: STATE, code: '4/0Ab', error: null })
    expect(readSignInFinishBody(JSON.stringify({ state: STATE, error: 'access_denied' }))).toEqual({ ok: true, state: STATE, code: null, error: 'access_denied' })
  })

  it('keeps an error that is not one of Google\'s short names as unknown, never echoing it', () => {
    expect(readSignInFinishBody(JSON.stringify({ state: STATE, error: '<script>' }))).toMatchObject({ ok: true, error: 'unknown' })
  })

  it.each([
    ['no state', JSON.stringify({ code: 'c' })],
    ['a state Bidspoke never issues', JSON.stringify({ state: 'x', code: 'c' })],
    ['neither code nor error', JSON.stringify({ state: STATE })],
    ['both', JSON.stringify({ state: STATE, code: 'c', error: 'access_denied' })],
    ['an empty code', JSON.stringify({ state: STATE, code: '' })],
    ['another key', JSON.stringify({ state: STATE, code: 'c', user_id: CONN })],
  ])('refuses %s', (_what, text) => {
    expect(readSignInFinishBody(text).ok).toBe(false)
  })
})

describe('the sentences', () => {
  it.each([...SIGN_IN_REFUSAL_CODES])('%s says what failed, what was saved, and is its own', (code) => {
    const s = signInRefusalSentence(code)
    expect(s).toMatch(/Nothing (was saved|more was saved|was changed)\./)
    expect(SIGN_IN_REFUSAL_CODES.filter((c) => signInRefusalSentence(c) === s)).toEqual([code])
  })

  // The stored login is read before anything is tried, so the sentence claims no login worked (L11, #2926).
  it('an unreadable stored login says only that it could not be read, and sends the person to Dan', () => {
    const s = signInRefusalSentence('google_sign_in_login_unreadable')
    expect(s).not.toMatch(/worked|could not store/)
    expect(s).toMatch(/cannot read the login it keeps/)
    expect(s).toMatch(/Tell Dan, since this is a fault in Bidspoke\.$/)
  })

  it('denied consent, an expired state and a refused code each say a different thing', () => {
    const words = (['google_sign_in_denied', 'google_sign_in_expired', 'google_code_refused'] as const).map((c) => signInRefusalSentence(c))
    expect(new Set(words).size).toBe(3)
    expect(words[0]).toMatch(/did not allow/)
    expect(words[1]).toMatch(/10 minutes/)
  })
})
