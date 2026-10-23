/**
 * The account a person signed in as (#2338, build PR 13; R17): read from the
 * OpenID id_token Google's token endpoint answers the code exchange with, which
 * the ConnectionTokenObject receives directly over TLS from the endpoint it
 * asked, so its issuer is the endpoint (OpenID Connect Core 3.1.3.7, item 6).
 */
import { describe, expect, it } from 'vitest'
import { idTokenAccount } from '../id-token-account'

const CLIENT = '1234-sign-in.apps.googleusercontent.com'
const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url(claims)}.c2lnbmF0dXJl`
const claims = (over: Record<string, unknown> = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, azp: CLIENT, sub: '1090', email: 'Dan@TryPennie.com', email_verified: true, ...over })

describe('idTokenAccount', () => {
  it('names the verified email of an id_token issued for this client, lower cased', () => {
    expect(idTokenAccount({ id_token: idToken(claims()) }, CLIENT)).toBe('dan@trypennie.com')
  })

  it('reads an audience given as a list holding the client', () => {
    expect(idTokenAccount({ id_token: idToken(claims({ aud: ['other', CLIENT] })) }, CLIENT)).toBe('dan@trypennie.com')
  })

  it.each([
    ['no id_token', {}],
    ['an id_token for another client', { id_token: idToken(claims({ aud: 'another-client' })) }],
    ['an unverified email', { id_token: idToken(claims({ email_verified: false })) }],
    ['no email', { id_token: idToken(claims({ email: undefined })) }],
    ['an email that is not one address', { id_token: idToken(claims({ email: 'a@b@c' })) }],
    ['a token that is not three parts', { id_token: 'not-a-jwt' }],
    ['a payload that is not JSON', { id_token: 'e30.bm90LWpzb24.c2ln' }],
    ['an id_token that is not text', { id_token: 42 }],
    ['an id_token past any real size', { id_token: `${'a'.repeat(20_000)}.b.c` }],
  ])('is null for %s, so the connection is saved with no one named rather than a wrong one', (_what, json) => {
    expect(idTokenAccount(json, CLIENT)).toBeNull()
  })

  it('reads email_verified given as the text Google once sent', () => {
    expect(idTokenAccount({ id_token: idToken(claims({ email_verified: 'true' })) }, CLIENT)).toBe('dan@trypennie.com')
  })
})
