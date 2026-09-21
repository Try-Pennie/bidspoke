/**
 * Readers for SQLite column values (#1410). SqlStorageValue can be a string, a
 * number, an ArrayBuffer or null, and a bare String() over it would stringify
 * a buffer as "[object ArrayBuffer]" without a word (L50). These name the type
 * they expect and refuse anything else, so a schema drift is an error at the
 * read, not a corrupt value downstream.
 */
export function asText(value: SqlStorageValue, column: string): string {
  if (typeof value === 'string') return value
  throw new Error(`column ${column} holds a ${describe(value)}, expected text`)
}

export function asTextOrNull(value: SqlStorageValue, column: string): string | null {
  return value === null ? null : asText(value, column)
}

export function asInteger(value: SqlStorageValue, column: string): number {
  if (typeof value === 'number') return value
  throw new Error(`column ${column} holds a ${describe(value)}, expected a number`)
}

export function asIntegerOrNull(value: SqlStorageValue, column: string): number | null {
  return value === null ? null : asInteger(value, column)
}

function describe(value: SqlStorageValue): string {
  if (value === null) return 'null'
  if (value instanceof ArrayBuffer) return 'blob'
  return typeof value
}
