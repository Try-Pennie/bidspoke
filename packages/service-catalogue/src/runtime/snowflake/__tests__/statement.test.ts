import { describe, expect, it } from 'vitest'
import { ActionFailure } from '../../failure'
import {
  SNOWFLAKE_MAX_POLLS, SNOWFLAKE_MAX_RESULT_ROWS, SNOWFLAKE_POLL_INTERVAL_MS, SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS,
  rowObjects, runSnowflakeStatement, snowflakeHost, snowflakeTargetOf,
} from '../statement'
import { STATEMENTS_URL, TARGET, fakeSnowflake, partition, resultSet, running, statementError } from './fake-snowflake'

/**
 * The catalogue's one Snowflake SQL API client (#2337): what both Snowflake
 * actions and the ops verify probe send a statement through. Every request goes
 * through the connection bound fetch the caller is handed, which applies the key
 * pair JWT; this module never holds a login.
 */

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const ONE_COLUMN = [{ name: 'N', type: 'fixed', scale: 0 }]

describe('the declared target', () => {
  it('reads the account and user, and the optional session fields, refusing a target that names no usable account', () => {
    expect(snowflakeTargetOf(TARGET)).toEqual({ ...TARGET, database: undefined, schema: undefined })
    for (const bad of [null, [], {}, { account: 'ab12345', user: '' }, { account: 'https://evil.example/', user: 'x' }, { ...TARGET, warehouse: 7 }]) {
      expect(() => snowflakeTargetOf(bad)).toThrow(ActionFailure)
    }
  })

  it('names the host the way the export path does: the account, lower case, under snowflakecomputing.com', () => {
    expect(snowflakeHost('AB12345.US-EAST-1')).toBe('ab12345.us-east-1.snowflakecomputing.com')
  })
})

