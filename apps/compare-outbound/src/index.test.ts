/**
 * The compare namespace's outbound Worker (#1708 part B). Every request a code
 * bundle in that namespace makes reaches this Worker instead of the internet, so
 * a shadow run's code nodes cannot call a partner, Equifax or Salesforce. Deny
 * mode only: nothing is ever forwarded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { EGRESS_DENIED_STATUS } from './index'

afterEach(() => vi.restoreAllMocks())

describe('compare outbound Worker', () => {
  it('refuses every request by name and forwards nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    for (const [method, url] of [
      ['POST', 'https://api.equifax.com/business/oneview/consumer-credit/v1/reports/credit-report'],
      ['GET', 'https://pennie.my.salesforce.com/services/data/v61.0/query?q=SELECT+Id'],
      ['PUT', 'http://10.0.0.1:8080/internal'],
    ] as const) {
      const res = worker.fetch(new Request(url, { method, body: method === 'GET' ? undefined : '{"ssn":"redacted"}' }))
      expect(res.status, url).toBe(EGRESS_DENIED_STATUS)
      expect(res.headers.get('x-bidspoke-egress'), url).toBe('denied')
      const body: { error: string; host: string; message: string } = await res.json()
      expect(body.error).toBe('egress_denied')
      expect(body.host).toBe(new URL(url).host)
      expect(body.message).toContain('shadow run')
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('never echoes or logs the path, query or body, which can carry a person', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = worker.fetch(new Request('https://api.equifax.com/reports?ssn=123456789', { method: 'POST', body: 'dob=1990-01-01' }))
    const text = await res.text()

    for (const leak of ['123456789', 'ssn=', 'dob', '/reports']) {
      expect(text, leak).not.toContain(leak)
      expect(log.mock.calls.flat().join(' '), leak).not.toContain(leak)
    }
    expect(log.mock.calls.flat().join(' ')).toContain('egress_denied host=api.equifax.com method=POST')
  })
})
