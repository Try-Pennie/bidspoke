/**
 * The Salesforce request, URL and error classification helpers (#2335, PR 3 of
 * phase 5 of #1689), moved out of the Salesforce node so the ops connection path
 * judges a Salesforce answer by the same rules money does. Each expectation here
 * is the exact value the node built inline before the move, so a drift in the
 * shared copy is a drift in what money sends.
 */
import { describe, it, expect } from 'vitest'
import {
  SALESFORCE_API_VERSION,
  extractSalesforceErrorCode,
  extractSalesforceErrorFields,
  extractSalesforceErrorMessage,
  findSalesforceErrorRule,
  isSalesforceSessionRejected,
  parseSalesforceResponse,
  salesforceApexPath,
  salesforceApexUrl,
  salesforceDataUrl,
  salesforceFailureIsTransient,
  salesforceInstanceUrl,
  salesforceNextPageUrl,
  salesforceQueryUrl,
  salesforceRecordUrl,
  salesforceRejectedTheWrite,
  salesforceRequestHeaders,
  salesforceSobjectUrl,
  salesforceUpsertUrl,
} from '../salesforce-api'
import * as node from '../../engine/nodes/salesforce'

const INSTANCE = 'https://example.my.salesforce.com'

// The real Salesforce Edge page serves `<!doctypehtml>` with no space (#694, #695).
const EDGE_PAGE = '<!doctypehtml><html><head><title>Error</title></head><body>Salesforce Edge: connection reset</body></html>'

