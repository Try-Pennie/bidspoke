import { ActionFailure } from '../failure'
import { bindText } from './statement'

/**
 * The statement snowflake.insert-multiple-rows sends (#2337): every row in ONE
 * INSERT, so it lands whole or not at all.
 *
 * Parity with Pipedream's Insert Multiple Rows (PipedreamHQ/pipedream
 * components/snowflake/actions/insert-multiple-rows/insert-multiple-rows.mjs and
 * snowflake.app.mjs insertRows, at commit b7d67916), re-implemented rather than
 * copied, with two deliberate differences:
 *  - Pipedream split more than 50 rows into batches sent one after another and,
 *    when one failed, went on with the rest and reported a partial insert. A
 *    retry of that step then inserted the landed batches twice. Here there is no
 *    partial batch to repeat: past the caps below the step is refused by name
 *    before anything is sent.
 *  - Pipedream wrote the table and column names into the SQL as given. Here each
 *    must be a plain unquoted identifier, so a value can never become SQL.
 */

/** The most rows one INSERT's VALUES list may carry. Snowflake's own limit on a VALUES list (16,384) is the ceiling. */
export const SNOWFLAKE_INSERT_MAX_ROWS = 16_384
/** The largest request body sent, the size Pipedream sized its batches to (5 MB) less a margin. */
export const SNOWFLAKE_INSERT_MAX_BODY_BYTES = 4 * 1024 * 1024

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/

const refuse = (code: string, message: string) => new ActionFailure(code, message, 'not_applied')

function identifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw refuse('snowflake_identifier_invalid', `the ${what} must be a plain Snowflake name (letters, digits, _ and $, not starting with a digit)`)
  }
  return value.toUpperCase()
}

export interface InsertStatement {
  readonly statement: string
  readonly bindings: string[]
}

export function buildInsert(args: { database: unknown; schema: unknown; table: unknown; columns: unknown; values: unknown }): InsertStatement {
  const table = [identifier(args.database, 'database'), identifier(args.schema, 'schema'), identifier(args.table, 'table')].join('.')
  if (!Array.isArray(args.columns) || args.columns.length === 0) throw refuse('snowflake_columns_invalid', 'the columns must be a list of at least one column name')
  const columns = args.columns.map((c: unknown, i) => identifier(c, `column ${i + 1}`))
  if (new Set(columns).size !== columns.length) throw refuse('snowflake_columns_invalid', 'a column is named twice')

  const rows = args.values
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => Array.isArray(row))) {
    throw refuse('snowflake_rows_invalid', 'the values must be a list of rows, each a list of values')
  }
  if (rows.length > SNOWFLAKE_INSERT_MAX_ROWS) {
    throw refuse('snowflake_insert_over_cap', `${rows.length} rows is more than the ${SNOWFLAKE_INSERT_MAX_ROWS} one insert may carry; split them across steps`)
  }

  const bindings: string[] = []
  const tuples = (rows as unknown[][]).map((row, r) => {
    if (row.length !== columns.length) {
      throw refuse('snowflake_rows_invalid', `row ${r + 1} has ${row.length} values for ${columns.length} columns`)
    }
    const cells = row.map((value, c) => {
      const text = bindText(value, `row ${r + 1}, column ${columns[c]}`)
      if (text === null) return 'NULL'
      bindings.push(text)
      return '?'
    })
    return `(${cells.join(', ')})`
  })
  const statement = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`

  // The binds as they will be sent, measured before sending (statement.ts writes them this way).
  const size = new TextEncoder().encode(statement).length
    + new TextEncoder().encode(JSON.stringify(Object.fromEntries(bindings.map((value, i) => [String(i + 1), { type: 'TEXT', value }])))).length
  if (size > SNOWFLAKE_INSERT_MAX_BODY_BYTES) {
    throw refuse('snowflake_insert_over_cap', `the insert would send about ${Math.ceil(size / 1024)} KB, more than the ${SNOWFLAKE_INSERT_MAX_BODY_BYTES / 1024} KB cap; split the rows across steps`)
  }
  return { statement, bindings }
}
