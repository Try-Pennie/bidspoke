import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { SNOWFLAKE_INSERT_MAX_BODY_BYTES, SNOWFLAKE_INSERT_MAX_ROWS } from '../insert'
import { STATEMENTS_URL, fakeSnowflake, partition, resultSet, statementError } from './fake-snowflake'

/**
 * The two Snowflake actions the Pipedream workflows use (#2337; surveyed from
 * the export of 2026-09-30): Execute SQL Query (19 steps) and Insert Multiple
 * Rows (2 steps). Each has the four fixtures every service PR carries: an
 * expired login, revoked consent, a 429 with Retry-After and a partial batch,
 * and the timeout after send that a non idempotent action must leave to the
 * executor as outcome unknown.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const SQL = action('snowflake.execute-sql-query')
const INSERT = action('snowflake.insert-multiple-rows')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const INSERTED = () => resultSet([{ name: 'number of rows inserted', type: 'fixed', scale: 0 }], [['2']])
const INSERT_ARGS: ActionArgs = {
  database: 'analytics',
  schema: 'enrollment',
  table: 'daily_sync',
  columns: ['ID', 'AMOUNT', 'NOTE', 'META'],
  values: [
    [1, 12.5, 'first', { a: 1 }],
    [2, null, true, null],
  ],
}

describe('both actions decide their own traits', () => {
  it('are side effecting and not idempotent, and say why', () => {
    for (const a of [SQL, INSERT]) {
      expect([a.sideEffect, a.idempotent]).toEqual([true, false])
      expect(a.idempotentBecause.length).toBeGreaterThan(40)
    }
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('snowflake.'))).toEqual([
      'snowflake.execute-sql-query@1',
      'snowflake.insert-multiple-rows@1',
    ])
  })

  it('take the statement as code that never carries a variable, and its values only as binds', () => {
    const sql = SQL.arguments.find((a) => a.key === 'sql')!
    expect([sql.type, sql.required, sql.allowsVariables]).toEqual(['code', true, false])
    const binds = SQL.arguments.find((a) => a.key === 'binds')!
    expect([binds.required, binds.allowsVariables, binds.parseJson]).toEqual([false, true, true])
  })
})

describe('snowflake.execute-sql-query@1', () => {
  it('runs the statement with its binds and returns one object per row, as the Pipedream action did', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet([{ name: 'ID', type: 'fixed', scale: 0 }, { name: 'NAME', type: 'text' }], [['1', 'Ada'], ['2', null]]))
    expect(await SQL.run(f.ctx, { sql: 'select id, name from t where day = ? and n > ?', binds: ['2026-10-01', 3] })).toEqual([
      { ID: 1, NAME: 'Ada' },
      { ID: 2, NAME: null },
    ])
    expect(f.sent[0].body?.bindings).toEqual({ 1: { type: 'TEXT', value: '2026-10-01' }, 2: { type: 'TEXT', value: '3' } })
  })

  it('refuses a missing statement and a bind it cannot send, before anything is sent', async () => {
    for (const args of [{}, { sql: '  ' }, { sql: 'select ?', binds: [null] }, { sql: 'select ?', binds: 'not a list' }]) {
      const f = fakeSnowflake()
      const refused = await failure(SQL.run(f.ctx, args as ActionArgs))
      expect(refused.outcome).toBe('not_applied')
      expect(f.sent).toEqual([])
    }
  })

  it('a target with no account is refused before anything is sent', async () => {
    const f = fakeSnowflake({ user: 'ops_reader' })
    expect((await failure(SQL.run(f.ctx, { sql: 'select 1' }))).code).toBe('snowflake_target_invalid')
    expect(f.sent).toEqual([])
  })

  it('an expired login: what the connection bound fetch throws is passed on unchanged, and nothing more is sent', async () => {
    const expired = new Error('needs_reauth: request_refused_after_renew')
    const f = fakeSnowflake()
    f.respond(expired)
    await expect(SQL.run(f.ctx, { sql: 'select 1' })).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('revoked consent: a role that lost its grant is a statement Snowflake refused, not applied', async () => {
    const f = fakeSnowflake()
    f.respond(statementError(422, '003001', 'SQL access control error: Insufficient privileges to operate on table.'))
    const refused = await failure(SQL.run(f.ctx, { sql: 'select * from t' }))
    expect([refused.code, refused.outcome]).toEqual(['snowflake_statement_failed', 'not_applied'])
  })

  it('a 429 with Retry-After: not run, and the wait is named', async () => {
    const f = fakeSnowflake()
    f.respond(new Response('{}', { status: 429, headers: { 'retry-after': '20' } }))
    const limited = await failure(SQL.run(f.ctx, { sql: 'select 1' }))
    expect([limited.code, limited.outcome]).toEqual(['snowflake_rate_limited', 'not_applied'])
    expect(limited.message).toContain('20')
  })

  it('a partial batch: a later result partition that fails fails the step as applied, never a prefix of the rows', async () => {
    const f = fakeSnowflake()
    f.respond(resultSet([{ name: 'N', type: 'fixed', scale: 0 }], [['1']], { numRows: 2, partitions: [1, 1] }), new Error('connection_rate_limited'))
    const partial = await failure(SQL.run(f.ctx, { sql: 'select n from t' }))
    expect([partial.code, partial.outcome]).toEqual(['snowflake_result_unread', 'applied'])
  })

  it('a timeout after send is passed on unchanged: the executor records it as outcome unknown, since the action is not idempotent', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeSnowflake()
    f.respond(timeout)
    await expect(SQL.run(f.ctx, { sql: 'delete from t' })).rejects.toBe(timeout)
    expect(SQL.idempotent).toBe(false)
  })
})

describe('snowflake.insert-multiple-rows@1', () => {
  it('inserts every row in ONE statement, a NULL as a literal and every other value as a bind, and returns the count row', async () => {
    const f = fakeSnowflake()
    f.respond(INSERTED())
    expect(await INSERT.run(f.ctx, INSERT_ARGS)).toEqual([{ 'number of rows inserted': 2 }])
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].url.startsWith(`${STATEMENTS_URL}?requestId=`)).toBe(true)
    expect(f.sent[0].body?.statement).toBe('INSERT INTO ANALYTICS.ENROLLMENT.DAILY_SYNC (ID, AMOUNT, NOTE, META) VALUES (?, ?, ?, ?), (?, NULL, ?, NULL)')
    expect(f.sent[0].body?.bindings).toEqual({
      1: { type: 'TEXT', value: '1' },
      2: { type: 'TEXT', value: '12.5' },
      3: { type: 'TEXT', value: 'first' },
      4: { type: 'TEXT', value: '{"a":1}' },
      5: { type: 'TEXT', value: '2' },
      6: { type: 'TEXT', value: 'true' },
    })
  })

  it('refuses, before anything is sent, a name that is not a plain identifier, rows of the wrong width and rows that are not a list of lists', async () => {
    const cases: ActionArgs[] = [
      { ...INSERT_ARGS, table: 'daily_sync; drop table x' },
      { ...INSERT_ARGS, columns: ['ID', 'ID', 'NOTE', 'META'] },
      { ...INSERT_ARGS, columns: [] },
      { ...INSERT_ARGS, values: [[1, 2]] },
      { ...INSERT_ARGS, values: [] },
      { ...INSERT_ARGS, values: { not: 'rows' } },
      { ...INSERT_ARGS, values: [[1, 2, 3, Number.NaN]] },
    ]
    for (const args of cases) {
      const f = fakeSnowflake()
      const refused = await failure(INSERT.run(f.ctx, args))
      expect(refused.outcome).toBe('not_applied')
      expect(f.sent).toEqual([])
    }
  })

  it('refuses by name, before anything is sent, more rows than one statement may carry, and a body past its cap', async () => {
    const tooMany = fakeSnowflake()
    const rows = Array.from({ length: SNOWFLAKE_INSERT_MAX_ROWS + 1 }, (_, i) => [i])
    const many = await failure(INSERT.run(tooMany.ctx, { ...INSERT_ARGS, columns: ['ID'], values: rows }))
    expect([many.code, many.outcome]).toEqual(['snowflake_insert_over_cap', 'not_applied'])
    expect(many.message).toContain(String(SNOWFLAKE_INSERT_MAX_ROWS))

    const tooBig = fakeSnowflake()
    const wide = 'x'.repeat(Math.ceil(SNOWFLAKE_INSERT_MAX_BODY_BYTES / 10))
    const big = await failure(INSERT.run(tooBig.ctx, { ...INSERT_ARGS, columns: ['NOTE'], values: Array.from({ length: 11 }, () => [wide]) }))
    expect([big.code, big.outcome]).toEqual(['snowflake_insert_over_cap', 'not_applied'])
    expect([tooMany.sent, tooBig.sent]).toEqual([[], []])
  })

  it('a partial batch cannot happen: a statement Snowflake refused inserted nothing, and no second request is ever sent', async () => {
    const f = fakeSnowflake()
    f.respond(statementError(422, '100038', "Numeric value 'abc' is not recognized"))
    const refused = await failure(INSERT.run(f.ctx, INSERT_ARGS))
    expect([refused.code, refused.outcome]).toEqual(['snowflake_statement_failed', 'not_applied'])
    expect(f.sent).toHaveLength(1)
  })

  it('an expired login, revoked consent and a 429 with Retry-After each send exactly one request', async () => {
    const expired = new Error('needs_reauth: request_refused_after_renew')
    const a = fakeSnowflake()
    a.respond(expired)
    await expect(INSERT.run(a.ctx, INSERT_ARGS)).rejects.toBe(expired)

    const b = fakeSnowflake()
    b.respond(statementError(422, '003001', 'Insufficient privileges to operate on table.'))
    expect((await failure(INSERT.run(b.ctx, INSERT_ARGS))).outcome).toBe('not_applied')

    const c = fakeSnowflake()
    c.respond(new Response('{}', { status: 429, headers: { 'retry-after': '5' } }))
    expect((await failure(INSERT.run(c.ctx, INSERT_ARGS))).code).toBe('snowflake_rate_limited')
    expect([a.sent.length, b.sent.length, c.sent.length]).toEqual([1, 1, 1])
  })

  it('a timeout after send is passed on unchanged, for the executor to record as outcome unknown', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeSnowflake()
    f.respond(timeout)
    await expect(INSERT.run(f.ctx, INSERT_ARGS)).rejects.toBe(timeout)
  })

  it('an answer read after the insert ran but not in full is applied, so it is never repeated', async () => {
    const f = fakeSnowflake()
    f.respond(partition([['2']]))
    expect((await failure(INSERT.run(f.ctx, INSERT_ARGS))).outcome).toBe('applied')
  })
})
