/**
 * The OAuth apps the ops Worker holds for person bound logins (#2338, build PR
 * 13; Dan's decision of 2026-10-22): the Google sign in app's client JSON is the
 * ops Worker's own secret, GOOGLE_OAUTH_CLIENT, and nothing else reads it.
 */
import { describe, expect, it } from 'vitest'
import { OPS_ALLOWED_SECRETS } from '../../../lib/secret-lists'
import { GOOGLE_TOKEN_URI } from '../minters/google'
import { OPS_OAUTH_APPS, clientFor, oauthAppOf } from '../oauth-apps'

const CLIENT_ID = '1234-sign-in.apps.googleusercontent.com'
const SECRET = 'GOCSPX-app-secret-canary-2338'
const web = (over: Record<string, unknown> = {}) => JSON.stringify({
  web: { client_id: CLIENT_ID, project_id: 'bidspoke-ops', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: GOOGLE_TOKEN_URI, client_secret: SECRET, ...over },
})

describe('oauthAppOf: the sign in app the ops Worker holds for a service', () => {
  it('reads Google\'s app from the client JSON Google Cloud downloads, as it downloads it', () => {
    expect(oauthAppOf({ GOOGLE_OAUTH_CLIENT: web() }, 'google')).toEqual({ kind: 'app', clientId: CLIENT_ID, clientSecret: SECRET })
  })

  it('reads the same two fields written flat', () => {
    expect(oauthAppOf({ GOOGLE_OAUTH_CLIENT: JSON.stringify({ client_id: CLIENT_ID, client_secret: SECRET }) }, 'google')).toEqual({ kind: 'app', clientId: CLIENT_ID, clientSecret: SECRET })
  })

  it.each([
    ['unset', undefined],
    ['blank', '  '],
  ])('names the secret when it is %s', (_what, value) => {
    expect(oauthAppOf({ GOOGLE_OAUTH_CLIENT: value }, 'google')).toEqual({ kind: 'unset', secret: 'GOOGLE_OAUTH_CLIENT' })
  })

  it.each([
    ['not JSON', 'GOCSPX-just-the-secret'],
    ['a desktop client, which cannot redirect to the Connections page', JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: SECRET } })],
    ['missing its secret', web({ client_secret: undefined })],
    ['missing its client id', web({ client_id: '' })],
    ['naming another token endpoint', web({ token_uri: 'https://evil.example/token' })],
    ['a list', JSON.stringify([CLIENT_ID, SECRET])],
  ])('is malformed when the secret is %s, and never says what it holds', (_what, value) => {
    const read = oauthAppOf({ GOOGLE_OAUTH_CLIENT: value }, 'google')
    expect(read).toEqual({ kind: 'malformed', secret: 'GOOGLE_OAUTH_CLIENT' })
    expect(JSON.stringify(read)).not.toContain('GOCSPX')
  })

  it('a service with no app on this Worker has none, an inherited key included', () => {
    expect(oauthAppOf({ GOOGLE_OAUTH_CLIENT: web() }, 'salesforce')).toEqual({ kind: 'none' })
    expect(oauthAppOf({ GOOGLE_OAUTH_CLIENT: web() }, 'constructor')).toEqual({ kind: 'none' })
  })

  it('every app\'s secret is one the ops Worker may hold, so setting it never turns the secret parity step red', () => {
    for (const app of Object.values(OPS_OAUTH_APPS)) expect(OPS_ALLOWED_SECRETS).toContain(app.secret)
  })
})

describe('clientFor: the client a token request names', () => {
  const app = { kind: 'app', clientId: CLIENT_ID, clientSecret: SECRET } as const

  it('a service with an app on ops sends the login\'s client id with the app\'s secret', () => {
    expect(clientFor({ client_id: CLIENT_ID, refresh_token: 'r' }, app)).toEqual({ ok: true, clientId: CLIENT_ID, clientSecret: SECRET })
  })

  it('a service with no app sends the login\'s own client, with its secret when it has one', () => {
    expect(clientFor({ client_id: 'other', client_secret: 's' }, { kind: 'none' })).toEqual({ ok: true, clientId: 'other', clientSecret: 's' })
    expect(clientFor({ client_id: 'public' }, { kind: 'none' })).toEqual({ ok: true, clientId: 'public', clientSecret: null })
  })

  it('a login carrying its own secret for a service whose secret lives on ops is malformed: the bidding Worker never holds it', () => {
    expect(clientFor({ client_id: CLIENT_ID, client_secret: 'sealed-by-bidding' }, app)).toEqual({ ok: false, kind: 'refused', reason: 'login_malformed', retryAtMs: null })
  })

  it('a login signed in through another app than the one ops holds is refused, so a person signs in again', () => {
    expect(clientFor({ client_id: 'an-older-app' }, app)).toEqual({ ok: false, kind: 'refused', reason: 'client_id_mismatch', retryAtMs: null })
  })

  it('an app unset or unreadable on ops refuses by rule: the login is not at fault', () => {
    expect(clientFor({ client_id: CLIENT_ID }, { kind: 'unset', secret: 'GOOGLE_OAUTH_CLIENT' })).toEqual({ ok: false, kind: 'not_allowed', reason: 'oauth_app_unset', retryAtMs: null })
    expect(clientFor({ client_id: CLIENT_ID }, { kind: 'malformed', secret: 'GOOGLE_OAUTH_CLIENT' })).toEqual({ ok: false, kind: 'not_allowed', reason: 'oauth_app_malformed', retryAtMs: null })
  })
})
