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
  statementRequestBody,
  STATEMENT_TIMEOUT_SECONDS,
  EDGE_TIMEOUT_CEILING_SECONDS,
  REQUEST_DEADLINE_MS,
  SnowflakeRequestTimeoutError,
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
  it.each([408, 429, 502, 503, 504, 524])('treats %i as transient', (status) => {
    expect(isTransientSnowflakeError(status)).toBe(true)
  })

  /**
   * 2026-09-22 (#1440). The execution archive stopped three runs in 40 hours on
   * two timeouts that were not on the list, while the 504 that means the same
   * thing was already on it.
   *
   * Both bodies below are the ones production recorded verbatim in `job_runs`.
   * Neither status can mean the statement itself failed, which is the ambiguity
   * that keeps 500 off the list and forces it to match on words: a 524 is the
   * edge in front of Snowflake giving up on the origin, and a 408 is Snowflake
   * saying it canceled the statement at its own timeout. So both are judged on
   * the status alone.
   */
  it('treats the 524 the archive receives as transient', () => {
    expect(isTransientSnowflakeError(524, 'error code: 524\n')).toBe(true)
  })

  it('treats a 408 carrying the statement or warehouse timeout as transient', () => {
    const body = '{"code":"000630","message":"Statement reached its statement or warehouse timeout of 60 second(s) and was canceled.","sqlState":"57014"}'
    expect(isTransientSnowflakeError(408, body)).toBe(true)
  })

  it.each([400, 401, 403, 422])('treats %i as permanent', (status) => {
    expect(isTransientSnowflakeError(status)).toBe(false)
  })

  it('treats 500 as permanent so a real statement failure is not retried', () => {
    expect(isTransientSnowflakeError(500)).toBe(false)
  })

  /**
   * 2026-08-11: the 16:37 UTC sightings export died on its first MERGE with
   * HTTP 500 and body `{"code":"ErrorCode{messageCode=370001}","message":"Idle
   * timeout expired: 30001/30000 ms"}`. That is Snowflake timing out on its own
   * side, not the statement failing, so the blanket 500 rule above gave up on a
   * stall a single resubmit would have cleared.
   *
   * The rule keys on the timeout WORDS, not on 370001: Snowflake uses 370001 as
   * a generic internal-error code that also fires for genuinely broken SQL, so
   * matching the code would start silently retrying real failures.
   */
  it('treats a 500 carrying an idle timeout as transient', () => {
    const body = '{"code":"ErrorCode{messageCode=370001}","message":"Idle timeout expired: 30001/30000 ms"}'
    expect(isTransientSnowflakeError(500, body)).toBe(true)
  })

  it('still treats a 500 carrying 370001 WITHOUT an idle timeout as permanent', () => {
    const body = 'SQL execution internal error: Processing aborted due to error 370001:2044717777'
    expect(isTransientSnowflakeError(500, body)).toBe(false)
  })

  it('treats a 500 with an unrelated body as permanent', () => {
    expect(isTransientSnowflakeError(500, 'SQL compilation error: invalid identifier')).toBe(false)
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

  // #606: a fetch that rejects with a plain object (not an Error) must surface
  // its content, not "[object Object]". The old `new Error(String(e))` blanked
  // the cause; `formatErr(e)` renders it.
  it('renders a non-Error fetch rejection as its content, not [object Object]', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue({ message: 'pool exhausted', code: 'CONN' })
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.toThrow(/pool exhausted/)
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.not.toThrow(/\[object Object\]/)
  })

  it('retries the 524 that stopped the archive, resubmitting under the same requestId (#1440)', async () => {
    const spy = mockFetchSequence([
      { status: 524, body: 'error code: 524\n' },
      { status: 200, body: { code: '090001' } },
    ])
    const result = await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)

    expect(result.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
    const retryUrl = spy.mock.calls[1][0] as string
    expect(retryUrl).toContain('requestId=req-1')
    expect(retryUrl).toContain('retry=true')
  })

  it('retries the 408 statement timeout that stopped the archive (#1440)', async () => {
    const spy = mockFetchSequence([
      { status: 408, body: '{"code":"000630","message":"Statement reached its statement or warehouse timeout of 60 second(s) and was canceled.","sqlState":"57014"}' },
      { status: 200, body: { code: '090001' } },
    ])
    const result = await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)

    expect(result.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('retries a 500 idle timeout and resubmits with the same requestId plus retry=true', async () => {
    const spy = mockFetchSequence([
      { status: 500, body: '{"code":"ErrorCode{messageCode=370001}","message":"Idle timeout expired: 30001/30000 ms"}' },
      { status: 200, body: { code: '090001' } },
    ])
    const result = await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)

    expect(result.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
    const retryUrl = spy.mock.calls[1][0] as string
    expect(retryUrl).toContain('requestId=req-1') // same id => Snowflake won't re-execute
    expect(retryUrl).toContain('retry=true')
  })

  it('does not retry a 500 whose body is a real statement failure', async () => {
    const spy = mockFetchSequence([{ status: 500, body: 'SQL execution internal error: Processing aborted' }])
    await expect(postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)).rejects.toThrow(
      /Snowflake 500: SQL execution internal error/,
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })

  /**
   * L77: a retry that fires silently makes one benign stall and a systemic
   * Snowflake degradation indistinguishable. A run where most batches needed a
   * retry looked exactly like a clean run, so the only visible signal was a
   * whole run dying. Log every retry so the RATE is countable in the logs
   * before it becomes an outage.
   */
  it('logs each retry so a rising retry rate is visible before a run dies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      { status: 503, body: 'connection termination' },
      { status: 200, body: { code: '090001' } },
    ])
    await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)

    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0].join(' ')
    expect(line).toContain('503')          // which failure
    expect(line).toContain('req-1')        // which statement
  })

  it('does not log when the statement succeeds first time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([{ status: 200, body: { code: '090001' } }])
    await postStatementWithRetry(url, headers, '{}', 'req-1', retryOpts)
    expect(warn).not.toHaveBeenCalled()
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

/**
 * Multi-partition result assembly (#986).
 *
 * Snowflake splits a large result set into numbered partitions: partition 0
 * arrives inline with the statement response and the rest have to be fetched by
 * handle. Reading only partition 0 returns a SUBSET, and a subset of an archive
 * verification is indistinguishable from a shortfall in the archive itself. That
 * is not hypothetical. The deletion gate's payload probe asks for 60 compressed
 * execution bundles at once, and from the day it shipped it reported all 16
 * consecutive days it measured as missing bundles, while the independent row and
 * step counts matched Postgres exactly on every one of them (2026-09-03).
 *
 * A short read is refused rather than returned, because it is FASTER than a
 * complete one and so presents as a healthy result (L98, L288).
 */
describe('result partition assembly', () => {
  const meta = (numRows: number, partitionRowCounts?: number[]) => ({
    numRows,
    ...(partitionRowCounts === undefined
      ? {}
      : { partitionInfo: partitionRowCounts.map((rowCount) => ({ rowCount })) }),
  })

  it('assembles the rows from every partition, in order', async () => {
    const spy = mockFetchSequence([
      { status: 200, body: { data: [['c'], ['d']] } },
      { status: 200, body: { data: [['e']] } },
    ])
    const result = await resolveStatementResult(
      config,
      headers,
      200,
      JSON.stringify({
        statementHandle: 'h1',
        resultSetMetaData: meta(5, [2, 2, 1]),
        data: [['a'], ['b']],
      }),
      fast,
    )
    expect(result.data).toEqual([['a'], ['b'], ['c'], ['d'], ['e']])
    expect(spy).toHaveBeenCalledTimes(2) // partitions 1 and 2, never 0 again
    expect(String(spy.mock.calls[0]?.[0])).toContain('partition=1')
    expect(String(spy.mock.calls[1]?.[0])).toContain('partition=2')
  })

  it('refuses a result that arrives short of the row count Snowflake declared', async () => {
    mockFetchSequence([{ status: 200, body: { data: [['c']] } }])
    await expect(
      resolveStatementResult(
        config,
        headers,
        200,
        JSON.stringify({
          statementHandle: 'h1',
          resultSetMetaData: meta(5, [2, 3]),
          data: [['a'], ['b']],
        }),
        fast,
      ),
    ).rejects.toThrow(/3 of the 5 rows/)
  })

  it('refuses a single-partition result that is short of the declared row count', async () => {
    const spy = mockFetchSequence([{ status: 200, body: { data: [] } }])
    await expect(
      resolveStatementResult(
        config,
        headers,
        200,
        JSON.stringify({ statementHandle: 'h1', resultSetMetaData: meta(5), data: [['a'], ['b']] }),
        fast,
      ),
    ).rejects.toThrow(/2 of the 5 rows/)
    expect(spy).not.toHaveBeenCalled() // nothing to fetch, and it must not invent a partition
  })

  it('leaves a complete single-partition result untouched and fetches nothing', async () => {
    const spy = mockFetchSequence([{ status: 200, body: { data: [['should not be fetched']] } }])
    const result = await resolveStatementResult(
      config,
      headers,
      200,
      JSON.stringify({ statementHandle: 'h1', resultSetMetaData: meta(2, [2]), data: [['a'], ['b']] }),
      fast,
    )
    expect(result.data).toEqual([['a'], ['b']])
    expect(spy).not.toHaveBeenCalled()
  })

  /**
   * Only a SHORT result is refused. A surplus cannot be truncation, and a DML
   * statement's result is a one-row count whose numRows this code does not own
   * the contract for, so refusing on any inequality would risk breaking the
   * export path to catch a case that carries no data-loss risk.
   */
  it('passes through a result that declares no row count, so DML keeps working', async () => {
    const spy = mockFetchSequence([{ status: 200, body: { data: [['nope']] } }])
    const result = await resolveStatementResult(
      config,
      headers,
      200,
      JSON.stringify({ data: [['3', '0']], code: '090001' }),
      fast,
    )
    expect(result.data).toEqual([['3', '0']])
    expect(spy).not.toHaveBeenCalled()
  })

  it('surfaces a failed partition fetch instead of returning the rows it did get', async () => {
    mockFetchSequence([{ status: 500, body: { message: 'internal' } }])
    await expect(
      resolveStatementResult(
        config,
        headers,
        200,
        JSON.stringify({ statementHandle: 'h1', resultSetMetaData: meta(4, [2, 2]), data: [['a'], ['b']] }),
        fast,
      ),
    ).rejects.toThrow(/partition 1 of 2/)
  })

  it('refuses to report a multi-partition result it has no handle to fetch with', async () => {
    await expect(
      resolveStatementResult(
        config,
        headers,
        200,
        JSON.stringify({ resultSetMetaData: meta(4, [2, 2]), data: [['a'], ['b']] }),
        fast,
      ),
    ).rejects.toThrow(/without a statementHandle/)
  })

  it('assembles partitions on the polled path too, not only on an immediate 200', async () => {
    mockFetchSequence([
      { status: 202, body: {} },
      { status: 200, body: { statementHandle: 'h1', resultSetMetaData: meta(3, [2, 1]), data: [['a'], ['b']] } },
      { status: 200, body: { data: [['c']] } },
    ])
    const result = await resolveStatementResult(config, headers, 202, JSON.stringify({ statementHandle: 'h1' }), fast)
    expect(result.data).toEqual([['a'], ['b'], ['c']])
  })
})

/**
 * How long Snowflake may spend on one statement before cancelling it (#1447).
 *
 * Measured 2026-09-22. The execution archive stopped three runs in 40 hours on
 * this limit, and the run at 15:23 UTC spent 642 seconds resubmitting one
 * statement three times, each attempt cancelled at 60 seconds, then archived
 * nothing. The statements are not large: a healthy hour uses 9 to 13 sends for
 * about 25 MB, so roughly 2 MB each, and two failures in the same hour landed on
 * its second and its tenth send, which rules out one pathological record and
 * leaves Snowflake itself being slow.
 *
 * The value is bounded ABOVE by something outside our control, which is why the
 * ceiling is a constant rather than a sentence: the edge in front of Snowflake
 * answers 524 at about 100 seconds, so a limit past that converts a clean
 * cancellation, which names the statement and its timeout, into an opaque
 * gateway error.
 */
describe('the statement timeout (#1447)', () => {
  it('stays under the ceiling the edge in front of Snowflake imposes', () => {
    // The relationship, not the number: a future raise that crosses the ceiling
    // fails here rather than shipping and being diagnosed from a 524 (L545).
    expect(STATEMENT_TIMEOUT_SECONDS).toBeLessThan(EDGE_TIMEOUT_CEILING_SECONDS)
  })

  it('gives a statement more room than the 60 seconds that was cancelling them', () => {
    expect(STATEMENT_TIMEOUT_SECONDS).toBeGreaterThan(60)
  })

  it('is what the request actually carries, not a number beside it', () => {
    const body = statementRequestBody(
      { database: 'db', schema: 'sch', warehouse: 'wh', role: 'r' } as SnowflakeConfig,
      'select 1',
    )

    expect(body.timeout).toBe(STATEMENT_TIMEOUT_SECONDS)
  })

  it('still upcases the identifiers, which Snowflake stores unquoted', () => {
    const body = statementRequestBody(
      { database: 'db', schema: 'sch', warehouse: 'wh', role: 'r' } as SnowflakeConfig,
      'select 1',
    )

    expect(body).toMatchObject({ database: 'DB', schema: 'SCH', warehouse: 'WH', role: 'R' })
  })

  it('carries bindings as one-indexed text, and omits them entirely when there are none', () => {
    const config = { database: 'db', schema: 'sch', warehouse: 'wh', role: 'r' } as SnowflakeConfig

    expect(statementRequestBody(config, 'select ?', ['a', null]).bindings).toEqual({
      '1': { type: 'TEXT', value: 'a' },
      '2': { type: 'TEXT', value: '' },
    })
    expect(statementRequestBody(config, 'select 1', []).bindings).toBeUndefined()
  })
})

/**
 * A deadline on every request (2026-09-23).
 *
 * The 14:23 UTC archive run ended `exceededWallTime` at 899,991 ms of wall time
 * against 5,174 ms of CPU: it sat for the platform's whole 15 minute cron limit
 * waiting on one call that never answered. The run's own wall budget is checked
 * between pieces of work, so it cannot end a call already in flight, and none of
 * these fetches carried a signal. A request that neither answers nor fails must
 * become a failure the caller can act on.
 */
describe('the request deadline', () => {
  // A fetch that answers only by rejecting when its signal aborts, which is what
  // a stalled connection looks like from inside the Worker.
  function hangingFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          if (!signal) return // no deadline: hangs for ever, and the test times out
          signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
        }),
    )
  }

  it('outlasts the edge, which answers a slow statement itself at its ceiling', () => {
    // Shorter than the edge and a slow but healthy statement would be abandoned
    // before the 524 that names it arrives.
    expect(REQUEST_DEADLINE_MS).toBeGreaterThan(EDGE_TIMEOUT_CEILING_SECONDS * 1000)
  })

  it('stays a small fraction of the 15 minute cron limit, so a run survives one stall', () => {
    expect(REQUEST_DEADLINE_MS * 3).toBeLessThan(15 * 60 * 1000 / 2)
  })

  it('abandons a statement POST that never answers, and says it timed out', async () => {
    const spy = hangingFetch()
    const err = await postStatementWithRetry(
      'https://acct.snowflakecomputing.com/api/v2/statements', headers, '{}', 'req-1',
      { maxAttempts: 2, delaysMs: [0], sleep: async () => {}, requestDeadlineMs: 5 },
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SnowflakeRequestTimeoutError)
    expect((err as Error).message).toMatch(/no answer within 5 ms/)
    // Resubmitted under the same requestId, which Snowflake dedupes (retry=true).
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0] as string).toContain('retry=true')
  })

  it('abandons a poll that never answers', async () => {
    hangingFetch()
    await expect(
      pollStatement(config, headers, 'h1', { intervalMs: 0, maxAttempts: 3, requestDeadlineMs: 5 }),
    ).rejects.toBeInstanceOf(SnowflakeRequestTimeoutError)
  })

  it('abandons a result partition fetch that never answers', async () => {
    hangingFetch()
    await expect(
      resolveStatementResult(
        config, headers, 200,
        JSON.stringify({ statementHandle: 'h1', data: [['a']], resultSetMetaData: { numRows: 2, partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] } }),
        { requestDeadlineMs: 5 },
      ),
    ).rejects.toBeInstanceOf(SnowflakeRequestTimeoutError)
  })

  it('still reports a real network failure as itself, not as a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'))
    const err = await postStatementWithRetry(
      'https://acct.snowflakecomputing.com/api/v2/statements', headers, '{}', 'req-1',
      { maxAttempts: 1, requestDeadlineMs: 5 },
    ).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(SnowflakeRequestTimeoutError)
    expect((err as Error).message).toMatch(/Network connection lost/)
  })
})
