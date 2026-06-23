/**
 * JWT auth middleware — PRD Section 1.3
 * Covers: missing/malformed header, token verification, user lookup,
 * display name extraction from user_metadata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../jwt-auth'

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

vi.mock('../../lib/jwt')
vi.mock('../../lib/supabase')

import { verifyJwt } from '../../lib/jwt'
import { createSupabaseClient } from '../../lib/supabase'
import { jwtAuth } from '../jwt-auth'

// ── Supabase mock ─────────────────────────────────────────────────────────────

function makeSupabase(
  user: Record<string, unknown> | null,
  opts: { allowlisted?: boolean; allowlistError?: boolean } = {}
) {
  const { allowlisted = true, allowlistError = false } = opts
  function chainFor(table: string): unknown {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () =>
          user
            ? Promise.resolve({ data: user, error: null })
            : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
        if (prop === 'maybeSingle') return () => {
          if (table !== 'user_allowlist') return Promise.resolve({ data: null, error: null })
          if (allowlistError) return Promise.resolve({ data: null, error: { message: 'db down', code: '500' } })
          const email = (user as { email?: string } | null)?.email ?? ''
          return Promise.resolve({ data: allowlisted ? { email } : null, error: null })
        }
        return () => chain
      }
    })
    return chain
  }
  return { from: (table: string) => chainFor(table) }
}

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
  app.get('/test', jwtAuth, (c) => c.json({ user: c.get('user') }))
  return (headers: Record<string, string> = {}) =>
    app.request('/test', { headers }, { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env)
}

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('jwtAuth middleware', () => {
  const request = makeApp()

  beforeEach(() => vi.clearAllMocks())

  describe('Authorization header validation', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request()
      expect(res.status).toBe(401)
    })

    it('returns 401 for a non-Bearer scheme', async () => {
      const res = await request({ Authorization: 'Basic dXNlcjpwYXNz' })
      expect(res.status).toBe(401)
    })

    it('returns 401 for "Bearer" with no token', async () => {
      // verifyJwt will throw on empty string
      vi.mocked(verifyJwt).mockRejectedValue(new Error('Invalid JWT'))
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(null) as unknown as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer ' })
      expect(res.status).toBe(401)
    })
  })

  describe('token verification', () => {
    it('returns 401 when verifyJwt throws (invalid signature)', async () => {
      vi.mocked(verifyJwt).mockRejectedValue(new Error('Invalid JWT signature'))
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(null) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer bad.token.here' })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/invalid|expired/i)
    })

    it('returns 401 when verifyJwt throws (expired)', async () => {
      vi.mocked(verifyJwt).mockRejectedValue(new Error('JWT expired'))
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(null) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer expired.token' })
      expect(res.status).toBe(401)
    })
  })

  describe('user lookup', () => {
    it('returns 401 when user is not found in the database', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-ghost', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(null) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/user not found/i)
    })
  })

  describe('allowlist enforcement', () => {
    it('returns 403 when the authenticated user is not on the allowlist', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser, { allowlisted: false }) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/access denied|not authorized/i)
    })

    it('allows a user who is on the allowlist', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser, { allowlisted: true }) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(200)
    })

    it('returns 500 (not a false deny) when the allowlist lookup itself errors', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser, { allowlistError: true }) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(500)
    })
  })

  describe('display name extraction', () => {
    it('extracts name from user_metadata.full_name', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: 'user-1', exp: 9999999999, iat: 0, aud: 'test',
        user_metadata: { full_name: 'Dan Hankins-Wright' },
      })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(200)
      const body = await res.json() as { user: { name: string } }
      expect(body.user.name).toBe('Dan Hankins-Wright')
    })

    it('falls back to user_metadata.name when full_name is absent', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: 'user-1', exp: 9999999999, iat: 0, aud: 'test',
        user_metadata: { name: 'Dan' },
      })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(200)
      const body = await res.json() as { user: { name: string | null } }
      expect(body.user.name).toBe('Dan')
    })

    it('sets name to null when user_metadata is absent', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(200)
      const body = await res.json() as { user: { name: string | null } }
      expect(body.user.name).toBeNull()
    })
  })

  describe('happy path', () => {
    it('sets userId, orgId, and email on the context', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser) as unknown as ReturnType<typeof createSupabaseClient>)
      const res = await request({ Authorization: 'Bearer valid.token' })
      expect(res.status).toBe(200)
      const body = await res.json() as { user: { userId: string; orgId: string; email: string } }
      expect(body.user.userId).toBe('user-1')
      expect(body.user.orgId).toBe('org-abc')
      expect(body.user.email).toBe('dan@pennie.com')
    })

    it('calls verifyJwt with the token and JWKS URL from env', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', exp: 9999999999, iat: 0, aud: 'test' })
      vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase(testUser) as unknown as ReturnType<typeof createSupabaseClient>)
      await request({ Authorization: 'Bearer my.actual.token' })
      expect(vi.mocked(verifyJwt)).toHaveBeenCalledWith('my.actual.token', 'https://fake.jwks')
    })
  })
})
