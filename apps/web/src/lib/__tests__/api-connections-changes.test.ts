/**
 * The Connections page's changes (#2338, build PR 10): the save, Reconnect and
 * Remove calls send what their routes read (routes/api/connections.ts in the
 * Worker), to the connection's id made safe for a path, with a ceiling past the
 * route's own worst case so the page never says no answer while the route may
 * still answer, and a refusal throws carrying the route's sentence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api, CONNECTION_REMOVE_TIMEOUT_MS, CONNECTION_SAVE_TIMEOUT_MS } from '../api'

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the save, Reconnect and Remove calls', () => {
  it('a save posts the service, the name and the fields', async () => {
    const f = answer(201, { connection: { id: 'n1' } })
    await api.connections.create({ service: 'salesforce', name: 'Achieve Salesforce 2', fields: { client_id: 'c' } })
    expect(f.mock.calls[0][0]).toMatch(/\/api\/connections$/)
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ service: 'salesforce', name: 'Achieve Salesforce 2', fields: { client_id: 'c' } }) })
  })

  it('a Reconnect posts to the connection, its id made safe for the path', async () => {
    const f = answer(200, { outcome: 'checked', connection: { id: 'a/b', generation: 1, acts_as: null } })
    await api.connections.reconnect('a/b', {})
    expect(f.mock.calls[0][0]).toContain('/api/connections/a%2Fb/reconnect')
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('a Remove deletes the connection', async () => {
    const f = answer(200, { outcome: 'removed', connection: { id: 'c3', generation: 2 }, ops: { told: true } })
    await api.connections.remove('c3')
    expect(f.mock.calls[0][0]).toContain('/api/connections/c3')
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
  })

  it("a refusal throws carrying the route's sentence and the workflows it names", async () => {
    answer(409, { error: 'connection_in_use', message: 'Daily cleanup uses this connection, so it cannot be removed.', workflows: [{ id: 'w9', name: 'Daily cleanup', deleted: false }] })
    const err = await api.connections.remove('c3').catch((e: unknown) => e) as { status: number; body: { message: string; workflows: unknown[] } }
    expect(err.status).toBe(409)
    expect(err.body.message).toBe('Daily cleanup uses this connection, so it cannot be removed.')
    expect(err.body.workflows).toHaveLength(1)
  })

  it("waits past the route's worst case: verify's 50 s, the Google list's 15 s, the write and a revoke", () => {
    expect(CONNECTION_SAVE_TIMEOUT_MS).toBeGreaterThanOrEqual(50_000 + 15_000 + 30_000 + 15_000)
    // The removal's function and revoke's 15 s.
    expect(CONNECTION_REMOVE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000 + 15_000)
  })

  it('a save that does not answer by its ceiling throws a timeout, which the page reads as not known', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))))
    const pending = api.connections.create({ service: 'salesforce', name: 'x', fields: {} }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(CONNECTION_SAVE_TIMEOUT_MS)
    expect(await pending).toMatchObject({ timedOut: true, timeoutMs: CONNECTION_SAVE_TIMEOUT_MS })
  })
})
