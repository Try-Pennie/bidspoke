/**
 * Salesforce schema lookups (PRD Section 3.1; #2335 PR 7 of phase 5).
 *
 * The two keyed lookups (objects, fields of an object) take an injected fetch
 * and an already minted auth, and a failed describe is a named
 * SchemaLookupError, never an object with an empty field list (L10). The full
 * sync the canvas schema browser used went with it in #2338 (build PR 4).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { listSalesforceObjects, describeSalesforceObject, type SalesforceSource } from '../salesforce'
import { caught, fetchSequence, forbidGlobalFetch, headersOf, json, text, timeoutError, type Answer } from './_fetch'

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

describe('every request carries the auth it was given, at API v59.0', () => {
  it('the object list and a describe', async () => {
    forbidGlobalFetch()
    const list = fetchSequence(json(200, SOBJECTS))
    await listSalesforceObjects(source(list.fetch))
    const one = fetchSequence(json(200, CONTACT))
    await describeSalesforceObject(source(one.fetch), 'Contact')
    const calls = [...list.calls, ...one.calls]
    expect(calls.map((c) => c.url)).toEqual([
      'https://test.my.salesforce.com/services/data/v59.0/sobjects/',
      'https://test.my.salesforce.com/services/data/v59.0/sobjects/Contact/describe/',
    ])
    for (const call of calls) expect(headersOf(call.init).authorization).toBe('Bearer tok-abc')
  })

  it('a refused object list throws by name', async () => {
    const err = await caught(listSalesforceObjects(source(fetchSequence(json(401, [{ errorCode: 'INVALID_SESSION_ID' }])).fetch)))
    expect([err.code, err.step, err.status]).toEqual(['schema_auth_refused', 'object_list', 401])
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
    it(`in the fields lookup: ${label}`, async () => {
      const { fetch } = fetchSequence(answer instanceof Response ? answer.clone() : answer)
      const err = await caught(describeSalesforceObject(source(fetch), 'Lead'))
      expect(err.code).toBe(code)
      expect(err.service).toBe('salesforce')
      expect(err.step).toBe('object_describe')
      expect(err.subject).toBe('Lead')
      expect(err.status).toBe(status)
      expect(err.message).toContain(code)
      expect(err.message).toContain('Lead')
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