describe('the URLs', () => {
  it('calls the data API on v60.0', () => {
    expect(SALESFORCE_API_VERSION).toBe('v60.0')
    expect(salesforceDataUrl(INSTANCE, '/query/01g-2000')).toBe(`${INSTANCE}/services/data/v60.0/query/01g-2000`)
  })

  it('drops one trailing slash from the instance url and nothing else', () => {
    expect(salesforceInstanceUrl(`${INSTANCE}/`)).toBe(INSTANCE)
    expect(salesforceInstanceUrl(INSTANCE)).toBe(INSTANCE)
    expect(salesforceInstanceUrl(`${INSTANCE}//`)).toBe(`${INSTANCE}/`)
    expect(salesforceInstanceUrl('')).toBe('')
  })

  it('builds the create, update and upsert urls', () => {
    expect(salesforceSobjectUrl(INSTANCE, 'Prospect__c')).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c`)
    expect(salesforceRecordUrl(INSTANCE, 'Prospect__c', 'a01xx0000000001')).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c/a01xx0000000001`)
    expect(salesforceUpsertUrl(INSTANCE, 'Prospect__c', 'Ext_Id__c', 'abc-1')).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c/Ext_Id__c/abc-1`)
  })

  it('puts values into the path as they are, as the node always has', () => {
    // Not encoded: the node never encoded a record id or an external id value,
    // and a pure move must not start to.
    expect(salesforceRecordUrl(INSTANCE, 'Lead', 'a b')).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Lead/a b`)
    expect(salesforceRecordUrl(INSTANCE, 'Lead', '')).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Lead/`)
  })

  it('encodes the SOQL of a query', () => {
    expect(salesforceQueryUrl(INSTANCE, "SELECT Id FROM Lead WHERE Email = 'a+b@x.com'"))
      .toBe(`${INSTANCE}/services/data/v60.0/query?q=SELECT%20Id%20FROM%20Lead%20WHERE%20Email%20%3D%20'a%2Bb%40x.com'`)
  })

  it('gives an apex path exactly one leading slash, and an empty one is just the slash', () => {
    expect(salesforceApexPath('services/apexrest/prospect-trades')).toBe('/services/apexrest/prospect-trades')
    expect(salesforceApexPath('/services/apexrest/prospect-trades')).toBe('/services/apexrest/prospect-trades')
    expect(salesforceApexPath('')).toBe('/')
    expect(salesforceApexUrl(INSTANCE, '/services/apexrest/prospect-trades')).toBe(`${INSTANCE}/services/apexrest/prospect-trades`)
  })

  it('resolves a next records url given as a path, and keeps an absolute one', () => {
    expect(salesforceNextPageUrl(INSTANCE, '/services/data/v60.0/query/01g-2000')).toBe(`${INSTANCE}/services/data/v60.0/query/01g-2000`)
    expect(salesforceNextPageUrl(INSTANCE, 'https://other.my.salesforce.com/services/data/v60.0/query/01g-2000'))
      .toBe('https://other.my.salesforce.com/services/data/v60.0/query/01g-2000')
  })
})

describe('the request', () => {
  it('sends JSON with the bearer token and the trace id, in that order', () => {
    const headers = salesforceRequestHeaders('tok-1', 'trace-1')
    expect(headers).toEqual({ 'Content-Type': 'application/json', 'Authorization': 'Bearer tok-1', 'X-Trace-Id': 'trace-1' })
    expect(Object.keys(headers)).toEqual(['Content-Type', 'Authorization', 'X-Trace-Id'])
  })

  it('hands each caller its own headers, so swapping the token on one never reaches another', () => {
    const a = salesforceRequestHeaders('tok-1', 'trace-1')
    const b = salesforceRequestHeaders('tok-1', 'trace-1')
    a.Authorization = 'Bearer tok-2'
    expect(b.Authorization).toBe('Bearer tok-1')
  })
})

describe('reading the answer', () => {
  it('reads an empty answer (a 204 update) as null', () => {
    expect(parseSalesforceResponse('')).toBeNull()
  })

  it('parses JSON, and keeps anything else as its text', () => {
    expect(parseSalesforceResponse('{"id":"a01","success":true}')).toEqual({ id: 'a01', success: true })
    expect(parseSalesforceResponse('[{"errorCode":"INVALID_FIELD"}]')).toEqual([{ errorCode: 'INVALID_FIELD' }])
    expect(parseSalesforceResponse(EDGE_PAGE)).toBe(EDGE_PAGE)
    expect(parseSalesforceResponse('not json')).toBe('not json')
  })
})

describe('isSalesforceSessionRejected', () => {
  it('is a 401, the answer a revoked or expired token gets (#1741)', () => {
    expect(isSalesforceSessionRejected(401)).toBe(true)
  })

  it('is nothing else, a permission refusal included', () => {
    for (const status of [200, 204, 400, 403, 404, 429, 500, 503]) expect(isSalesforceSessionRejected(status)).toBe(false)
  })
})

describe('salesforceFailureIsTransient', () => {
  it('reads a rate limit and every server error as worth sending again', () => {
    for (const status of [429, 500, 502, 503, 520]) expect(salesforceFailureIsTransient(status, '')).toBe(true)
  })

  it('reads the Salesforce Edge HTML 400 as transient, never as a business rejection (#694)', () => {
    expect(salesforceFailureIsTransient(400, EDGE_PAGE)).toBe(true)
    expect(salesforceFailureIsTransient(400, '<!DOCTYPE html><html><body>x</body></html>')).toBe(true)
    expect(salesforceFailureIsTransient(404, '<html lang="en"><body>x</body></html>')).toBe(true)
  })

  it('reads every other refusal as final, angle brackets in a message included', () => {
    expect(salesforceFailureIsTransient(400, '[{"errorCode":"INVALID_FIELD","message":"Expected <number>"}]')).toBe(false)
    expect(salesforceFailureIsTransient(401, '[{"errorCode":"INVALID_SESSION_ID"}]')).toBe(false)
    expect(salesforceFailureIsTransient(403, '[{"errorCode":"REQUEST_LIMIT_EXCEEDED"}]')).toBe(false)
    expect(salesforceFailureIsTransient(404, '[{"errorCode":"NOT_FOUND"}]')).toBe(false)
    expect(salesforceFailureIsTransient(400, '<?xml version="1.0"?><fault/>')).toBe(false)
  })
})

describe('salesforceRejectedTheWrite', () => {
  it('is true for a business rejection of the write', () => {
    expect(salesforceRejectedTheWrite(400, '[{"errorCode":"INVALID_FIELD"}]')).toBe(true)
    expect(salesforceRejectedTheWrite(404, '[{"errorCode":"NOT_FOUND"}]')).toBe(true)
    expect(salesforceRejectedTheWrite(422, '')).toBe(true)
  })

  it('is false for a login or permission refusal, an edge page, a rate limit, a server error and a success', () => {
    expect(salesforceRejectedTheWrite(401, '[{"errorCode":"INVALID_SESSION_ID"}]')).toBe(false)
    expect(salesforceRejectedTheWrite(403, '[{"errorCode":"INSUFFICIENT_ACCESS"}]')).toBe(false)
    expect(salesforceRejectedTheWrite(400, EDGE_PAGE)).toBe(false)
    expect(salesforceRejectedTheWrite(429, '')).toBe(false)
    expect(salesforceRejectedTheWrite(503, 'unavailable')).toBe(false)
    expect(salesforceRejectedTheWrite(204, '')).toBe(false)
    expect(salesforceRejectedTheWrite(399, '')).toBe(false)
  })
})

describe('the error body', () => {
  const listBody = [{ errorCode: 'INVALID_EMAIL_ADDRESS', message: 'Email: invalid email address: x@', fields: ['Email__c', '', 7] }]

  it('reads the code, message and fields from the first entry of a list', () => {
    expect(extractSalesforceErrorCode(listBody)).toBe('INVALID_EMAIL_ADDRESS')
    expect(extractSalesforceErrorMessage(listBody)).toBe('Email: invalid email address: x@')
    expect(extractSalesforceErrorFields(listBody)).toEqual(['Email__c'])
  })

  it('reads them from a single object too', () => {
    const one = { errorCode: 'NOT_FOUND', message: 'gone', fields: ['Id'] }
    expect(extractSalesforceErrorCode(one)).toBe('NOT_FOUND')
    expect(extractSalesforceErrorMessage(one)).toBe('gone')
    expect(extractSalesforceErrorFields(one)).toEqual(['Id'])
  })

  it('reads nothing from a body that carries none', () => {
    for (const body of [null, undefined, '', EDGE_PAGE, [], {}, 42, [{ errorCode: 7, message: 8, fields: 'Email__c' }], [null]]) {
      expect(extractSalesforceErrorCode(body)).toBeNull()
      expect(extractSalesforceErrorMessage(body)).toBeNull()
      expect(extractSalesforceErrorFields(body)).toEqual([])
    }
  })

  it('reads only the first entry of a list, as Salesforce puts the cause first', () => {
    const two = [{ message: 'first' }, { errorCode: 'SECOND', message: 'second' }]
    expect(extractSalesforceErrorCode(two)).toBeNull()
    expect(extractSalesforceErrorMessage(two)).toBe('first')
  })
})

describe('findSalesforceErrorRule', () => {
  const body = [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'ConcurrentPerOrgLongTxn Limit exceeded' }]

  it('matches on the code alone when the rule names no message', () => {
    const rule = { code: 'REQUEST_LIMIT_EXCEEDED' }
    expect(findSalesforceErrorRule([rule], body)).toBe(rule)
    expect(findSalesforceErrorRule([{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: '   ' }], body)).toBeDefined()
  })

  it('matches only when the message contains the rule text as well', () => {
    expect(findSalesforceErrorRule([{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: ' Concurrent ' }], body)).toBeDefined()
    expect(findSalesforceErrorRule([{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'TotalRequests' }], body)).toBeUndefined()
  })

  it('never matches another code, a body with no code, or a rule list that is empty', () => {
    expect(findSalesforceErrorRule([{ code: 'INVALID_FIELD' }], body)).toBeUndefined()
    expect(findSalesforceErrorRule([{ code: 'REQUEST_LIMIT_EXCEEDED' }], EDGE_PAGE)).toBeUndefined()
    expect(findSalesforceErrorRule([{ code: '' }], [{ message: 'no code' }])).toBeUndefined()
    expect(findSalesforceErrorRule([], body)).toBeUndefined()
  })

  it('reads a missing message as empty, so a rule with text never matches it', () => {
    expect(findSalesforceErrorRule([{ code: 'X', message_contains: 'a' }], [{ errorCode: 'X' }])).toBeUndefined()
    expect(findSalesforceErrorRule([{ code: 'X' }], [{ errorCode: 'X' }])).toBeDefined()
  })

  it('returns the first rule that matches, carrying its own fields', () => {
    const rules = [
      { code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'TotalRequests', response_status: 1 },
      { code: 'REQUEST_LIMIT_EXCEEDED', response_status: 2 },
      { code: 'REQUEST_LIMIT_EXCEEDED', response_status: 3 },
    ]
    expect(findSalesforceErrorRule(rules, body)?.response_status).toBe(2)
  })
})

describe('one implementation', () => {
  it('the node hands out the shared rules themselves, not copies of them', () => {
    expect(node.salesforceFailureIsTransient).toBe(salesforceFailureIsTransient)
    expect(node.salesforceRejectedTheWrite).toBe(salesforceRejectedTheWrite)
  })
})
