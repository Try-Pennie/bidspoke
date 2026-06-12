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
import { resolveStatementResult, pollStatement, type SnowflakeConfig } from '../snowflake'

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
