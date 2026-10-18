export interface SchemaField {
  name: string
  label: string
  type: string
  nullable?: boolean
}

export interface SchemaObject {
  name: string
  label: string
  fields: SchemaField[]
}

export interface SchemaCache {
  objects: SchemaObject[]
}

/** One entry of an object or table list: a keyed lookup's first level. */
export interface SchemaObjectSummary {
  name: string
  label: string
}

export type SchemaService = 'salesforce' | 'supabase' | 'snowflake'

/**
 * How a lookup sends a request (#2335, PR 7 of phase 5). Injected so the same
 * lookups serve both callers: the sync-schema route passes the plain fetch, and
 * the ops lookups pass connectionFetch, which holds the host allowlist, the
 * Salesforce lease, the deadline and the auth. It may throw; the lookup turns
 * any throw into a named SchemaLookupError.
 */
export type SchemaFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * What every lookup is given: the fetch, and an auth already minted by the
 * caller, sent as headers on every request. `auth` is always given: a caller
 * whose fetch applies the auth itself (connectionFetch) gives an empty object.
 */
export interface SchemaRequestBase {
  readonly fetch: SchemaFetch
  readonly auth: Readonly<Record<string, string>>
}

export interface SalesforceSource extends SchemaRequestBase {
  readonly service: 'salesforce'
  /** The org's https instance URL, as the login answered it. */
  readonly instanceUrl: string
}

export interface SupabaseSource extends SchemaRequestBase {
  readonly service: 'supabase'
  /** The project's https URL. */
  readonly url: string
}

/** The poll of an async Snowflake statement, its sleep and clock injected (L524). */
export interface SnowflakePoll {
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}

export interface SnowflakeSource extends SchemaRequestBase {
  readonly service: 'snowflake'
  /** The account identifier, the first label of <account>.snowflakecomputing.com. */
  readonly account: string
  /** An unquoted identifier: it is written into the query as one. */
  readonly database: string
  /** Optional: limits every lookup to one schema. */
  readonly schema?: string
  readonly poll?: Partial<SnowflakePoll>
}

export type SchemaSource = SalesforceSource | SupabaseSource | SnowflakeSource
