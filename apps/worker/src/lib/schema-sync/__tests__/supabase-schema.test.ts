/**
 * Supabase schema fetcher — PRD Section 3.1
 * Covers: parses PostgREST OpenAPI definitions, marks nullability from required array,
 * throws on non-200 response.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSupabaseSchema } from '../supabase-schema'

const CREDS = JSON.stringify({
  url: 'https://fake.supabase.co',
  service_role_key: 'eyJfake',
})

function fetchReturning(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchSupabaseSchema', () => {
  it('returns normalized schema from OpenAPI definitions', async () => {
    const spec = {
      definitions: {
        leads: {
          properties: {
            id: { format: 'uuid', type: 'string' },
            email: { type: 'string' },
            ssn: { type: 'string' },
          },
          required: ['id', 'email'],
        },
        users: {
          properties: {
            id: { format: 'uuid', type: 'string' },
            name: { type: 'string' },
          },
          required: ['id'],
        },
      },
    }

    vi.stubGlobal('fetch', fetchReturning(spec))

    const schema = await fetchSupabaseSchema(CREDS)
    expect(schema.objects).toHaveLength(2)

    const leads = schema.objects.find((o) => o.name === 'leads')!
    expect(leads.fields).toHaveLength(3)

    const idField = leads.fields.find((f) => f.name === 'id')!
    expect(idField.type).toBe('uuid')
    expect(idField.nullable).toBe(false) // in required

    const ssnField = leads.fields.find((f) => f.name === 'ssn')!
    expect(ssnField.nullable).toBe(true) // not in required
  })

  it('returns empty objects array when definitions is absent', async () => {
    vi.stubGlobal('fetch', fetchReturning({ info: { title: 'PostgREST' } }))
    const schema = await fetchSupabaseSchema(CREDS)
    expect(schema.objects).toEqual([])
  })

  it('throws on non-200 response', async () => {
    vi.stubGlobal('fetch', fetchReturning({}, false))
    await expect(fetchSupabaseSchema(CREDS)).rejects.toThrow('Supabase schema fetch failed (500)')
  })

  it('sends the service role key as both apikey header and Bearer token', async () => {
    const mockFetch = fetchReturning({ definitions: {} })
    vi.stubGlobal('fetch', mockFetch)

    await fetchSupabaseSchema(CREDS)

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['apikey']).toBe('eyJfake')
    expect(headers['Authorization']).toBe('Bearer eyJfake')
  })
})
