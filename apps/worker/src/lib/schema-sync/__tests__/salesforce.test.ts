/**
 * Salesforce schema fetcher — PRD Section 3.1
 * Covers: normalizes SObject describe response, skips non-queryable objects,
 * handles describe failure gracefully, throws on SObject list failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSalesforceSchema } from '../salesforce'

const CREDS = JSON.stringify({
  access_token: 'tok-abc',
  instance_url: 'https://test.salesforce.com',
})

function mockFetch(...responses: Array<{ ok: boolean; data?: unknown; status?: number }>) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const r = responses[i++] ?? { ok: true, data: {} }
    return Promise.resolve({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: () => Promise.resolve(r.data),
    })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchSalesforceSchema', () => {
  it('returns normalized schema for core objects', async () => {
    const sobjectList = {
      sobjects: [
        { name: 'Lead', label: 'Lead', queryable: true },
        { name: 'Contact', label: 'Contact', queryable: true },
        { name: 'CustomObj__c', label: 'Custom', queryable: true }, // not in CORE_OBJECTS — skipped
      ],
    }
    const leadDescribe = {
      fields: [
        { name: 'FirstName', label: 'First Name', type: 'string', nillable: true },
        { name: 'LastName', label: 'Last Name', type: 'string', nillable: false },
      ],
    }
    const contactDescribe = {
      fields: [
        { name: 'Email', label: 'Email', type: 'email', nillable: true },
      ],
    }

    vi.stubGlobal('fetch', mockFetch(
      { ok: true, data: sobjectList },      // /sobjects/
      { ok: true, data: leadDescribe },     // /sobjects/Lead/describe/
      { ok: true, data: contactDescribe },  // /sobjects/Contact/describe/
    ))

    const schema = await fetchSalesforceSchema(CREDS)
    expect(schema.objects).toHaveLength(2)

    const lead = schema.objects.find((o) => o.name === 'Lead')!
    expect(lead.label).toBe('Lead')
    expect(lead.fields).toHaveLength(2)
    expect(lead.fields[0]).toEqual({ name: 'FirstName', label: 'First Name', type: 'string', nullable: true })
    expect(lead.fields[1]).toEqual({ name: 'LastName', label: 'Last Name', type: 'string', nullable: false })
  })

  it('skips non-queryable objects', async () => {
    const sobjectList = {
      sobjects: [
        { name: 'Lead', label: 'Lead', queryable: true },
        { name: 'Contact', label: 'Contact', queryable: false }, // skipped
      ],
    }
    const leadDescribe = { fields: [{ name: 'Id', label: 'ID', type: 'id', nillable: false }] }

    vi.stubGlobal('fetch', mockFetch(
      { ok: true, data: sobjectList },
      { ok: true, data: leadDescribe },
    ))

    const schema = await fetchSalesforceSchema(CREDS)
    expect(schema.objects.map((o) => o.name)).toEqual(['Lead'])
  })

  it('returns empty fields array when describe endpoint fails', async () => {
    const sobjectList = {
      sobjects: [{ name: 'Lead', label: 'Lead', queryable: true }],
    }

    vi.stubGlobal('fetch', mockFetch(
      { ok: true, data: sobjectList },
      { ok: false, status: 403, data: {} }, // describe fails
    ))

    const schema = await fetchSalesforceSchema(CREDS)
    expect(schema.objects[0].fields).toEqual([])
  })

  it('throws when SObject list request fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 401, data: {} }))
    await expect(fetchSalesforceSchema(CREDS)).rejects.toThrow('Salesforce SObject list failed (401)')
  })
})
