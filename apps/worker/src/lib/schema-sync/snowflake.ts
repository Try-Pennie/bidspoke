import type { SchemaCache, SchemaObject, SchemaField } from './types'
import { parseJson } from '../json'
import { escapeSqlLiteral } from '../snowflake'

interface SnowflakeCredentials {
  account: string    // e.g. "xy12345.us-east-1"
  username: string
  password: string
  database?: string  // defaults to 'BIDSPOKE'
  schema?: string    // optional — filter to one schema
}

// Shape of a Snowflake SQL API /statements response. Note there is no `status`
// field — completion is signalled by the HTTP status (200 done, 202 still
// running), and an async response carries a statementHandle to poll.
interface SnowflakeStatementResponse {
  data?: string[][]
  statementHandle?: string
  message?: string
  code?: string
  // A large result set is split into partitions. `data` holds partition 0 only;
  // partitionInfo enumerates every partition (incl. 0). Partitions 1..n-1 must be
  // fetched separately via GET ?partition=n (#151).
  resultSetMetaData?: { partitionInfo?: unknown[] }
}

export interface SnowflakeFetchOptions {
  pollIntervalMs?: number  // delay between status polls (default 1500)
  pollTimeoutMs?: number   // give up polling after this long (default 20000)
}

const DEFAULT_POLL_INTERVAL_MS = 1500
const DEFAULT_POLL_TIMEOUT_MS = 20000

// Build the optional `AND TABLE_SCHEMA = '...'` clause for the columns query.
// The schema name comes from admin-entered connection credentials (trusted, not
// partner data), but a stray backslash or quote would still corrupt the query,
// so it goes through the shared SQL-literal escaper like every other hand-built
// statement.
export function buildSchemaFilter(schema: string | undefined): string {
  if (!schema) return ''
  return `AND TABLE_SCHEMA = '${escapeSqlLiteral(schema.toUpperCase())}'`
}

export async function fetchSnowflakeSchema(
  credsJson: string,
  opts: SnowflakeFetchOptions = {},
): Promise<SchemaCache> {
  const creds = JSON.parse(credsJson) as SnowflakeCredentials
  const { account, username, password, database = 'BIDSPOKE', schema } = creds

  const headers = {
    'Authorization': `Basic ${btoa(`${username}:${password}`)}`,
    'Content-Type': 'application/json',
    'X-Snowflake-Authorization-Token-Type': 'BASIC',
  }

  const schemaFilter = buildSchemaFilter(schema)

  const sqlText = `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM ${database}.INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA != 'INFORMATION_SCHEMA'
    ${schemaFilter}
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `.trim()

  const res = await fetch(`https://${account}.snowflakecomputing.com/api/v2/statements`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ statement: sqlText, timeout: 30 }),
  })

  // 202 is success-ish (query accepted, running async) — let it through to the
  // poll path below; only a genuine non-2xx is a hard failure.
  if (!res.ok && res.status !== 202) {
    throw new Error(`Snowflake schema fetch failed (${res.status})`)
  }

  let result = await parseJson<SnowflakeStatementResponse>(res)

  // Async path: the query ran past the inline 30s timeout, so Snowflake returned
  // 202 + a statementHandle instead of rows. Poll the handle until it completes
  // rather than caching an empty schema, which would wipe Integration-node
  // autocomplete (#89).
  if (res.status === 202) {
    const handle = result.statementHandle
    if (!handle) {
      throw new Error('Snowflake returned 202 with no statementHandle to poll')
    }
    result = await pollSnowflakeStatement(
      account,
      handle,
      headers,
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    )
  }

  // The result may be split across partitions; `data` is only partition 0. Fetch
  // the rest so a large INFORMATION_SCHEMA.COLUMNS result isn't silently
  // truncated (which would drop tables/columns from autocomplete) — #151.
  const rows = await collectAllPartitions(account, result, headers)

  // Group rows by TABLE_SCHEMA.TABLE_NAME
  const byTable = new Map<string, { tableSchema: string; tableName: string; fields: SchemaField[] }>()
  for (const [tableSchema, tableName, columnName, dataType, isNullable] of rows) {
    const key = `${tableSchema}.${tableName}`
    if (!byTable.has(key)) byTable.set(key, { tableSchema, tableName, fields: [] })
    byTable.get(key)!.fields.push({
      name: columnName,
      label: columnName,
      type: dataType.toLowerCase(),
      nullable: isNullable === 'YES',
    })
  }

  const objects: SchemaObject[] = Array.from(byTable.values()).map(({ tableSchema, tableName, fields }) => ({
    name: `${tableSchema}.${tableName}`,
    label: `${tableSchema}.${tableName}`,
    fields,
  }))

  return { objects }
}

// Concatenate every partition of a completed statement. `data` is partition 0;
// resultSetMetaData.partitionInfo lists all partitions, and 1..n-1 are fetched
// via GET /api/v2/statements/{handle}?partition={n}. A partition fetch failure
// throws rather than returning a partial set — the caller's catch then leaves the
// existing schema_cache untouched instead of overwriting it with a truncated one.
async function collectAllPartitions(
  account: string,
  result: SnowflakeStatementResponse,
  headers: Record<string, string>,
): Promise<string[][]> {
  const rows: string[][] = [...(result.data ?? [])]
  const partitionInfo = result.resultSetMetaData?.partitionInfo ?? []
  if (partitionInfo.length <= 1) return rows

  const handle = result.statementHandle
  if (!handle) {
    throw new Error(`Snowflake returned ${partitionInfo.length} partitions but no statementHandle to fetch them`)
  }

  const base = `https://${account}.snowflakecomputing.com/api/v2/statements/${encodeURIComponent(handle)}`
  for (let p = 1; p < partitionInfo.length; p++) {
    const res = await fetch(`${base}?partition=${p}`, { method: 'GET', headers })
    if (!res.ok) throw new Error(`Snowflake partition ${p} fetch failed (${res.status})`)
    const body = await parseJson<SnowflakeStatementResponse>(res)
    if (body.data) rows.push(...body.data)
  }
  return rows
}

// Polls a running statement (GET /api/v2/statements/{handle}) until it returns
// rows (HTTP 200) or the timeout elapses. A 202 means still running. Throws on a
// hard error or when the query never completes — both leave the existing
// schema_cache untouched (the caller's catch returns 502 without overwriting).
async function pollSnowflakeStatement(
  account: string,
  handle: string,
  headers: Record<string, string>,
  intervalMs: number,
  timeoutMs: number,
): Promise<SnowflakeStatementResponse> {
  const deadline = Date.now() + timeoutMs
  const url = `https://${account}.snowflakecomputing.com/api/v2/statements/${encodeURIComponent(handle)}`

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))

    const res = await fetch(url, { method: 'GET', headers })
    if (res.status === 202) continue  // still running — poll again
    if (!res.ok) throw new Error(`Snowflake schema poll failed (${res.status})`)
    return await parseJson<SnowflakeStatementResponse>(res)
  }

  throw new Error('Snowflake query still running after polling — try Sync again in a moment')
}
