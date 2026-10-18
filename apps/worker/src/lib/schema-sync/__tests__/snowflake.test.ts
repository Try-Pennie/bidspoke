/**
 * Snowflake schema lookups (PRD Section 3.1; #2335 PR 7 of phase 5).
 *
 * The full sync groups INFORMATION_SCHEMA.COLUMNS into schema.table objects,
 * polls an async 202 to completion instead of caching empty (#89), and pages
 * every result partition (#151). The keyed lookups (tables, columns of a table)
 * share its statement runner. All of it takes an injected fetch and an already
 * minted auth, an injected sleep and clock for the poll (L524), and fails with a
 * named SchemaLookupError.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  fetchSnowflakeSchema,
  listSnowflakeTables,
  describeSnowflakeTable,
  buildSchemaFilter,
  type SnowflakeSource,
} from '../snowflake'
import { caught, fetchSequence, forbidGlobalFetch, headersOf, json, text, timeoutError, type Answer } from './_fetch'

const AUTH = { Authorization: `Basic ${btoa('user:pass')}`, 'X-Snowflake-Authorization-Token-Type': 'BASIC' }

/** A clock that moves only when the poll sleeps, so no test waits for real. */
function fakeClock() {
  let now = 0
  const slept: number[] = []
  return {
    slept,
    poll: {
      intervalMs: 1500,
      timeoutMs: 20000,
      now: () => now,
      sleep: async (ms: number) => { slept.push(ms); now += ms },
    },
  }
}

function source(fetch: SnowflakeSource['fetch'], extra: Partial<SnowflakeSource> = {}): SnowflakeSource {
  return { service: 'snowflake', fetch, auth: AUTH, account: 'xy12345.us-east-1', database: 'TESTDB', poll: fakeClock().poll, ...extra }
}


function sentSql(init: RequestInit): string {
  const body: unknown = JSON.parse(String(init.body))
  if (typeof body !== 'object' || body === null || !('statement' in body) || typeof body.statement !== 'string') throw new Error('no statement sent')
  return body.statement
}

afterEach(() => vi.unstubAllGlobals())

describe('buildSchemaFilter: SQL literal safety', () => {
  it('returns an empty filter when no schema is configured', () => {
    expect(buildSchemaFilter(undefined)).toBe('')
    expect(buildSchemaFilter('')).toBe('')
  })

  it('uppercases and quotes a normal schema name', () => {
    expect(buildSchemaFilter('public')).toBe("AND TABLE_SCHEMA = 'PUBLIC'")
  })

  it('doubles a trailing backslash so it cannot escape the closing quote', () => {
    expect(buildSchemaFilter('foo\\')).toBe("AND TABLE_SCHEMA = 'FOO\\\\'")
  })

  it('doubles single quotes instead of stripping them', () => {
    expect(buildSchemaFilter("a'b")).toBe("AND TABLE_SCHEMA = 'A''B'")
  })
})

