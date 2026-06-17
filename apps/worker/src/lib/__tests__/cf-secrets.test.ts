/**
 * Cloudflare secret lister (#199) — names only, never values.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { listCfSecretNames } from '../cf-secrets'

afterEach(() => vi.unstubAllGlobals())

describe('listCfSecretNames', () => {
  it('returns the set of secret names from the CF API result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: [{ name: 'STRIPE_KEY' }, { name: 'EQUIFAX_PASSWORD' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const names = await listCfSecretNames('acct-1', 'tok-1')
    expect(names).toEqual(new Set(['STRIPE_KEY', 'EQUIFAX_PASSWORD']))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/accounts/acct-1/workers/scripts/bidspoke-worker/secrets')
    expect(init.method).toBe('GET')
  })

  it('returns null (not an empty set) when CF is not configured, without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await listCfSecretNames(undefined, 'tok')).toBeNull()
    expect(await listCfSecretNames('acct', undefined)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' }))
    await expect(listCfSecretNames('acct', 'tok')).rejects.toThrow('Failed to list Cloudflare secrets (403)')
  })

  it('treats a missing result array as no secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    expect(await listCfSecretNames('acct', 'tok')).toEqual(new Set())
  })
})
