/**
 * Snowflake schema fetcher — PRD Section 3.1
 * Covers: groups columns by schema.table, maps nullable flag,
 * throws on non-200 and on async/running status.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSnowflakeSchema } from '../snowflake'

const CREDS = JSON.stringify({
  account: 'xy12345.us-east-1',
  username: 'user',
  password: 'pass',
  database: 'TESTDB',
})

function fetchReturning(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: () => Promise.resolve(data),
  })
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

  it('throws when status is running (async query)', async () => {
    vi.stubGlobal('fetch', fetchReturning({ status: 'running', message: 'executing' }))
    await expect(fetchSnowflakeSchema(CREDS)).rejects.toThrow(/running/)
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