describe('runSnowflakeStatement', () => {
  it('posts the statement once, with a request id, the session the target declares and the binds as strings', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet(ONE_COLUMN, [['1']]))
    const result = await runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select ?', bindings: ['1'] })
    expect(result.rows).toEqual([['1']])
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].method).toBe('POST')
    expect(f.sent[0].url).toMatch(new RegExp(`^${STATEMENTS_URL}\\?requestId=[0-9a-f-]{36}$`))
    expect(f.sent[0].body).toEqual({
      statement: 'select ?',
      timeout: SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS,
      warehouse: 'OPS_WH',
      role: 'OPS_ROLE',
      bindings: { 1: { type: 'TEXT', value: '1' } },
    })
  })

  it('polls a statement that went async until it completes, sleeping between polls, a 429 on a poll meaning still running', async () => {
    const f = fakeSnowflake()
    f.respond(running('h-1'), running('h-1'), new Response('{}', { status: 429 }), resultSet(ONE_COLUMN, [['7']], { handle: 'h-1' }))
    const result = await runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select 7' })
    expect(result.rows).toEqual([['7']])
    expect(f.sent.slice(1).map((s) => [s.method, s.url])).toEqual(Array(3).fill(['GET', `${STATEMENTS_URL}/h-1`]))
    expect(f.slept).toEqual([SNOWFLAKE_POLL_INTERVAL_MS, SNOWFLAKE_POLL_INTERVAL_MS, SNOWFLAKE_POLL_INTERVAL_MS])
  })

  it('stops polling at its cap, or when the step gives up, as an unknown outcome naming the handle', async () => {
    const capped = fakeSnowflake()
    capped.respond(...Array.from({ length: SNOWFLAKE_MAX_POLLS + 1 }, () => running('h-2')))
    const atCap = await failure(runSnowflakeStatement(capped.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' }))
    expect([atCap.code, atCap.outcome]).toEqual(['snowflake_statement_unfinished', 'unknown'])
    expect(atCap.message).toContain('h-2')
    expect(capped.sent).toHaveLength(SNOWFLAKE_MAX_POLLS + 1)

    const abandoned = fakeSnowflake()
    abandoned.respond(running('h-3'))
    abandoned.controller.abort()
    const gaveUp = await failure(runSnowflakeStatement(abandoned.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' }))
    expect([gaveUp.code, gaveUp.outcome]).toEqual(['snowflake_statement_unfinished', 'unknown'])
    expect(abandoned.sent).toHaveLength(1)
  })

  it('reads every partition, and a partition it cannot read fails the whole statement as unread, never a prefix', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet(ONE_COLUMN, [['1']], { numRows: 3, partitions: [1, 1, 1], handle: 'h-4' }), partition([['2']]), partition([['3']]))
    const result = await runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select n' })
    expect(result.rows).toEqual([['1'], ['2'], ['3']])
    expect(f.sent.slice(1).map((s) => s.url)).toEqual([`${STATEMENTS_URL}/h-4?partition=1`, `${STATEMENTS_URL}/h-4?partition=2`])

    // The partial batch: the statement ran, the second partition failed.
    const partial = fakeSnowflake()
    partial.respond(resultSet(ONE_COLUMN, [['1']], { numRows: 3, partitions: [1, 1, 1] }), partition([['2']]), new Response('busy', { status: 503 }))
    const failed = await failure(runSnowflakeStatement(partial.ctx, snowflakeTargetOf(TARGET), { statement: 'select n' }))
    expect([failed.code, failed.outcome]).toEqual(['snowflake_result_unread', 'applied'])
    expect(failed.message).toContain('partition 2 of 3')
  })

  it('a refusal thrown while reading a later partition (a 429 requeue) is not passed on: the statement already ran', async () => {
    const requeue = new Error('connection_rate_limited')
    const f = fakeSnowflake()
    f.respond(resultSet(ONE_COLUMN, [['1']], { numRows: 2, partitions: [1, 1] }), requeue)
    const failed = await failure(runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select n' }))
    expect([failed.code, failed.outcome]).toEqual(['snowflake_result_unread', 'applied'])
  })

  it('refuses a result short of the rows Snowflake declared, and one over the row cap before fetching any partition', async () => {
    const short = fakeSnowflake()
    short.respond(resultSet(ONE_COLUMN, [['1']], { numRows: 2 }))
    expect((await failure(runSnowflakeStatement(short.ctx, snowflakeTargetOf(TARGET), { statement: 'x' }))).code).toBe('snowflake_result_incomplete')

    const big = fakeSnowflake()
    big.respond(resultSet(ONE_COLUMN, [['1']], { numRows: SNOWFLAKE_MAX_RESULT_ROWS + 1, partitions: [1, SNOWFLAKE_MAX_RESULT_ROWS] }))
    const over = await failure(runSnowflakeStatement(big.ctx, snowflakeTargetOf(TARGET), { statement: 'x' }))
    expect([over.code, over.outcome]).toEqual(['snowflake_result_over_cap', 'applied'])
    expect(over.message).toContain(String(SNOWFLAKE_MAX_RESULT_ROWS))
    expect(big.sent).toHaveLength(1)
  })

  it('a statement Snowflake refused is not applied, carrying its code; a 5xx on the send is an unknown outcome', async () => {
    // Revoked consent: the role lost its grant, so Snowflake refuses the statement.
    const revoked = fakeSnowflake()
    revoked.respond(statementError(422, '003001', 'SQL access control error: Insufficient privileges to operate on table.'))
    const refused = await failure(runSnowflakeStatement(revoked.ctx, snowflakeTargetOf(TARGET), { statement: 'insert ...' }))
    expect([refused.code, refused.outcome]).toEqual(['snowflake_statement_failed', 'not_applied'])
    expect(refused.message).toContain('003001')

    const internal = fakeSnowflake()
    internal.respond(new Response('upstream reset', { status: 502 }))
    const unknown = await failure(runSnowflakeStatement(internal.ctx, snowflakeTargetOf(TARGET), { statement: 'insert ...' }))
    expect([unknown.code, unknown.outcome]).toEqual(['snowflake_statement_failed', 'unknown'])
  })

  it('a 429 answered to the send itself was not executed, and says when to come back', async () => {
    const f = fakeSnowflake()
    f.respond(new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
    const limited = await failure(runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' }))
    expect([limited.code, limited.outcome]).toEqual(['snowflake_rate_limited', 'not_applied'])
    expect(limited.message).toContain('30')
  })

  it('passes on, unchanged, whatever the connection bound fetch throws for the send: an expired login or a timeout is the executor\'s to judge', async () => {
    const expired = new Error('needs_reauth: request_refused_after_renew')
    const f = fakeSnowflake()
    f.respond(expired)
    await expect(runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' })).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('an answer it cannot read is an unknown outcome, never an empty result', async () => {
    const f = fakeSnowflake()
    f.respond(new Response('not json', { status: 200 }))
    const unreadable = await failure(runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' }))
    expect([unreadable.code, unreadable.outcome]).toEqual(['snowflake_answer_unreadable', 'unknown'])
    const noRowType = fakeSnowflake()
    noRowType.respond(Response.json({ data: [['1']] }))
    expect((await failure(runSnowflakeStatement(noRowType.ctx, snowflakeTargetOf(TARGET), { statement: 'select 1' }))).code).toBe('snowflake_answer_unreadable')
  })
})

describe('rowObjects: rows as the Pipedream action returned them, one object per row keyed by column name', () => {
  const columns = [
    { name: 'ID', type: 'fixed', scale: 0 },
    { name: 'BIG', type: 'fixed', scale: 0 },
    { name: 'AMOUNT', type: 'fixed', scale: 2 },
    { name: 'RATIO', type: 'real' },
    { name: 'OK', type: 'boolean' },
    { name: 'NAME', type: 'text' },
    { name: 'DAY', type: 'date' },
    { name: 'AT', type: 'timestamp_ntz' },
    { name: 'AT_TZ', type: 'timestamp_tz' },
    { name: 'AT_LTZ', type: 'timestamp_ltz' },
    { name: 'CLOCK', type: 'time' },
    { name: 'DOC', type: 'variant' },
    { name: 'RAW', type: 'binary' },
  ]

  it('converts each Snowflake type from its string encoding, and keeps a NULL as null', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet(columns, [
      ['42', '90071992547409930', '12.50', '0.25', 'true', 'Ada', '18262', '1600000000.123000000', '1600000000.000000000 1500', '1600000000.000000000', '45296.500000000', '{"a":[1,2]}', 'CAFE'],
      [null, null, null, null, null, null, null, null, null, null, null, null, null],
    ]))
    const result = await runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select *' })
    expect(rowObjects(result)).toEqual([
      {
        ID: 42, BIG: '90071992547409930', AMOUNT: 12.5, RATIO: 0.25, OK: true, NAME: 'Ada', DAY: '2020-01-01T00:00:00.000Z',
        AT: '2020-09-13T12:26:40.123Z', AT_TZ: '2020-09-13T12:26:40.000Z', AT_LTZ: '2020-09-13T12:26:40.000Z', CLOCK: '12:34:56.500',
        DOC: { a: [1, 2] }, RAW: 'CAFE',
      },
      Object.fromEntries(columns.map((c) => [c.name, null])),
    ])
  })

  it('refuses two columns with one name rather than letting one silently replace the other', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet([{ name: 'ID', type: 'text' }, { name: 'ID', type: 'text' }], [['a', 'b']]))
    const result = await runSnowflakeStatement(f.ctx, snowflakeTargetOf(TARGET), { statement: 'select a.id, b.id' })
    try {
      rowObjects(result)
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ActionFailure)
      expect((err as ActionFailure).code).toBe('snowflake_duplicate_column')
    }
  })
})