describe('fetchSnowflakeSchema (the canvas sync), on success exactly as before', () => {
  it('groups columns into schema.table objects', async () => {
    forbidGlobalFetch()
    const { fetch } = fetchSequence(json(200, {
      data: [
        ['PUBLIC', 'LEADS', 'ID', 'VARCHAR', 'NO'],
        ['PUBLIC', 'LEADS', 'EMAIL', 'VARCHAR', 'YES'],
        ['PUBLIC', 'USERS', 'ID', 'NUMBER', 'NO'],
        ['STAGING', 'RAW', 'PAYLOAD', 'VARIANT', 'YES'],
      ],
    }))
    const schema = await fetchSnowflakeSchema(source(fetch))
    expect(schema.objects.map((o) => o.name)).toEqual(['PUBLIC.LEADS', 'PUBLIC.USERS', 'STAGING.RAW'])
    const leads = schema.objects[0]
    expect(leads.fields).toEqual([
      { name: 'ID', label: 'ID', type: 'varchar', nullable: false },
      { name: 'EMAIL', label: 'EMAIL', type: 'varchar', nullable: true },
    ])
  })

  it('an empty result is an honest empty answer', async () => {
    const schema = await fetchSnowflakeSchema(source(fetchSequence(json(200, { data: [] })).fetch))
    expect(schema.objects).toEqual([])
  })

  it('sends the auth it was given and the same columns query as before', async () => {
    const { fetch, calls } = fetchSequence(json(200, { data: [] }))
    await fetchSnowflakeSchema(source(fetch, { schema: 'public' }))
    expect(calls[0].url).toBe('https://xy12345.us-east-1.snowflakecomputing.com/api/v2/statements')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0].init)).toMatchObject({
      authorization: `Basic ${btoa('user:pass')}`,
      'x-snowflake-authorization-token-type': 'BASIC',
      'content-type': 'application/json',
    })
    const sql = sentSql(calls[0].init)
    expect(sql).toContain('FROM TESTDB.INFORMATION_SCHEMA.COLUMNS')
    expect(sql).toContain("AND TABLE_SCHEMA = 'PUBLIC'")
    expect(JSON.parse(String(calls[0].init.body)).timeout).toBe(30)
  })

  it('polls a 202 to completion on the injected clock', async () => {
    const clock = fakeClock()
    const { fetch, calls } = fetchSequence(
      json(202, { statementHandle: 'h-1', message: 'running' }),
      json(202, { statementHandle: 'h-1', message: 'still running' }),
      json(200, { data: [['PUBLIC', 'LEADS', 'ID', 'VARCHAR', 'NO']] }),
    )
    const schema = await fetchSnowflakeSchema(source(fetch, { poll: clock.poll }))
    expect(schema.objects.map((o) => o.name)).toEqual(['PUBLIC.LEADS'])
    expect(calls[1].url).toContain('/api/v2/statements/h-1')
    expect(clock.slept).toEqual([1500, 1500])
  })

  it('fetches every partition and concatenates the rows (#151)', async () => {
    const { fetch, calls } = fetchSequence(
      json(200, {
        statementHandle: 'h-9',
        data: [['PUBLIC', 'A', 'ID', 'VARCHAR', 'NO']],
        resultSetMetaData: { partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }] },
      }),
      json(200, { data: [['PUBLIC', 'B', 'ID', 'VARCHAR', 'NO']] }),
      json(200, { data: [['STAGING', 'C', 'ID', 'NUMBER', 'YES']] }),
    )
    const schema = await fetchSnowflakeSchema(source(fetch))
    expect(schema.objects.map((o) => o.name).sort()).toEqual(['PUBLIC.A', 'PUBLIC.B', 'STAGING.C'])
    expect(calls[1].url).toContain('/api/v2/statements/h-9?partition=1')
    expect(calls[2].url).toContain('/api/v2/statements/h-9?partition=2')
    expect(calls).toHaveLength(3)
  })

  it('does not fetch extra partitions for a single partition result (#151)', async () => {
    const { fetch, calls } = fetchSequence(json(200, {
      data: [['PUBLIC', 'A', 'ID', 'VARCHAR', 'NO']],
      resultSetMetaData: { partitionInfo: [{ rowCount: 1 }] },
    }))
    await fetchSnowflakeSchema(source(fetch))
    expect(calls).toHaveLength(1)
  })
})

