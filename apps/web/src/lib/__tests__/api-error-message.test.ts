/**
 * #337: a non-ok API response should surface the server's `error` field, not
 * the raw `API NNN: {json}` wrapper. Error messages are how users self-correct;
 * the wrapper makes every one look like a developer error. The status must stay
 * available on the thrown Error for callers that branch on it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api } from '../api'

function mockResponse(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('req() surfaces the server error message (#337)', () => {
  it('throws the `error` field, not the JSON wrapper, for a JSON body', async () => {
    vi.stubGlobal('fetch', mockResponse(400, JSON.stringify({ error: 'Workflow has a loop: a -> b -> a' })))
    await expect(api.workflows.list()).rejects.toThrow(/^Workflow has a loop: a -> b -> a$/)
  })

  it('does not include the `API 400:` wrapper in the message', async () => {
    vi.stubGlobal('fetch', mockResponse(400, JSON.stringify({ error: 'Bad input' })))
    await expect(api.workflows.list()).rejects.toThrow(/^Bad input$/)
  })

  it('keeps the status on the thrown error for callers that branch on it', async () => {
    vi.stubGlobal('fetch', mockResponse(409, JSON.stringify({ error: 'Conflict' })))
    const err = await api.workflows.list().catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { status?: number }).status).toBe(409)
  })

  it('falls back to the raw text when the body is not JSON', async () => {
    vi.stubGlobal('fetch', mockResponse(500, 'Internal Server Error'))
    await expect(api.workflows.list()).rejects.toThrow('Internal Server Error')
  })

  it('falls back to a status-only message when the body is empty', async () => {
    vi.stubGlobal('fetch', mockResponse(502, ''))
    await expect(api.workflows.list()).rejects.toThrow('API 502')
  })

  it('collapses an HTML gateway error page to a status-only message', async () => {
    vi.stubGlobal('fetch', mockResponse(502, '<!DOCTYPE html><html><body>Bad gateway</body></html>'))
    await expect(api.workflows.list()).rejects.toThrow(/^API 502$/)
  })

  it('collapses an overly long non-JSON body to a status-only message', async () => {
    vi.stubGlobal('fetch', mockResponse(500, 'x'.repeat(300)))
    await expect(api.workflows.list()).rejects.toThrow(/^API 500$/)
  })
})
