/**
 * .github/scripts/e2e-session.mjs: the one password grant sign in the deploy
 * checks share (partners-page-commit.mjs, ops-connections-probe.mjs; #2335).
 */
import { describe, expect, it } from 'vitest'
import { passwordSession } from '../../../../../.github/scripts/e2e-session.mjs'

describe('passwordSession', () => {
  it('posts the password grant to the auth API and answers the session, with expires_at filled from expires_in', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ access_token: 'session-access-token-value', expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof fetch
    const session = await passwordSession(fetchFn, 'https://project.supabase.co/', 'anon-key-value', 'e2e@example.com', 'e2e-password-value')
    expect(session.access_token).toBe('session-access-token-value')
    expect(session.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(seen[0].url).toBe('https://project.supabase.co/auth/v1/token?grant_type=password')
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ email: 'e2e@example.com', password: 'e2e-password-value' })
  })

  it('throws naming the status and the auth API\'s own description when sign in is refused', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error_description: 'Invalid login credentials' }), { status: 400 })) as unknown as typeof fetch
    await expect(passwordSession(fetchFn, 'https://project.supabase.co', 'anon-key-value', 'e2e@example.com', 'wrong')).rejects.toThrow('the auth API answered 400: Invalid login credentials')
  })

  it('throws on a 200 that carries no access token, rather than signing in as nobody', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(passwordSession(fetchFn, 'https://project.supabase.co', 'anon-key-value', 'e2e@example.com', 'x')).rejects.toThrow('the auth API answered 200')
  })
})