describe('every failure is named, never an empty table or column list', () => {
  const statementCases: Array<[string, Answer, string, number | null]> = [
    ['401', json(401, { code: '390100', message: 'Incorrect username or password' }), 'schema_auth_refused', 401],
    ['403', json(403, { message: 'forbidden' }), 'schema_auth_refused', 403],
    ['500', text(500, 'Internal Server Error'), 'schema_service_error', 500],
    ['429', json(429, {}), 'schema_rate_limited', 429],
    ['a timeout', () => timeoutError(), 'schema_request_timeout', null],
    ['malformed JSON', text(200, '<html>'), 'schema_response_malformed', 200],
    ['a 200 with no data', json(200, { message: 'ok' }), 'schema_response_malformed', 200],
    ['a row that is not a row', json(200, { data: [['PUBLIC', 'A', 'ID', null, 'NO']] }), 'schema_response_malformed', 200],
    ['a 202 with no handle to poll', json(202, { message: 'accepted' }), 'schema_response_malformed', 202],
  ]
  for (const [label, answer, code, status] of statementCases) {
    it(`the statement: ${label}`, async () => {
      const err = await caught(fetchSnowflakeSchema(source(fetchSequence(answer).fetch)))
      expect([err.code, err.service, err.step, err.status]).toEqual([code, 'snowflake', 'statement', status])
    })
  }

  it('a poll that answers 500', async () => {
    const { fetch } = fetchSequence(json(202, { statementHandle: 'h-3' }), text(500, 'internal error'))
    const err = await caught(fetchSnowflakeSchema(source(fetch)))
    expect([err.code, err.step, err.status]).toEqual(['schema_service_error', 'statement_poll', 500])
  })

  it('a poll that times out', async () => {
    const { fetch } = fetchSequence(json(202, { statementHandle: 'h-3' }), timeoutError())
    const err = await caught(fetchSnowflakeSchema(source(fetch)))
    expect([err.code, err.step]).toEqual(['schema_request_timeout', 'statement_poll'])
  })

  it('a query still running when the wait ends, on the injected clock', async () => {
    const clock = fakeClock()
    const { fetch } = fetchSequence(json(202, { statementHandle: 'h-2' }))
    const err = await caught(fetchSnowflakeSchema(source(fetch, { poll: clock.poll })))
    expect([err.code, err.step]).toEqual(['schema_query_still_running', 'statement_poll'])
    expect(err.message).toMatch(/still running/)
    // 20 s of waiting at 1.5 s a poll, slept on the fake clock, not for real.
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20000)
  })

  it('a partition that fails, so a truncated set is never cached (#151)', async () => {
    const { fetch } = fetchSequence(
      json(200, {
        statementHandle: 'h-err',
        data: [['PUBLIC', 'A', 'ID', 'VARCHAR', 'NO']],
        resultSetMetaData: { partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] },
      }),
      text(500, 'partition gone'),
    )
    const err = await caught(fetchSnowflakeSchema(source(fetch)))
    expect([err.code, err.step, err.subject, err.status]).toEqual(['schema_service_error', 'statement_partition', '1', 500])
  })

  it('a multi partition result with no handle to fetch the rest', async () => {
    const { fetch } = fetchSequence(json(200, {
      data: [['PUBLIC', 'A', 'ID', 'VARCHAR', 'NO']],
      resultSetMetaData: { partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] },
    }))
    const err = await caught(fetchSnowflakeSchema(source(fetch)))
    expect([err.code, err.step]).toEqual(['schema_response_malformed', 'statement'])
  })
})

describe('keyed lookups', () => {
  it('tables: every table, from INFORMATION_SCHEMA.TABLES', async () => {
    const { fetch, calls } = fetchSequence(json(200, { data: [['PUBLIC', 'LEADS'], ['STAGING', 'RAW']] }))
    expect(await listSnowflakeTables(source(fetch, { schema: 'public' }))).toEqual([
      { name: 'PUBLIC.LEADS', label: 'PUBLIC.LEADS' },
      { name: 'STAGING.RAW', label: 'STAGING.RAW' },
    ])
    const sql = sentSql(calls[0].init)
    expect(sql).toContain('FROM TESTDB.INFORMATION_SCHEMA.TABLES')
    expect(sql).toContain("AND TABLE_SCHEMA = 'PUBLIC'")
  })

  it('columns of a table: that table only, its names escaped as literals', async () => {
    const { fetch, calls } = fetchSequence(json(200, { data: [['PUBLIC', 'LEADS', 'ID', 'VARCHAR', 'NO']] }))
    const fields = await describeSnowflakeTable(source(fetch), "PUBLIC.LE'ADS")
    expect(fields).toEqual([{ name: 'ID', label: 'ID', type: 'varchar', nullable: false }])
    const sql = sentSql(calls[0].init)
    expect(sql).toContain("TABLE_SCHEMA = 'PUBLIC'")
    expect(sql).toContain("TABLE_NAME = 'LE''ADS'")
  })

  it('columns of a table that does not exist: schema_not_found, never an empty column list', async () => {
    const err = await caught(describeSnowflakeTable(source(fetchSequence(json(200, { data: [] })).fetch), 'PUBLIC.NOPE'))
    expect([err.code, err.subject]).toEqual(['schema_not_found', 'PUBLIC.NOPE'])
  })

  it('a table name with no schema part is refused before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, { data: [] }))
    const err = await caught(describeSnowflakeTable(source(fetch), 'LEADS'))
    expect(err.code).toBe('schema_key_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a database that is not a plain identifier is refused before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, { data: [] }))
    const err = await caught(listSnowflakeTables(source(fetch, { database: 'X; DROP TABLE Y' })))
    expect(err.code).toBe('schema_source_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('an account that is not a host label is refused before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, { data: [] }))
    const err = await caught(listSnowflakeTables(source(fetch, { account: 'evil.example.com/x?' })))
    expect(err.code).toBe('schema_source_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })
})
