/**
 * Supabase schema lookups (PRD Section 3.1; #2335 PR 7 of phase 5).
 *
 * PostgREST's OpenAPI root lists every exposed table. The two keyed lookups
 * (tables, columns of a table) take an injected fetch and an already minted
 * auth, and every failure is a named SchemaLookupError.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { listSupabaseTables, describeSupabaseTable, type SupabaseSource } from '../supabase-schema'
import { caught, fetchSequence, forbidGlobalFetch, headersOf, json, text, timeoutError, type Answer } from './_fetch'

const AUTH = { apikey: 'eyJfake', Authorization: 'Bearer eyJfake' }

function source(fetch: SupabaseSource['fetch']): SupabaseSource {
  return { service: 'supabase', fetch, auth: AUTH, url: 'https://fake.supabase.co' }
}

const SPEC = {
  definitions: {
    leads: {
      properties: { id: { format: 'uuid', type: 'string' }, email: { type: 'string' }, ssn: { type: 'string' } },
      required: ['id', 'email'],
    },
    users: { properties: { id: { format: 'uuid', type: 'string' }, name: { type: 'string' } }, required: ['id'] },
  },
}


afterEach(() => vi.unstubAllGlobals())

describe('reading the OpenAPI root', () => {
  it('normalises a table\'s columns, nullability from required', async () => {
    forbidGlobalFetch()
    const fields = await describeSupabaseTable(source(fetchSequence(json(200, SPEC)).fetch), 'leads')
    expect(fields).toEqual([
      { name: 'id', label: 'id', type: 'uuid', nullable: false },
      { name: 'email', label: 'email', type: 'string', nullable: false },
      { name: 'ssn', label: 'ssn', type: 'string', nullable: true },
    ])
  })

  it('an exposed schema with no tables is an honest empty answer', async () => {
    expect(await listSupabaseTables(source(fetchSequence(json(200, { definitions: {} })).fetch))).toEqual([])
  })

  it('reads the OpenAPI root with the auth it was given', async () => {
    const { fetch, calls } = fetchSequence(json(200, SPEC))
    await listSupabaseTables(source(fetch))
    expect(calls[0].url).toBe('https://fake.supabase.co/rest/v1/')
    expect(headersOf(calls[0].init)).toMatchObject({ apikey: 'eyJfake', authorization: 'Bearer eyJfake' })
  })
})

describe('every failure is named, never an empty table list', () => {
  const cases: Array<[string, Answer, string]> = [
    ['401', json(401, { message: 'Invalid API key' }), 'schema_auth_refused'],
    ['403', json(403, { message: 'permission denied' }), 'schema_auth_refused'],
    ['500', text(500, 'Internal Server Error'), 'schema_service_error'],
    ['a timeout', () => timeoutError(), 'schema_request_timeout'],
    ['malformed JSON', text(200, '<!doctype html>'), 'schema_response_malformed'],
    // A PostgREST root always carries definitions: one without them is not the
    // OpenAPI document, and an absent list read as "no tables" is L10's empty list.
    ['a body with no definitions', json(200, { info: { title: 'PostgREST' } }), 'schema_response_malformed'],
    ['a definition that is not an object', json(200, { definitions: { leads: 'x' } }), 'schema_response_malformed'],
  ]
  for (const [label, answer, code] of cases) {
    it(label, async () => {
      const err = await caught(listSupabaseTables(source(fetchSequence(answer).fetch)))
      expect(err.code).toBe(code)
      expect(err.service).toBe('supabase')
      expect(err.step).toBe('openapi')
    })
  }
})

describe('keyed lookups', () => {
  it('tables: every exposed table', async () => {
    expect(await listSupabaseTables(source(fetchSequence(json(200, SPEC)).fetch))).toEqual([
      { name: 'leads', label: 'leads' },
      { name: 'users', label: 'users' },
    ])
  })

  it('columns of a table', async () => {
    const fields = await describeSupabaseTable(source(fetchSequence(json(200, SPEC)).fetch), 'users')
    expect(fields.map((f) => f.name)).toEqual(['id', 'name'])
  })

  it('columns of a table the spec does not hold: schema_not_found, not an empty list', async () => {
    const err = await caught(describeSupabaseTable(source(fetchSequence(json(200, SPEC)).fetch), 'nope'))
    expect([err.code, err.subject]).toEqual(['schema_not_found', 'nope'])
  })

  it('a column lookup whose read fails is named too', async () => {
    const err = await caught(describeSupabaseTable(source(fetchSequence(text(503, 'down')).fetch), 'leads'))
    expect([err.code, err.status]).toEqual(['schema_service_error', 503])
  })
})
