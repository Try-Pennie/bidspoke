/**
 * Salesforce schema lookups (PRD Section 2.8; keyed lookups #2335, PR 7 of
 * phase 5). Each takes an injected fetch and an already minted auth (see
 * SchemaRequestBase), and every failure is a named SchemaLookupError: a failed
 * describe is never an object with an empty field list (L10).
 *
 * The API version stays v59.0 here; whether to move it is #2394's question.
 */
import { SchemaLookupError } from './errors'
import { isHttpsBase, isRecord, readBody, requireOk, send, type RequestContext } from './request'
import type { SalesforceSource, SchemaCache, SchemaField, SchemaObject, SchemaObjectSummary } from './types'

export type { SalesforceSource } from './types'

const API_VERSION = 'v59.0'

// The canvas sync describes these objects only: fetching all would be too slow and noisy.
const CORE_OBJECTS = ['Lead', 'Contact', 'Account', 'Opportunity', 'Case', 'Task', 'Event']

/** A Salesforce API name: letters, digits and underscores (custom objects end __c). */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

interface SObjectEntry { name: string; label: string; queryable: boolean }
interface SObjectList { sobjects: SObjectEntry[] }
interface DescribeField { name: string; label: string; type: string; nillable: boolean }
interface Describe { fields: DescribeField[] }

function isSObjectEntry(value: unknown): value is SObjectEntry {
  return isRecord(value) && typeof value.name === 'string' && typeof value.label === 'string' && typeof value.queryable === 'boolean'
}

function isSObjectList(value: unknown): value is SObjectList {
  return isRecord(value) && Array.isArray(value.sobjects) && value.sobjects.every(isSObjectEntry)
}

function isDescribeField(value: unknown): value is DescribeField {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.label === 'string'
    && typeof value.type === 'string'
    && typeof value.nillable === 'boolean'
}

function isDescribe(value: unknown): value is Describe {
  return isRecord(value) && Array.isArray(value.fields) && value.fields.every(isDescribeField)
}

function baseOf(source: SalesforceSource, ctx: RequestContext): string {
  if (!isHttpsBase(source.instanceUrl)) {
    throw new SchemaLookupError({ ...ctx, code: 'schema_source_invalid', detail: 'an instance URL that is not a plain https address' })
  }
  return `${source.instanceUrl}/services/data/${API_VERSION}`
}

async function sobjectList(source: SalesforceSource): Promise<SObjectEntry[]> {
  const ctx: RequestContext = { service: 'salesforce', step: 'object_list' }
  const base = baseOf(source, ctx)
  const res = await send(source, ctx, `${base}/sobjects/`)
  requireOk(ctx, res)
  return (await readBody(ctx, res, isSObjectList)).sobjects
}

/** Keyed lookup `objects`: every queryable object, custom objects included. */
export async function listSalesforceObjects(source: SalesforceSource): Promise<SchemaObjectSummary[]> {
  const list = await sobjectList(source)
  return list.filter((o) => o.queryable).map((o) => ({ name: o.name, label: o.label }))
}

/** Keyed lookup `fields` of an object: its describe, or a named error. */
export async function describeSalesforceObject(source: SalesforceSource, objectName: string): Promise<SchemaField[]> {
  const ctx: RequestContext = { service: 'salesforce', step: 'object_describe', subject: objectName }
  if (!API_NAME.test(objectName)) {
    throw new SchemaLookupError({ ...ctx, code: 'schema_key_invalid', detail: 'an object name that is not a Salesforce API name' })
  }
  const base = baseOf(source, ctx)
  const res = await send(source, ctx, `${base}/sobjects/${objectName}/describe/`)
  requireOk(ctx, res)
  const desc = await readBody(ctx, res, isDescribe)
  return desc.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, nullable: f.nillable }))
}

/**
 * The canvas sync (POST /api/connections/salesforce/sync-schema): the core
 * objects, each described. Any describe that fails fails the sync by name, so
 * the route keeps the last good schema_cache rather than caching an object with
 * no fields.
 */
export async function fetchSalesforceSchema(source: SalesforceSource): Promise<SchemaCache> {
  const list = await sobjectList(source)
  const targets = list.filter((o) => o.queryable && CORE_OBJECTS.includes(o.name))
  const objects: SchemaObject[] = await Promise.all(
    targets.map(async (obj) => ({ name: obj.name, label: obj.label, fields: await describeSalesforceObject(source, obj.name) })),
  )
  return { objects }
}
