/**
 * legacySchemaSource: the sync-schema route's own auth (#2335, PR 7 of phase 5).
 *
 * A legacy connection keeps its login as JSON in a Cloudflare secret. The route
 * turns it into the same source the ops lookups get, with the auth the old
 * fetchers built (a Bearer token, the service role key twice, Basic auth), so a
 * sync sends exactly what it sent before.
 */
import { describe, it, expect } from 'vitest'
import { legacySchemaSource } from '../legacy-credentials'
import { SchemaLookupError } from '../errors'
import type { SchemaFetch } from '../types'

const fetch: SchemaFetch = async () => new Response('{}')

function failure(run: () => unknown): SchemaLookupError {
  try {
    run()
  } catch (err) {
    if (err instanceof SchemaLookupError) return err
    throw err
  }
  throw new Error('expected a refusal')
}

describe('legacySchemaSource', () => {
  it('Salesforce: a Bearer token on the instance URL', () => {
    const source = legacySchemaSource('salesforce', JSON.stringify({ access_token: 'sf-token', instance_url: 'https://sf.example.com' }), fetch)
    expect(source).toEqual({ service: 'salesforce', fetch, auth: { Authorization: 'Bearer sf-token' }, instanceUrl: 'https://sf.example.com' })
  })

  it('Supabase: the service role key as apikey and Bearer', () => {
    const source = legacySchemaSource('supabase', JSON.stringify({ url: 'https://x.supabase.co', service_role_key: 'eyJfake' }), fetch)
    expect(source).toEqual({ service: 'supabase', fetch, auth: { apikey: 'eyJfake', Authorization: 'Bearer eyJfake' }, url: 'https://x.supabase.co' })
  })

  it('Snowflake: Basic auth, BIDSPOKE when no database is named, the schema filter kept', () => {
    const source = legacySchemaSource('snowflake', JSON.stringify({ account: 'xy1.us-east-1', username: 'user', password: 'pass', schema: 'public' }), fetch)
    expect(source).toEqual({
      service: 'snowflake',
      fetch,
      auth: { Authorization: `Basic ${btoa('user:pass')}`, 'X-Snowflake-Authorization-Token-Type': 'BASIC' },
      account: 'xy1.us-east-1',
      database: 'BIDSPOKE',
      schema: 'public',
    })
  })

  it('refuses unreadable JSON by name, without repeating any of it (F120)', () => {
    // V8's SyntaxError message quotes the start of the text, which here is the login.
    const err = failure(() => legacySchemaSource('salesforce', '{"access_token":"secret-123", oops', fetch))
    expect(err.code).toBe('schema_credentials_malformed')
    expect(`${err.message}\n${err.stack}`).not.toContain('secret-123')
    expect(err.cause).toBeUndefined()
  })

  it('refuses a login missing a field it needs, naming the field and not the values', () => {
    const err = failure(() => legacySchemaSource('salesforce', JSON.stringify({ access_token: 'secret-456' }), fetch))
    expect(err.code).toBe('schema_credentials_malformed')
    expect(err.message).toContain('instance_url')
    expect(err.message).not.toContain('secret-456')
  })
})
