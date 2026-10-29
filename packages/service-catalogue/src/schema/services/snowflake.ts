import type { ActionSchema, ServiceSchema } from '../types'

/**
 * Snowflake (#2337, the first service of phase 7 of #1689): the two actions the
 * Pipedream workflows use, counted in the export of 2026-09-30. Execute SQL
 * Query is on 19 steps (snowflake-execute-sql-query 0.2.2 to 0.2.4, and one on
 * snowflake_oauth), Insert Multiple Rows on 2 (snowflake-insert-multiple-rows
 * 0.1.4). Nothing else of Pipedream's Snowflake app is used.
 *
 * The connection is a key pair login (`{ private_key }`, the ops minter
 * minters/snowflake.ts) whose target declares `{ account, user }` and, as
 * Pipedream's connection did, an optional `warehouse`, `role`, `database` and
 * `schema` for the session.
 */

export const SNOWFLAKE_EXECUTE_SQL_QUERY_V1: ActionSchema = {
  key: 'snowflake.execute-sql-query',
  name: 'Execute SQL query',
  version: 1,
  arguments: [
    // Never a variable inside the SQL itself: a step's value reaches the
    // statement only as a bind, as Pipedream's SQL field turned its references
    // into parameters, so no value can become SQL.
    { key: 'sql', type: 'code', required: true, allowsVariables: false, parseJson: false },
    { key: 'binds', type: 'list', required: false, allowsVariables: true, parseJson: true },
  ],
  realSend: 'runs a real SQL statement in Snowflake',
  sideEffect: true,
  // #2339: true from the step request id, never from the SQL, which may write.
  idempotent: true,
  idempotentBecause:
    'The statement may be an INSERT, UPDATE, MERGE or CALL as easily as a SELECT, but it is sent under the step\'s stable request id with retry=true, and Snowflake does not run again a statement it has already run successfully under that id, so sending it again after an uncertain outcome applies it at most once.',
}

export const SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1: ActionSchema = {
  key: 'snowflake.insert-multiple-rows',
  name: 'Insert multiple rows',
  version: 1,
  arguments: [
    { key: 'database', type: 'text', required: true, allowsVariables: true, parseJson: false },
    { key: 'schema', type: 'text', required: true, allowsVariables: true, parseJson: false },
    { key: 'table', type: 'text', required: true, allowsVariables: true, parseJson: false },
    { key: 'columns', type: 'list', required: true, allowsVariables: true, parseJson: true },
    { key: 'values', type: 'code', required: true, allowsVariables: true, parseJson: true },
  ],
  realSend: 'inserts real rows into Snowflake',
  sideEffect: true,
  // #2339: the step request id is the key Snowflake deduplicates the INSERT on.
  idempotent: true,
  idempotentBecause:
    'The INSERT is sent under the step\'s stable request id with retry=true, and Snowflake does not run again a statement it has already run successfully under that id, so sending the same rows again after an uncertain outcome writes them at most once.',
}

/**
 * Version 2 of Insert Multiple Rows (#2487): the same arguments, traits and
 * statement, with the size cap lowered from 4 MB to the 1 MB Snowflake says it
 * can retry, and the row cap's reason corrected. Version 1 stays for the steps
 * pinned to it.
 */
export const SNOWFLAKE_INSERT_MULTIPLE_ROWS_V2: ActionSchema = {
  ...SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1,
  version: 2,
}

export const SNOWFLAKE_SERVICE: ServiceSchema = {
  key: 'snowflake',
  name: 'Snowflake',
  actions: [SNOWFLAKE_EXECUTE_SQL_QUERY_V1, SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1, SNOWFLAKE_INSERT_MULTIPLE_ROWS_V2],
  // The key pair minter reads `private_key` from the login and `account` and
  // `user` from the target; the catalogue's Snowflake client (snowflakeTargetOf)
  // reads the four optional session fields.
  connection: {
    tile: 'A user and account, signed in by key pair',
    auth: 'key_pair',
    fields: [
      { key: 'account', label: 'Account', input: 'text', required: true, target: 'account' },
      { key: 'user', label: 'User', input: 'text', required: true, target: 'user' },
      { key: 'private_key', label: 'Private key', input: 'secret_block', required: true, login: 'private_key' },
      { key: 'warehouse', label: 'Warehouse', input: 'text', required: false, target: 'warehouse' },
      { key: 'role', label: 'Role', input: 'text', required: false, target: 'role' },
      { key: 'database', label: 'Database', input: 'text', required: false, target: 'database' },
      { key: 'schema', label: 'Schema', input: 'text', required: false, target: 'schema' },
    ],
  },
}
