/**
 * The ops namespace's outbound Worker (#1709 part 3, plan 0.E). Every request
 * a code bundle in bidspoke-code-nodes-ops makes reaches this Worker instead of
 * the internet, and is refused until Phase 2 defines what ops code may reach.
 * Nothing is ever forwarded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { EGRESS_DENIED_STATUS } from './index'

afterEach(() => vi.restoreAllMocks())

describe('ops outbound Worker', () => {
  it('refuses every request by name and forwards nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'log').mockImplementation(() => {})

    for (const [method, url] of [
      ['POST', 'https://api.telnyx.com/v2/messages'],
      ['GET', 'https://xvrmivmpfykwwtriqwpg.supabase.co/rest/v1/workflows?select=*'],
      ['PUT', 'http://10.0.0.1:8080/internal'],
      ['DELETE', 'https://api.equifax.com/anything'],
    ] as const) {
      const res = worker.fetch(new Request(url, { method, body: method === 'GET' || method === 'DELETE' ? undefined : '{"phone":"5555550100"}' }))
      expect(res.status, url).toBe(EGRESS_DENIED_STATUS)
      expect(res.headers.get('x-bidspoke-egress'), url).toBe('denied')
      const body: { error: string; host: string; message: string } = await res.json()
      expect(body.error).toBe('egress_denied')
      expect(body.host).toBe(new URL(url).host)
      expect(body.message).toContain('ops code')
    }

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never echoes or logs the path, query or body, which can carry a person', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = worker.fetch(new Request('https://api.telnyx.com/v2/messages?to=5555550100', { method: 'POST', body: 'text=hello' }))
    const text = await res.text()

    for (const leak of ['5555550100', 'to=', 'hello', '/v2/messages']) {
      expect(text, leak).not.toContain(leak)
      expect(log.mock.calls.flat().join(' '), leak).not.toContain(leak)
    }
    // Its own log line, so an ops refusal is never read as a shadow run's.
    expect(log.mock.calls.flat().join(' ')).toContain('ops_egress_denied host=api.telnyx.com method=POST')
  })
})
