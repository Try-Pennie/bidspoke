import { buildInsert } from '../snowflake/insert'
import { rowObjects, runSnowflakeStatement, snowflakeTargetOf } from '../snowflake/statement'
import type { ActionRun, JsonValue } from '../types'

/**
 * snowflake.insert-multiple-rows, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Every row in one INSERT (snowflake/insert.ts says how this differs from
 * Pipedream's batching and why), returning Snowflake's count row as the
 * Pipedream action's unbatched insert returned it.
 */
export const run: ActionRun = async (ctx, args) => {
  const target = snowflakeTargetOf(ctx.target)
  const insert = buildInsert({ database: args.database, schema: args.schema, table: args.table, columns: args.columns, values: args.values })
  const result = await runSnowflakeStatement(ctx, target, insert)
  return rowObjects(result) as JsonValue
}
