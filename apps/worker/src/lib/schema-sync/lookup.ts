/**
 * lookupSchema(source, key, parents): one level of a connection's schema at a
 * time, for the dropdowns of the ops connection steps (#2335, PR 7 of phase 5).
 * OpsConnections.lookup (PR 8) calls it with connectionFetch as the source's
 * fetch; it is built on the same service modules the canvas sync uses (L655).
 *
 * The keys: a list (objects, or tables) takes no parent; the fields of an
 * object, or the columns of a table, take that one name. A failure is a named
 * SchemaLookupError, never an answer with an empty list (L10).
 */
import { SchemaLookupError } from './errors'
import { describeSalesforceObject, listSalesforceObjects } from './salesforce'
import { describeSnowflakeTable, listSnowflakeTables } from './snowflake'
import { describeSupabaseTable, listSupabaseTables } from './supabase-schema'
import type { SchemaField, SchemaObjectSummary, SchemaService, SchemaSource } from './types'

export const SCHEMA_LOOKUP_KEYS = {
  salesforce: ['objects', 'fields'],
  supabase: ['tables', 'columns'],
  snowflake: ['tables', 'columns'],
} as const satisfies Record<SchemaService, readonly [string, string]>

export type SchemaLookupKey = (typeof SCHEMA_LOOKUP_KEYS)[SchemaService][number]

export type SchemaLookupAnswer =
  | { readonly key: 'objects' | 'tables'; readonly entries: SchemaObjectSummary[] }
  | { readonly key: 'fields' | 'columns'; readonly parent: string; readonly fields: SchemaField[] }

function refuse(source: SchemaSource, detail: string): SchemaLookupError {
  return new SchemaLookupError({ service: source.service, step: 'key', code: 'schema_key_invalid', detail })
}

/** The one parent a fields or columns lookup takes, or none for a list; refused by name otherwise. */
function parentOf(source: SchemaSource, isList: boolean, parents: readonly string[]): string | null {
  if (isList) {
    if (parents.length !== 0) throw refuse(source, 'a list lookup takes no parent')
    return null
  }
  if (parents.length !== 1 || parents[0] === '') throw refuse(source, 'a fields or columns lookup takes exactly one parent name')
  return parents[0]
}

export async function lookupSchema(source: SchemaSource, key: string, parents: readonly string[]): Promise<SchemaLookupAnswer> {
  const [listKey, childKey] = SCHEMA_LOOKUP_KEYS[source.service]
  if (key !== listKey && key !== childKey) throw refuse(source, `a key other than ${listKey} or ${childKey}`)
  const parent = parentOf(source, key === listKey, parents)

  switch (source.service) {
    case 'salesforce':
      return parent === null
        ? { key: 'objects', entries: await listSalesforceObjects(source) }
        : { key: 'fields', parent, fields: await describeSalesforceObject(source, parent) }
    case 'supabase':
      return parent === null
        ? { key: 'tables', entries: await listSupabaseTables(source) }
        : { key: 'columns', parent, fields: await describeSupabaseTable(source, parent) }
    case 'snowflake':
      return parent === null
        ? { key: 'tables', entries: await listSnowflakeTables(source) }
        : { key: 'columns', parent, fields: await describeSnowflakeTable(source, parent) }
  }
}
