/**
 * The API client's 401 and 403 redirects ask the leave guard first (#2138,
 * PM-5): while a page holds a draft or a save not yet confirmed, the redirect
 * is not made, and the error carries its status so the page can say the
 * session expired rather than that the request got no answer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

let session: { access_token: string } | null = { access_token: 'tok' }
vi.mock('../supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }),
}))
vi.mock('../leave-guard', () => ({ holdAuthRedirect: vi.fn() }))

import { api } from '../api'
import { holdAuthRedirect } from '../leave-guard'

const answer = (status: number) => vi.fn().mockResolvedValue({ ok: false, status, headers: { get: () => null }, text: async () => '', json: async () => ({}) })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(holdAuthRedirect).mockReset()
  session = { access_token: 'tok' }
})

describe('auth redirects consult the leave guard (#2138)', () => {
  for (const [status, page] of [[401, '/login'], [403, '/access-denied']] as const) {
    it(`a ${status} is not redirected while the guard holds it, and the error carries ${status}`, async () => {
      const loc = { href: '/partners' }
      vi.stubGlobal('window', { location: loc })
      vi.stubGlobal('fetch', answer(status))
      vi.mocked(holdAuthRedirect).mockReturnValue(true)
      const err = await api.partners.versions('p1').catch((e: unknown) => e)
      expect(holdAuthRedirect).toHaveBeenCalledWith(status)
      expect(loc.href).toBe('/partners')
      expect((err as { status?: number }).status).toBe(status)
    })

    it(`a ${status} redirects to ${page} when nothing would be lost`, async () => {
      const loc = { href: '/partners' }
      vi.stubGlobal('window', { location: loc })
      vi.stubGlobal('fetch', answer(status))
      vi.mocked(holdAuthRedirect).mockReturnValue(false)
      await expect(api.partners.versions('p1')).rejects.toThrow()
      expect(loc.href).toBe(page)
    })
  }

  // A development preview (/dev/..., 404 in a production build) draws real components with no
  // session by design, such as the canvas around a step's Connection field (#2338 build PR 11):
  // a call one of them makes still fails as a 401, but the preview is never sent to sign in.
  it('a development preview is not sent to sign in, and the call still fails as a 401', async () => {
    session = null
    const loc = { href: 'http://localhost:3111/dev/connection-field?frame=step-healthy', pathname: '/dev/connection-field' }
    vi.stubGlobal('window', { location: loc })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.mocked(holdAuthRedirect).mockReturnValue(false)
    const err = await api.partners.versions('p1').catch((e: unknown) => e)
    expect(fetch).not.toHaveBeenCalled()
    expect(loc.href).toBe('http://localhost:3111/dev/connection-field?frame=step-healthy')
    expect((err as { status?: number }).status).toBe(401)
  })

  it('a page outside the previews is still sent to sign in', async () => {
    session = null
    const loc = { href: '/developers', pathname: '/developers' }
    vi.stubGlobal('window', { location: loc })
    vi.mocked(holdAuthRedirect).mockReturnValue(false)
    await api.partners.versions('p1').catch(() => {})
    expect(loc.href).toBe('/login')
  })

  it('no session at all is a 401 too: held, and never mistaken for a request with no answer', async () => {
    session = null
    const loc = { href: '/partners' }
    vi.stubGlobal('window', { location: loc })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.mocked(holdAuthRedirect).mockReturnValue(true)
    const err = await api.partners.versions('p1').catch((e: unknown) => e)
    expect(fetch).not.toHaveBeenCalled()
    expect(loc.href).toBe('/partners')
    expect((err as { status?: number }).status).toBe(401)
  })
})
