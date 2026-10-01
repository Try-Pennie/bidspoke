import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../../index'
import { apiKeyAuth } from '../api-key-auth'

// ── Test app setup ────────────────────────────────────────────────────────────

function makeApp(apiKeyMap: string) {
  const app = new Hono<{ Bindings: Env }>()
  app.post('/test', apiKeyAuth, (c) => {
    const source = c.get('source')
    return c.json({ ok: true, source })
  })
  return {
    request: (headers: Record<string, string> = {}) =>
      app.request('/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
      }, { API_KEY_MAP: apiKeyMap } as unknown as Env),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('apiKeyAuth middleware', () => {
  const keyMap = JSON.stringify({
    'sk_valid_key_abc': 'website_form',
    'sk_owl_key_xyz': 'wallet_owl',
  })

  describe('valid key', () => {
    it('returns 200 and proceeds to handler', async () => {
      const { request } = makeApp(keyMap)
      const res = await request({ 'X-API-Key': 'sk_valid_key_abc' })
      expect(res.status).toBe(200)
    })

    it('sets the source variable from the key map', async () => {
      const { request } = makeApp(keyMap)
      const res = await request({ 'X-API-Key': 'sk_valid_key_abc' })
      const body = await res.json() as { source: string }
      expect(body.source).toBe('website_form')
    })

    it('maps different keys to different sources', async () => {
      const { request } = makeApp(keyMap)
      const res = await request({ 'X-API-Key': 'sk_owl_key_xyz' })
      const body = await res.json() as { source: string }
      expect(body.source).toBe('wallet_owl')
    })
  })

  // #1702: a bracket lookup on the parsed map also finds inherited members,
  // which are truthy, so these names passed auth and became the run's source.
  describe('a key that only exists on Object.prototype', () => {
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])(
      'returns 401 for X-API-Key: %s and never reaches the handler',
      async (name) => {
        const { request } = makeApp(keyMap)
        const res = await request({ 'X-API-Key': name })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Invalid API key' })
      }
    )
  })

  describe('missing key', () => {
    it('returns 401 when X-API-Key header is absent', async () => {
      const { request } = makeApp(keyMap)
      const res = await request()
      expect(res.status).toBe(401)
    })

    it('returns descriptive error message', async () => {
      const { request } = makeApp(keyMap)
      const res = await request()
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/missing/i)
    })
  })

  describe('invalid key', () => {
    it('returns 401 for an unrecognized key', async () => {
      const { request } = makeApp(keyMap)
      const res = await request({ 'X-API-Key': 'sk_totally_wrong' })
      expect(res.status).toBe(401)
    })

    it('returns descriptive error message', async () => {
      const { request } = makeApp(keyMap)
      const res = await request({ 'X-API-Key': 'sk_bad' })
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/invalid/i)
    })
  })

  describe('malformed API_KEY_MAP', () => {
    it('returns 500 when the secret is not valid JSON', async () => {
      const { request } = makeApp('not-valid-json')
      const res = await request({ 'X-API-Key': 'sk_valid_key_abc' })
      expect(res.status).toBe(500)
    })

    it('returns an internal configuration error', async () => {
      const { request } = makeApp('{broken')
      const res = await request({ 'X-API-Key': 'any' })
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/configuration/i)
    })

    it('logs the actual parse error so a corrupted secret is diagnosable (#316)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { request } = makeApp('{broken')
      await request({ 'X-API-Key': 'any' })
      expect(spy).toHaveBeenCalledTimes(1)
      // The log must carry the underlying SyntaxError detail, not just a generic
      // string — operators can't fix a corrupt API_KEY_MAP they can't see. The
      // generic message already says "...not valid JSON", so assert the actual
      // parse error (its distinctive wording / the bad input) is included too.
      const logged = spy.mock.calls[0].map(String).join(' ')
      expect(logged).toMatch(/API_KEY_MAP/)
      expect(logged).toMatch(/Unexpected|Expected|position|in JSON at/i)
    })
  })
})

afterEach(() => vi.restoreAllMocks())
