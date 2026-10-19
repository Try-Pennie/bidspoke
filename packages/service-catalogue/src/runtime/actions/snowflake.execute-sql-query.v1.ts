import { ActionFailure } from '../failure'
import { bindText, rowObjects, runSnowflakeStatement, snowflakeTargetOf } from '../snowflake/statement'
import type { ActionRun, JsonValue } from '../types'

/**
 * snowflake.execute-sql-query, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Parity with Pipedream's Execute SQL Query (PipedreamHQ/pipedream
 * components/snowflake/actions/execute-sql-query/execute-sql-query.mjs, at
 * commit b7d67916), re-implemented over the SQL API rather than copied: it runs
 * one statement with positional `?` binds and returns its rows as objects keyed
 * by column name, as the Pipedream driver's rows were. Its result is read in
 * full or the step fails by name (statement.ts), never a prefix.
 */
export const run: ActionRun = async (ctx, args) => {
  const sql = args.sql
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new ActionFailure('snowflake_sql_missing', 'the step holds no SQL to run', 'not_applied')
  }
  const binds = args.binds ?? []
  if (!Array.isArray(binds)) throw new ActionFailure('snowflake_bind_invalid', 'the binds must be a list of values', 'not_applied')
  const bindings = binds.map((value, i) => {
    const text = bindText(value, `bind ${i + 1}`)
    if (text === null) {
      throw new ActionFailure('snowflake_bind_invalid', `bind ${i + 1} is null, which a bind cannot carry; write NULL in the SQL instead`, 'not_applied')
    }
    return text
  })
  const target = snowflakeTargetOf(ctx.target)
  const result = await runSnowflakeStatement(ctx, target, { statement: sql, bindings })
  return rowObjects(result) as JsonValue
}
