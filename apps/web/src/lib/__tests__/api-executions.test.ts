/**
 * Issue #97: executions.replay()/resume() only checked for 401, so a 4xx/5xx
 * resolved to { executionId: null } and the caller's `if (newId)` made it a
 * silent no-op — the spinner stopped and nothing happened. They now throw on any
 * non-ok response (like req()) so the UI can surface the failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api } from '../api'

function mockFetch(status: number, body: string, execId?: string) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k === 'X-Execution-Id' ? (execId ?? null) : null) },
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : null),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('executions.replay / resume error handling (#97)', () => {
  it('replay throws on a 5xx instead of resolving to a null no-op', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'boom'))
    await expect(api.executions.replay('e1')).rejects.toThrow('API 500: boom')
  })

  it('replay throws on a 4xx (e.g. conflict)', async () => {
    vi.stubGlobal('fetch', mockFetch(409, 'already running'))
    await expect(api.executions.replay('e1')).rejects.toThrow('API 409: already running')
  })

  it('replay returns the new execution id on success', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '{"ok":true}', 'new-exec'))
    const r = await api.executions.replay('e1')
    expect(r.executionId).toBe('new-exec')
  })

  it('resume throws on a non-ok response too', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'kaboom'))
    await expect(api.executions.resume('e1')).rejects.toThrow('API 500: kaboom')
  })

  it('resume returns the new execution id on success', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '{"ok":true}', 'resumed-exec'))
    const r = await api.executions.resume('e1')
    expect(r.executionId).toBe('resumed-exec')
  })
})
