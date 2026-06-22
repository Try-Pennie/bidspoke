import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchJson, parseJson, parseJsonSafe } from '../json'
import { stubFetch } from '../../__tests__/helpers/fetch-mock'

afterEach(() => vi.restoreAllMocks())

describe('parseJson', () => {
  it('returns the parsed body typed as T without a cast', async () => {
    const res = new Response(JSON.stringify({ access_token: 'abc' }), {
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await parseJson<{ access_token: string }>(res)
    expect(data.access_token).toBe('abc')
  })

  it('does not pre-check status — the caller branches on res.ok first', async () => {
    const res = new Response(JSON.stringify({ error: 'nope' }), { status: 400 })
    const data = await parseJson<{ error: string }>(res)
    expect(data.error).toBe('nope')
  })
})

describe('parseJsonSafe', () => {
  it('returns the parsed body typed as T on success', async () => {
    const res = new Response(JSON.stringify({ response: 'accepted' }))
    const data = await parseJsonSafe<{ response?: string }>(res)
    expect(data?.response).toBe('accepted')
  })

  it('returns null instead of throwing when the body is not valid JSON', async () => {
    const res = new Response('not json at all', { status: 502 })
    const data = await parseJsonSafe<{ response?: string }>(res)
    expect(data).toBeNull()
  })
})

describe('fetchJson', () => {
  it('fetches the URL and returns the parsed JSON body typed as T', async () => {
    const fetch = stubFetch()
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, team: 'pennie' })))

    const data = await fetchJson<{ ok: boolean; team?: string }>('https://slack.com/api/auth.test', {
      method: 'POST',
    })

    expect(data).toEqual({ ok: true, team: 'pennie' })
    expect(fetch).toHaveBeenCalledWith('https://slack.com/api/auth.test', { method: 'POST' })
  })

  it('passes through when no init is provided', async () => {
    const fetch = stubFetch()
    fetch.mockResolvedValue(new Response(JSON.stringify({ value: 42 })))

    const data = await fetchJson<{ value: number }>('https://example.com/data')

    expect(data.value).toBe(42)
    expect(fetch).toHaveBeenCalledWith('https://example.com/data', undefined)
  })
})
