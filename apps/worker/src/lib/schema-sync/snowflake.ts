/**
 * Snowflake schema lookups (PRD Section 2.8; keyed lookups #2335, PR 7 of
 * phase 5), through the SQL API's /statements endpoint against the database's
 * INFORMATION_SCHEMA. Each lookup takes an injected fetch and an already minted
 * auth (on ops, the key pair JWT connectionFetch applies), and every failure
 * is a named SchemaLookupError.
 */
import { escapeSqlLiteral } from '../snowflake'
import { SchemaLookupError } from './errors'
import { failedBeforeAnswer, isRecord, malformed, readBody, requireOk, send, statusFailure, type RequestContext } from './request'
import type { SchemaField, SchemaObjectSummary, SnowflakePoll, SnowflakeSource } from './types'

export type { SnowflakeSource } from './types'

// Shape of a Snowflake SQL API /statements response. Note there is no `status`
// field: completion is signalled by the HTTP status (200 done, 202 still
// running), and an async response carries a statementHandle to poll.
interface SnowflakeStatementResponse {
  data?: unknown
  statementHandle?: unknown
  // A large result set is split into partitions. `data` holds partition 0 only;
  // partitionInfo enumerates every partition (incl. 0). Partitions 1..n-1 must be
  // fetched separately via GET ?partition=n (#151).
  resultSetMetaData?: unknown
}

const DEFAULT_POLL: SnowflakePoll = {
  intervalMs: 1500,
  timeoutMs: 20000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/** The first label of <account>.snowflakecomputing.com: an account locator, optionally with its region. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
/** An unquoted Snowflake identifier, which is how the database is written into the query. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/

// Build the optional `AND TABLE_SCHEMA = '...'` clause for the lookups' queries.
// The schema name comes from admin-entered connection credentials (trusted, not
// partner data), but a stray backslash or quote would still corrupt the query,
// so it goes through the shared SQL-literal escaper like every other hand-built
// statement.
export function buildSchemaFilter(schema: string | undefined): string {
  if (!schema) return ''
  return `AND TABLE_SCHEMA = '${escapeSqlLiteral(schema.toUpperCase())}'`
}

function isStatementResponse(value: unknown): value is SnowflakeStatementResponse {
  return isRecord(value)
}

function isRow(value: unknown, width: number): value is string[] {
  return Array.isArray(value) && value.length >= width && value.slice(0, width).every((cell) => typeof cell === 'string')
}

function rowsOf(ctx: RequestContext, status: number, body: SnowflakeStatementResponse, width: number): string[][] {
  const data = body.data
  if (!Array.isArray(data)) throw malformed(ctx, status)
  const rows: string[][] = []
  for (const row of data) {
    if (!isRow(row, width)) throw malformed(ctx, status)
    rows.push(row)
  }
  return rows
}

function partitionCountOf(body: SnowflakeStatementResponse): number {
  const meta = body.resultSetMetaData
  if (!isRecord(meta) || !Array.isArray(meta.partitionInfo)) return 0
  return meta.partitionInfo.length
}

function handleOf(body: SnowflakeStatementResponse): string | null {
  return typeof body.statementHandle === 'string' && body.statementHandle !== '' ? body.statementHandle : null
}

interface Endpoint {
  readonly statements: string
  readonly headers: Record<string, string>
  readonly poll: SnowflakePoll
}

function endpointOf(source: SnowflakeSource): Endpoint {
  const ctx: RequestContext = { service: 'snowflake', step: 'statement' }
  if (!ACCOUNT.test(source.account)) {
    throw new SchemaLookupError({ ...ctx, code: 'schema_source_invalid', detail: 'an account that is not a Snowflake account identifier' })
  }
  if (!IDENTIFIER.test(source.database)) {
    throw new SchemaLookupError({ ...ctx, code: 'schema_source_invalid', detail: 'a database that is not a plain identifier' })
  }
  return {
    statements: `https://${source.account}.snowflakecomputing.com/api/v2/statements`,
    headers: { 'Content-Type': 'application/json' },
    poll: { ...DEFAULT_POLL, ...source.poll },
  }
}

/**
 * Runs one statement to completion and returns every row of every partition,
 * each at least `width` string cells wide. A 202 is polled on the injected
 * clock rather than cached as an empty schema (#89); a large result is paged
 * rather than truncated (#151). Any failure throws by name, which leaves the
 * caller's last good copy untouched.
 */
async function runStatement(source: SnowflakeSource, endpoint: Endpoint, sqlText: string, width: number): Promise<string[][]> {
  const ctx: RequestContext = { service: 'snowflake', step: 'statement' }
  const res = await send(source, ctx, endpoint.statements, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify({ statement: sqlText, timeout: 30 }),
  })
  // 202 is the query accepted and still running: polled below.
  if (!res.ok) throw statusFailure(ctx, res.status)

  let status = res.status
  let result = await readBody(ctx, res, isStatementResponse)
  let resultCtx = ctx

  if (res.status === 202) {
    const handle = handleOf(result)
    if (!handle) throw malformed(ctx, res.status)
    resultCtx = { service: 'snowflake', step: 'statement_poll' }
    const polled = await pollStatement(source, endpoint, handle)
    status = polled.status
    result = polled.body
  }

  const rows = rowsOf(resultCtx, status, result, width)
  const partitions = partitionCountOf(result)
  if (partitions <= 1) return rows

  const handle = handleOf(result)
  if (!handle) throw malformed(resultCtx, status)
  const base = `${endpoint.statements}/${encodeURIComponent(handle)}`
  for (let p = 1; p < partitions; p++) {
    const partCtx: RequestContext = { service: 'snowflake', step: 'statement_partition', subject: String(p) }
    const part = await send(source, partCtx, `${base}?partition=${p}`, { method: 'GET', headers: endpoint.headers })
    requireOk(partCtx, part)
    rows.push(...rowsOf(partCtx, part.status, await readBody(partCtx, part, isStatementResponse), width))
  }
  return rows
}

