/**
 * Snowflake statement-result handling (issue #58).
 *
 * The SQL API returns 202 when a statement doesn't finish within the body
 * `timeout` (e.g. a cold-warehouse resume). The result is NOT in that response —
 * it only carries a statementHandle to poll. Treating 202 as success let the
 * export stamp exported_at and purge the source rows 24h later even if the MERGE
 * never completed. These tests cover the poll-to-terminal behavior.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveStatementResult,
  pollStatement,
  isTransientSnowflakeError,
  postStatementWithRetry,
  type SnowflakeConfig,
} from '../snowflake'

const config = { account: 'acct.us-east-1' } as SnowflakeConfig
const headers = { Authorization: 'Bearer x' }
const fast = { intervalMs: 0, maxAttempts: 5 }

// Mock fetch with a queue of responses (status + body), one per call.
function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('resolveStatementResult', () => {
  it('returns the parsed body directly on 200 (no polling)', async () => {
    const spy = mockFetchSequence([{ status: 200, body: { error: 'should not be called' } }])
    const result = await resolveStatementResult(config, headers, 200, JSON.stringify({ data: [[1]], code: '090001' }), fast)
    expect(result.code).toBe('090001')
    expect(spy).not.toHaveBeenCalled() // 200 means complete — never polls
  })

  it('polls on 202 and returns the terminal result', async () => {
    const spy = mockFetchSequence([
      { status: 202, body: { statementHandle: 'h1' } },   // still running
      { status: 200, body: { code: '090001', message: 'done' } }, // complete
    ])
    const result = await resolveStatementResult(config, headers, 202, JSON.stringify({ statementHandle: 'h1' }), fast)
    expect(result.message).toBe('done')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('throws on a 202 with no statementHandle (cannot be polled)', async () => {
    await expect(
      resolveStatementResult(config, headers, 202, JSON.stringify({ message: 'no handle' }), fast),
    ).rejects.toThrow(/202 without a statementHandle/)
  })
})

/**
 * Transient-failure retry (2026-07-09 incident). A single Envoy 503 ("upstream
 * connect error or disconnect/reset before headers") aborted the whole bids
 * export phase because executeStatement did one fetch and threw on any non-2xx.
 * Retries are made safe by Snowflake's own idempotency contract: the same
 * requestId + retry=true means Snowflake will not re-execute a statement that
 * already succeeded.
 */
describe('isTransientSnowflakeError', () => {
  it.each([429, 502, 503, 504])('treats %i as transient', (status) => {
    expect(isTransientSnowflakeError(status)).toBe(true)
  })

  it.each([400, 401, 403, 422])('treats %i as permanent', (status) => {
    expect(isTransientSnowflakeError(status)).toBe(false)
  })

  it('treats 500 as permanent so a real statement failure is not retried', () => {
    expect(isTransientSnowflakeError(500)).toBe(false)
  })
})

describe('postStatementWithRetry', () => {
  const url = 'https://acct.snowflakecomputing.com/api/v2/statements'
  const retryOpts = { maxAttempts: 3, delaysMs: [0, 0], sleep: async () => {} }

  it('sends requestId but not retry=true on the first attempt', async () => {
    const spy = mockFetchSequence([{ status: 200, body: { code: '090001' } }])
    await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)
    const calledUrl = spy.mock.calls[0][0] as string
    expect(calledUrl).toContain('requestId=req-1')
    expect(calledUrl).not.toContain('retry=true')
  })

  it('retries a 503 and resubmits with the same requestId plus retry=true', async () => {
    const spy = mockFetchSequence([
      { status: 503, body: 'upstream connect error or disconnect/reset before headers' },
      { status: 200, body: { code: '090001' } },
    ])
    const result = await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)

    expect(result.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
    const retryUrl = spy.mock.calls[1][0] as string
    expect(retryUrl).toContain('requestId=req-1') // same id => Snowflake won't re-execute
    expect(retryUrl).toContain('retry=true')
  })

  it('retries a network error (fetch rejects before any response)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Network connection lost.'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: '090001' }), { status: 200 }))

    const result = await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)
    expect(result.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not retry a permanent 400 and throws immediately', async () => {
    const spy = mockFetchSequence([{ status: 400, body: 'SQL compilation error' }])
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.toThrow(
      /Snowflake 400: SQL compilation error/,
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throws with the real status and body once transient retries are exhausted', async () => {
    const spy = mockFetchSequence([{ status: 503, body: 'connection termination' }])
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.toThrow(
      /Snowflake 503: connection termination/,
    )
    expect(spy).toHaveBeenCalledTimes(3) // maxAttempts, not unbounded
  })

  it('rethrows the network error once transient retries are exhausted', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'))
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.toThrow(
      /Network connection lost/,
    )
    expect(spy).toHaveBeenCalledTimes(3)
  })
})

describe('pollStatement', () => {
  it('resolves once the statement completes (202 → 202 → 200)', async () => {
    mockFetchSequence([
      { status: 202, body: {} },
      { status: 202, body: {} },
      { status: 200, body: { code: '090001' } },
    ])
    const result = await pollStatement(config, headers, 'h1', fast)
    expect(result.code).toBe('090001')
  })

  it('throws when the statement fails mid-poll (non-2xx)', async () => {
    mockFetchSequence([
      { status: 202, body: {} },
      { status: 422, body: { message: 'SQL compilation error' } },
    ])
    await expect(pollStatement(config, headers, 'h1', fast)).rejects.toThrow(/Snowflake poll 422/)
  })

  it('throws when it never completes within the attempt budget', async () => {
    mockFetchSequence([{ status: 202, body: {} }]) // always 202
    await expect(pollStatement(config, headers, 'h1', { intervalMs: 0, maxAttempts: 3 }))
      .rejects.toThrow(/did not complete after 3 polls/)
  })
})
