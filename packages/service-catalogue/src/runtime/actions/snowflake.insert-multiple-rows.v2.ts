import { buildInsert, type InsertCaps } from '../snowflake/insert-rows'
import { rowObjects, runSnowflakeStatement, snowflakeTargetOf } from '../snowflake/statement'
import type { ActionRun, JsonValue } from '../types'

/**
 * snowflake.insert-multiple-rows, version 2 (#2487). Released: never edit it; a
 * change is version 3 (the fingerprint check refuses an edit).
 *
 * Version 1 with its caps corrected against Snowflake's docs (checked
 * 2026-10-28), and nothing else changed: the same statement, the same
 * refusals and the same count row. Version 1 accepted up to 4 MB, a size
 * Snowflake says it cannot rerun or retry; this version refuses anything past
 * 1 MB before it is sent. Version 1 stays for the steps pinned to it.
 */

export const SNOWFLAKE_INSERT_V2_CAPS: InsertCaps = {
  // Snowflake limits a VALUES clause to 200,000 rows
  // (https://docs.snowflake.com/en/sql-reference/sql/insert). 16,384 is kept,
  // as version 1 had it, as a stricter margin; the size cap below binds first
  // for all but the narrowest rows.
  maxRows: 16_384,
  // Snowflake recommends at most 1 MB of statement text per statement, binds
  // included, and truncates a larger one before saving it, so it cannot be
  // rerun or retried (https://docs.snowflake.com/en/user-guide/query-size-limits).
  // A timed out insert is the one the executor sends again, so it must stay
  // within what Snowflake can retry. Measured uncompressed, the safe reading.
  maxBodyBytes: 1024 * 1024,
}

export const run: ActionRun = async (ctx, args) => {
  const target = snowflakeTargetOf(ctx.target)
  const insert = buildInsert({ database: args.database, schema: args.schema, table: args.table, columns: args.columns, values: args.values }, SNOWFLAKE_INSERT_V2_CAPS)
  const result = await runSnowflakeStatement(ctx, target, insert)
  return rowObjects(result) as JsonValue
}
