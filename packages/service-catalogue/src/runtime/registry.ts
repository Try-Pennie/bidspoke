import { SNOWFLAKE_EXECUTE_SQL_QUERY_V1, SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1 } from '../schema/services/snowflake'
import { run as snowflakeExecuteSqlQueryV1 } from './actions/snowflake.execute-sql-query.v1'
import { run as snowflakeInsertMultipleRowsV1 } from './actions/snowflake.insert-multiple-rows.v1'
import { implement, type RuntimeAction, type ServiceRuntime } from './types'

/**
 * Every shipped action's run, paired with its schema through `implement`, and
 * every service's auth functions. Each service arrives in its own PR of #2337.
 *
 * Each action's run is exported as `run` from its own file,
 * `runtime/actions/<key>.v<version>.ts`, and imported here. The catalogue
 * checks import that file and refuse a registered run that is not the one it
 * exports, because the version fingerprint is taken over that file and what it
 * imports: a run written anywhere else would change without its fingerprint
 * moving.
 */
export const RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  implement(SNOWFLAKE_EXECUTE_SQL_QUERY_V1, snowflakeExecuteSqlQueryV1),
  implement(SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1, snowflakeInsertMultipleRowsV1),
]

/**
 * Snowflake has no entry: a key pair login needs no consent URL or refresh, and
 * its verify is the ops Worker's identity probe (apps/worker
 * src/ops/connections/snowflake-service.ts), which sends its statement through
 * this package's Snowflake client (runtime/snowflake/statement.ts).
 */
export const SERVICE_RUNTIMES: readonly ServiceRuntime[] = []
