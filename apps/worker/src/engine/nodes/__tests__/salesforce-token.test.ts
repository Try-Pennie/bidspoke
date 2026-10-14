/**
 * The Salesforce token fetch is bounded and judged like every other outbound
 * call (#1389).
 *
 * It had no timeout and no link to the step's own deadline, so a hung token
 * endpoint held a lead for the platform's connect timeout. And its failure body
 * skipped the HTML page rule (#694, #756), so an edge error page on the token
 * host read as a final auth failure rather than a blip worth one retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getSalesforceToken } from '../salesforce'
import { classifyStepError } from '../../error-classifier'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import type { Env } from '../../../index'

const INSTANCE = 'https://trypennie.my.salesforce.com'

function env(): Env {
  return {
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
  } as unknown as Env
}

/** A fetch that never answers until its signal aborts, as a hung endpoint does. */
function hangUntilAborted(fetchMock: FetchMock) {
  fetchMock.mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const aborted = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      // Like the real fetch: a signal already aborted rejects at once.
      if (init.signal?.aborted) return aborted()
      init.signal?.addEventListener('abort', aborted)
    }),
  )
}

let fetchMock: FetchMock
beforeEach(() => { fetchMock = stubFetch() })
afterEach(() => { vi.unstubAllGlobals() })

const token = (opts?: Parameters<typeof getSalesforceToken>[5]) =>
  getSalesforceToken(env(), 'org-1', INSTANCE, 'id', 'secret', opts)

describe('getSalesforceToken', () => {
  it('gives up on a hung token endpoint after its own deadline, as a retryable failure', async () => {
    hangUntilAborted(fetchMock)
    // A deadline of 1 ms stands in for the 10 s default, so the test waits for nothing.
    const err = await token({ timeoutMs: 1 }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/token fetch timed out after 1 ms/)
    expect(classifyStepError(err)).toBe('transient')
  })

  it('gives up when the step itself is cut off, without waiting for its own deadline', async () => {
    hangUntilAborted(fetchMock)
    const step = new AbortController()
    const pending = token({ signal: step.signal, timeoutMs: 60_000 }).then(() => null, (e: Error) => e)
    step.abort()
    const err = await pending
    expect(err?.message).toMatch(/token fetch stopped: the step ran out of time/)
  })

  it('reads an HTML page on the token host as retryable, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    fetchMock.mockResolvedValue(new Response('<!DOCTYPE html><html><body>Access denied</body></html>', { status: 403 }))
    const err = await token().then(() => null, (e: Error & { status?: number }) => e)
    expect(err?.status).toBe(403)
    expect(classifyStepError(err)).toBe('transient')
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/html_error_page_transient.*token/)
    log.mockRestore()
  })

  it('reads a plain refusal of the credentials as final, so it is not retried', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 400 }))
    const err = await token().then(() => null, (e: Error & { status?: number }) => e)
    expect(err?.status).toBe(400)
    expect(classifyStepError(err)).toBe('permanent')
  })

  it('still answers a token from a normal response', async () => {
    fetchMock.mockResolvedValue(new Response('{"access_token":"t-1"}', { status: 200 }))
    expect(await token()).toBe('t-1')
  })
})
