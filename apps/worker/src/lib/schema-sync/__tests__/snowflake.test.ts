/**
 * Snowflake schema fetcher — PRD Section 3.1
 * Covers: groups columns by schema.table, maps nullable flag, throws on non-2xx,
 * and (issue #89) polls an async 202 to completion instead of caching empty.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSnowflakeSchema } from '../snowflake'

const CREDS = JSON.stringify({
  account: 'xy12345.us-east-1',
  username: 'user',
  password: 'pass',
  database: 'TESTDB',
})

// Tiny poll timings so the 202 tests run instantly instead of on the 1.5s/20s
// production cadence.
const FAST_POLL = { pollIntervalMs: 1, pollTimeoutMs: 200 }

type MockRes = { ok: boolean; status: number; json: () => Promise<unknown> }
function res(status: number, body: unknown): MockRes {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

function fetchReturning(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue(res(ok ? 200 : 401, data))
}

// Returns each response in order on successive fetch calls, repeating the last.
function fetchSequence(responses: MockRes[]) {
  let i = 0
  return vi.fn().mockImplementation(() => Promise.resolve(responses[Math.min(i++, responses.length - 1)]))
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchSnowflakeSchema', () => {
  it('groups columns into schema.table objects', async () => {
    const result = {
      data: [
        ['PUBLIC', 'LEADS', 'ID',        'VARCHAR', 'NO'],
        ['PUBLIC', 'LEADS', 'EMAIL',      'VARCHAR', 'YES'],
        ['PUBLIC', 'USERS', 'ID',         'NUMBER',  'NO'],
        ['STAGING', 'RAW',  'PAYLOAD',    'VARIANT', 'YES'],
      ],
    }
    vi.stubGlobal('fetch', fetchReturning(result))

    const schema = await fetchSnowflakeSchema(CREDS)
    expect(schema.objects).toHaveLength(3)

    const leads = schema.objects.find((o) => o.name === 'PUBLIC.LEADS')!
    expect(leads.fields).toHaveLength(2)
    expect(leads.fields[0]).toEqual({ name: 'ID', label: 'ID', type: 'varchar', nullable: false })
    expect(leads.fields[1]).toEqual({ name: 'EMAIL', label: 'EMAIL', type: 'varchar', nullable: true })
  })

  it('returns empty objects when data is empty', async () => {
    vi.stubGlobal('fetch', fetchReturning({ data: [] }))
    const schema = await fetchSnowflakeSchema(CREDS)
    expect(schema.objects).toEqual([])
  })

  it('throws on non-200 response', async () => {
    vi.stubGlobal('fetch', fetchReturning({}, false))
    await expect(fetchSnowflakeSchema(CREDS)).rejects.toThrow('Snowflake schema fetch failed (401)')
  })

  it('polls a 202 (async query) to completion and returns the schema', async () => {
    // POST → 202 + handle, first poll still running (202), second poll → rows.
    const mockFetch = fetchSequence([
      res(202, { statementHandle: 'h-1', message: 'running' }),
      res(202, { statementHandle: 'h-1', message: 'still running' }),
      res(200, { data: [['PUBLIC', 'LEADS', 'ID', 'VARCHAR', 'NO']] }),
    ])
    vi.stubGlobal('fetch', mockFetch)

    const schema = await fetchSnowflakeSchema(CREDS, FAST_POLL)
    expect(schema.objects).toHaveLength(1)
    expect(schema.objects[0].name).toBe('PUBLIC.LEADS')
    // GET poll hits the statement-handle URL.
    const pollUrl = mockFetch.mock.calls[1][0] as string
    expect(pollUrl).toContain('/api/v2/statements/h-1')
  })

  it('throws (preserving the cache) when an async query never completes', async () => {
    // Always 202: the query keeps running until the poll timeout elapses.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(202, { statementHandle: 'h-2' })))
    await expect(fetchSnowflakeSchema(CREDS, FAST_POLL)).rejects.toThrow(/still running/)
  })

  it('throws on a 202 with no statementHandle to poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(202, { message: 'accepted' })))
    await expect(fetchSnowflakeSchema(CREDS, FAST_POLL)).rejects.toThrow(/statementHandle/)
  })

  it('throws when a poll returns a hard error', async () => {
    const mockFetch = fetchSequence([
      res(202, { statementHandle: 'h-3' }),
      res(500, { message: 'internal error' }),
    ])
    vi.stubGlobal('fetch', mockFetch)
    await expect(fetchSnowflakeSchema(CREDS, FAST_POLL)).rejects.toThrow('Snowflake schema poll failed (500)')
  })

  it('sends Basic auth with base64-encoded credentials', async () => {
    const mockFetch = fetchReturning({ data: [] })
    vi.stubGlobal('fetch', mockFetch)

    await fetchSnowflakeSchema(CREDS)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('xy12345.us-east-1.snowflakecomputing.com')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Basic ${btoa('user:pass')}`)
  })
})
