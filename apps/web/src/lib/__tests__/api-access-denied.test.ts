/**
 * #326 follow-up: the Worker API now returns 403 when a valid token belongs to
 * a user who is no longer on the access allowlist (e.g. removed mid-session).
 * The client treats 401 as "not authenticated" -> /login; a 403 means
 * "authenticated but not authorized" -> /access-denied, matching the browser
 * middleware gate, instead of surfacing a raw "API 403" error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api } from '../api'

function mock403() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 403,
    headers: { get: () => null },
    text: async () => 'Access denied',
    json: async () => ({ error: 'Access denied' }),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('403 from the API redirects a removed user to /access-denied (#326)', () => {
  it('redirects on the shared req() path (e.g. workflows.list)', async () => {
    const loc = { href: '' }
    vi.stubGlobal('window', { location: loc })
    vi.stubGlobal('fetch', mock403())
    await expect(api.workflows.list()).rejects.toThrow()
    expect(loc.href).toBe('/access-denied')
  })

  it('redirects on the inline executions.replay path', async () => {
    const loc = { href: '' }
    vi.stubGlobal('window', { location: loc })
    vi.stubGlobal('fetch', mock403())
    await expect(api.executions.replay('e1')).rejects.toThrow()
    expect(loc.href).toBe('/access-denied')
  })
})
