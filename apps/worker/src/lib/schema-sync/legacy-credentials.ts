/**
 * The sync-schema route's own auth (#2335, PR 7 of phase 5).
 *
 * A legacy connection keeps its login as JSON in a Cloudflare secret
 * (service_connections.cf_secret_key). This turns it into the source the schema
 * lookups take, with exactly the auth the fetchers built for themselves before:
 * a Salesforce access token as Bearer, the Supabase service role key as apikey
 * and Bearer, Snowflake Basic auth. Phase 8 retires the route and this with it.
 *
 * A login that cannot be read is refused by name, never with the parser's own
 * message, which quotes the start of the text and so the login itself (F120).
 */
import { SchemaLookupError } from './errors'
import { isRecord } from './request'
import type { SchemaFetch, SchemaService, SchemaSource } from './types'

const DEFAULT_SNOWFLAKE_DATABASE = 'BIDSPOKE'

function refuse(service: SchemaService, detail: string): SchemaLookupError {
  return new SchemaLookupError({ service, step: 'credentials', code: 'schema_credentials_malformed', detail })
}

function loginOf(service: SchemaService, credsJson: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(credsJson)
  } catch {
    throw refuse(service, 'not JSON')
  }
  if (!isRecord(parsed)) throw refuse(service, 'not a JSON object')
  return parsed
}

function required(service: SchemaService, login: Record<string, unknown>, field: string): string {
  const value = login[field]
  if (typeof value !== 'string' || value === '') throw refuse(service, `no ${field}`)
  return value
}

function optional(service: SchemaService, login: Record<string, unknown>, field: string): string | undefined {
  const value = login[field]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw refuse(service, `${field} is not text`)
  return value
}

function basicAuth(service: SchemaService, username: string, password: string): string {
  try {
    return `Basic ${btoa(`${username}:${password}`)}`
  } catch {
    // btoa refuses a character outside Latin-1; its message is not kept.
    throw refuse(service, 'a username or password btoa cannot encode')
  }
}

export function legacySchemaSource(service: SchemaService, credsJson: string, fetch: SchemaFetch): SchemaSource {
  const login = loginOf(service, credsJson)
  switch (service) {
    case 'salesforce':
      return {
        service,
        fetch,
        auth: { Authorization: `Bearer ${required(service, login, 'access_token')}` },
        instanceUrl: required(service, login, 'instance_url'),
      }
    case 'supabase': {
      const key = required(service, login, 'service_role_key')
      return { service, fetch, auth: { apikey: key, Authorization: `Bearer ${key}` }, url: required(service, login, 'url') }
    }
    case 'snowflake': {
      const schema = optional(service, login, 'schema')
      return {
        service,
        fetch,
        auth: {
          Authorization: basicAuth(service, required(service, login, 'username'), required(service, login, 'password')),
          'X-Snowflake-Authorization-Token-Type': 'BASIC',
        },
        account: required(service, login, 'account'),
        database: optional(service, login, 'database') ?? DEFAULT_SNOWFLAKE_DATABASE,
        ...(schema === undefined ? {} : { schema }),
      }
    }
  }
}