/** Polls a running statement until it answers rows (200) or the wait ends. */
async function pollStatement(
  source: SnowflakeSource,
  endpoint: Endpoint,
  handle: string,
): Promise<{ status: number; body: SnowflakeStatementResponse }> {
  const ctx: RequestContext = { service: 'snowflake', step: 'statement_poll' }
  const { poll } = endpoint
  const deadline = poll.now() + poll.timeoutMs
  const url = `${endpoint.statements}/${encodeURIComponent(handle)}`

  while (poll.now() < deadline) {
    try {
      await poll.sleep(poll.intervalMs)
    } catch (err) {
      throw failedBeforeAnswer(ctx, err)
    }
    const res = await send(source, ctx, url, { method: 'GET', headers: endpoint.headers })
    if (res.status === 202) continue
    requireOk(ctx, res)
    return { status: res.status, body: await readBody(ctx, res, isStatementResponse) }
  }

  throw new SchemaLookupError({ ...ctx, code: 'schema_query_still_running' })
}

function fieldOf(columnName: string, dataType: string, isNullable: string): SchemaField {
  return { name: columnName, label: columnName, type: dataType.toLowerCase(), nullable: isNullable === 'YES' }
}

/** Keyed lookup `tables`: every SCHEMA.TABLE in the database (one schema, when the source names one). */
export async function listSnowflakeTables(source: SnowflakeSource): Promise<SchemaObjectSummary[]> {
  const endpoint = endpointOf(source)
  const sqlText = `
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM ${source.database}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA != 'INFORMATION_SCHEMA'
    ${buildSchemaFilter(source.schema)}
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `.trim()
  const rows = await runStatement(source, endpoint, sqlText, 2)
  return rows.map(([tableSchema, tableName]) => ({ name: `${tableSchema}.${tableName}`, label: `${tableSchema}.${tableName}` }))
}

/**
 * Keyed lookup `columns` of a table named SCHEMA.TABLE. A table has at least
 * one column, so no rows means no such table: a named error, never an empty
 * column list.
 */
export async function describeSnowflakeTable(source: SnowflakeSource, table: string): Promise<SchemaField[]> {
  const dot = table.indexOf('.')
  if (dot <= 0 || dot === table.length - 1) {
    throw new SchemaLookupError({ service: 'snowflake', step: 'key', subject: table, code: 'schema_key_invalid', detail: 'a table not named SCHEMA.TABLE' })
  }
  const endpoint = endpointOf(source)
  const tableSchema = table.slice(0, dot)
  const tableName = table.slice(dot + 1)
  const sqlText = `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM ${source.database}.INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = '${escapeSqlLiteral(tableSchema)}'
    AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
    ORDER BY ORDINAL_POSITION
  `.trim()
  const rows = await runStatement(source, endpoint, sqlText, 5)
  if (rows.length === 0) throw new SchemaLookupError({ service: 'snowflake', step: 'statement', subject: table, code: 'schema_not_found' })
  return rows.map(([, , columnName, dataType, isNullable]) => fieldOf(columnName, dataType, isNullable))
}
