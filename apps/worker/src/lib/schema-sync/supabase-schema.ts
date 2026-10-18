/**
 * Supabase schema lookups (PRD Section 2.8; keyed lookups #2335, PR 7 of
 * phase 5). PostgREST serves an OpenAPI document at its root whose
 * `definitions` hold every exposed table and view. Each lookup takes an injected
 * fetch and an already minted auth, and every failure is a named
 * SchemaLookupError.
 */
import { SchemaLookupError } from './errors'
import { isHttpsBase, isRecord, readBody, requireOk, send, type RequestContext } from './request'
import type { SchemaCache, SchemaField, SchemaObject, SchemaObjectSummary, SupabaseSource } from './types'

export type { SupabaseSource } from './types'

interface OpenAPIDefinition {
  properties?: Record<string, unknown>
  required?: unknown[]
}

interface OpenAPISpec {
  definitions: Record<string, OpenAPIDefinition>
}

function isDefinition(value: unknown): value is OpenAPIDefinition {
  if (!isRecord(value)) return false
  if (value.properties !== undefined && !isRecord(value.properties)) return false
  if (value.required !== undefined && !Array.isArray(value.required)) return false
  return true
}

/**
 * A PostgREST root always carries `definitions` (an object, empty when nothing
 * is exposed). An answer without them is not that document, and reading the
 * absence as "no tables" would be the empty list L10 forbids.
 */
function isSpec(value: unknown): value is OpenAPISpec {
  return isRecord(value) && isRecord(value.definitions) && Object.values(value.definitions).every(isDefinition)
}

function stringOf(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const found = value[key]
  return typeof found === 'string' ? found : undefined
}

function fieldsOf(def: OpenAPIDefinition): SchemaField[] {
  const required = new Set(def.required ?? [])
  return Object.entries(def.properties ?? {}).map(([fieldName, prop]) => ({
    name: fieldName,
    label: fieldName,
    type: stringOf(prop, 'format') ?? stringOf(prop, 'type') ?? 'text',
    nullable: !required.has(fieldName),
  }))
}

async function readSpec(source: SupabaseSource, subject: string | null): Promise<OpenAPISpec> {
  const ctx: RequestContext = { service: 'supabase', step: 'openapi', subject }
  if (!isHttpsBase(source.url)) {
    throw new SchemaLookupError({ ...ctx, code: 'schema_source_invalid', detail: 'a project URL that is not a plain https address' })
  }
  const res = await send(source, ctx, `${source.url}/rest/v1/`)
  requireOk(ctx, res)
  return readBody(ctx, res, isSpec)
}

/** Keyed lookup `tables`: every table and view PostgREST exposes. */
export async function listSupabaseTables(source: SupabaseSource): Promise<SchemaObjectSummary[]> {
  const spec = await readSpec(source, null)
  return Object.keys(spec.definitions).map((name) => ({ name, label: name }))
}

/** Keyed lookup `columns` of a table: its columns, or a named error when the spec does not hold it. */
export async function describeSupabaseTable(source: SupabaseSource, table: string): Promise<SchemaField[]> {
  const spec = await readSpec(source, table)
  const def = Object.hasOwn(spec.definitions, table) ? spec.definitions[table] : undefined
  if (!def) throw new SchemaLookupError({ service: 'supabase', step: 'openapi', subject: table, code: 'schema_not_found' })
  return fieldsOf(def)
}

/** The canvas sync (POST /api/connections/supabase/sync-schema): every table with its columns. */
export async function fetchSupabaseSchema(source: SupabaseSource): Promise<SchemaCache> {
  const spec = await readSpec(source, null)
  const objects: SchemaObject[] = Object.entries(spec.definitions).map(([name, def]) => ({ name, label: name, fields: fieldsOf(def) }))
  return { objects }
}
