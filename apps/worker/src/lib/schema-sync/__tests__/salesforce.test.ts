/**
 * Salesforce schema lookups (PRD Section 3.1; #2335 PR 7 of phase 5).
 *
 * The full sync the canvas's Integration node uses (fetchSalesforceSchema) and
 * the two keyed lookups (objects, fields of an object) take an injected fetch and
 * an already minted auth, and a failed describe is a named SchemaLookupError,
 * never an object with an empty field list (L10).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchSalesforceSchema, listSalesforceObjects, describeSalesforceObject, type SalesforceSource } from '../salesforce'
import { caught, fetchByUrl, fetchSequence, forbidGlobalFetch, headersOf, json, text, timeoutError, type Answer } from './_fetch'

const AUTH = { Authorization: 'Bearer tok-abc' }

function source(fetch: SalesforceSource['fetch']): SalesforceSource {
  return { service: 'salesforce', fetch, auth: AUTH, instanceUrl: 'https://test.my.salesforce.com' }
}

const SOBJECTS = {
  sobjects: [
    { name: 'Lead', label: 'Lead', queryable: true },
    { name: 'Contact', label: 'Contact', queryable: true },
    { name: 'Submission__c', label: 'Submission', queryable: true },
    { name: 'LeadShare', label: 'Lead Share', queryable: false },
  ],
}
const LEAD = {
  fields: [
    { name: 'FirstName', label: 'First Name', type: 'string', nillable: true },
    { name: 'LastName', label: 'Last Name', type: 'string', nillable: false },
  ],
}
const CONTACT = { fields: [{ name: 'Email', label: 'Email', type: 'email', nillable: true }] }


afterEach(() => vi.unstubAllGlobals())

describe('fetchSalesforceSchema (the canvas sync), on success exactly as before', () => {
  it('describes the core objects only, normalised', async () => {
    forbidGlobalFetch()
    const { fetch } = fetchByUrl([
      ['/sobjects/Lead/describe/', json(200, LEAD)],
      ['/sobjects/Contact/describe/', json(200, CONTACT)],
      ['/sobjects/', json(200, SOBJECTS)],
    ])
    const schema = await fetchSalesforceSchema(source(fetch))
    // Submission__c is not a core object and LeadShare is not queryable.
    expect(schema.objects.map((o) => o.name)).toEqual(['Lead', 'Contact'])
    const lead = schema.objects.find((o) => o.name === 'Lead')!
    expect(lead.fields).toEqual([
      { name: 'FirstName', label: 'First Name', type: 'string', nullable: true },
      { name: 'LastName', label: 'Last Name', type: 'string', nullable: false },
    ])
  })

  it('sends the auth it was given to every request, at API v59.0', async () => {
    const { fetch, calls } = fetchByUrl([
      ['/sobjects/Lead/describe/', json(200, LEAD)],
      ['/sobjects/Contact/describe/', json(200, CONTACT)],
      ['/sobjects/', json(200, SOBJECTS)],
    ])
    await fetchSalesforceSchema(source(fetch))
    expect(calls.map((c) => c.url)).toEqual([
      'https://test.my.salesforce.com/services/data/v59.0/sobjects/',
      'https://test.my.salesforce.com/services/data/v59.0/sobjects/Lead/describe/',
      'https://test.my.salesforce.com/services/data/v59.0/sobjects/Contact/describe/',
    ])
    for (const call of calls) expect(headersOf(call.init).authorization).toBe('Bearer tok-abc')
  })

  it('throws by name when the object list is refused', async () => {
    const { fetch } = fetchSequence(json(401, [{ errorCode: 'INVALID_SESSION_ID' }]))
    const err = await caught(fetchSalesforceSchema(source(fetch)))
    expect(err.code).toBe('schema_auth_refused')
    expect(err.step).toBe('object_list')
    expect(err.status).toBe(401)
  })
})

describe('a failed describe is a named error, never an empty field list', () => {
  const cases: Array<[string, Answer, string, number | null]> = [
    ['401', json(401, [{ errorCode: 'INVALID_SESSION_ID' }]), 'schema_auth_refused', 401],
    ['403', json(403, [{ errorCode: 'INSUFFICIENT_ACCESS' }]), 'schema_auth_refused', 403],
    ['500', text(500, 'Internal Server Error'), 'schema_service_error', 500],
    ['503', text(503, '<html>maintenance</html>'), 'schema_service_error', 503],
    ['429', json(429, []), 'schema_rate_limited', 429],
    ['404', json(404, [{ errorCode: 'NOT_FOUND' }]), 'schema_not_found', 404],
    ['a timeout', () => timeoutError(), 'schema_request_timeout', null],
    ['a network failure', () => new TypeError('fetch failed'), 'schema_request_failed', null],
    ['malformed JSON', text(200, '<html>login</html>'), 'schema_response_malformed', 200],
    ['a body with no field list', json(200, { name: 'Lead' }), 'schema_response_malformed', 200],
    ['a field with no name', json(200, { fields: [{ label: 'x', type: 'string', nillable: true }] }), 'schema_response_malformed', 200],
  ]

  for (const [label, answer, code, status] of cases) {
    it(`in the full sync: ${label}`, async () => {
      const { fetch } = fetchByUrl([
        ['/sobjects/Lead/describe/', answer],
        ['/sobjects/Contact/describe/', json(200, CONTACT)],
        ['/sobjects/', json(200, SOBJECTS)],
      ])
      const err = await caught(fetchSalesforceSchema(source(fetch)))
      expect(err.code).toBe(code)
      expect(err.service).toBe('salesforce')
      expect(err.step).toBe('object_describe')
      expect(err.subject).toBe('Lead')
      expect(err.status).toBe(status)
      expect(err.message).toContain(code)
      expect(err.message).toContain('Lead')
    })

    it(`in the fields lookup: ${label}`, async () => {
      const { fetch } = fetchSequence(answer instanceof Response ? answer.clone() : answer)
      const err = await caught(describeSalesforceObject(source(fetch), 'Lead'))
      expect(err.code).toBe(code)
      expect(err.step).toBe('object_describe')
    })
  }
})

describe('the object list fails by name too', () => {
  it('a 5xx', async () => {
    const err = await caught(listSalesforceObjects(source(fetchSequence(text(502, 'Bad Gateway')).fetch)))
    expect([err.code, err.step, err.status]).toEqual(['schema_service_error', 'object_list', 502])
  })

  it('a body with no sobjects array', async () => {
    const err = await caught(listSalesforceObjects(source(fetchSequence(json(200, { encoding: 'UTF-8' })).fetch)))
    expect([err.code, err.step]).toEqual(['schema_response_malformed', 'object_list'])
  })

  it('a timeout', async () => {
    const err = await caught(listSalesforceObjects(source(fetchSequence(timeoutError()).fetch)))
    expect([err.code, err.step]).toEqual(['schema_request_timeout', 'object_list'])
  })
})

describe('keyed lookups', () => {
  it('objects: every queryable object, custom objects included', async () => {
    const { fetch } = fetchSequence(json(200, SOBJECTS))
    expect(await listSalesforceObjects(source(fetch))).toEqual([
      { name: 'Lead', label: 'Lead' },
      { name: 'Contact', label: 'Contact' },
      { name: 'Submission__c', label: 'Submission' },
    ])
  })

  it('fields of an object: that object described', async () => {
    const { fetch, calls } = fetchSequence(json(200, LEAD))
    const fields = await describeSalesforceObject(source(fetch), 'Lead')
    expect(fields.map((f) => f.name)).toEqual(['FirstName', 'LastName'])
    expect(calls[0].url).toBe('https://test.my.salesforce.com/services/data/v59.0/sobjects/Lead/describe/')
  })

  it('refuses an object name that is not an API name before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, LEAD))
    const err = await caught(describeSalesforceObject(source(fetch), '../limits'))
    expect(err.code).toBe('schema_key_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a source whose instance URL is not https before sending anything', async () => {
    const { fetch } = fetchSequence(json(200, SOBJECTS))
    const err = await caught(listSalesforceObjects({ ...source(fetch), instanceUrl: 'http://test.my.salesforce.com' }))
    expect(err.code).toBe('schema_source_invalid')
    expect(fetch).not.toHaveBeenCalled()
  })
})
