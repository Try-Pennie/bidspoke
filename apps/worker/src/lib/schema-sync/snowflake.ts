import type { SchemaCache, SchemaObject, SchemaField } from './types'

interface SnowflakeCredentials {
  account: string    // e.g. "xy12345.us-east-1"
  username: string
  password: string
  database?: string  // defaults to 'BIDSPOKE'
  schema?: string    // optional — filter to one schema
}

export async function fetchSnowflakeSchema(credsJson: string): Promise<SchemaCache> {
  const creds = JSON.parse(credsJson) as SnowflakeCredentials
  const { account, username, password, database = 'BIDSPOKE', schema } = creds

  const schemaFilter = schema
    ? `AND TABLE_SCHEMA = '${schema.toUpperCase().replace(/'/g, '')}'`
    : ''

  const sqlText = `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM ${database}.INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA != 'INFORMATION_SCHEMA'
    ${schemaFilter}
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `.trim()

  const res = await fetch(`https://${account}.snowflakecomputing.com/api/v2/statements`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${username}:${password}`)}`,
      'Content-Type': 'application/json',
      'X-Snowflake-Authorization-Token-Type': 'BASIC',
    },
    body: JSON.stringify({ statement: sqlText, timeout: 30 }),
  })

  if (!res.ok) throw new Error(`Snowflake schema fetch failed (${res.status})`)

  const result = await res.json() as {
    data?: string[][]
    status?: string
    message?: string
  }

  // Snowflake SQL API can return async — surface a clear error rather than silently returning empty
  if (result.status && result.status !== 'success') {
    throw new Error(`Snowflake query status: ${result.status} — ${result.message ?? 'try again'}`)
  }

  const rows = result.data ?? []

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
