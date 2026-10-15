/**
 * What a credit inquiry post is, and what its body can write (#2172, D5 of #1680).
 *
 * `POST /services/apexrest/credit-inquiries` (InquiryParserRest) attaches a NEW
 * file to the Lead on every call that carries inquiries, so it is never resent
 * blind. It writes nothing for an empty list and answers 500, before any write,
 * for a list that is missing (#2169: 2,562 of 21,848 posts in 7 days). These
 * rules decide which posts the engine never retries, which ones it skips, and
 * which held ones the read-back can resend.
 */
import { describe, it, expect } from 'vitest'
import {
  CREDIT_INQUIRY_APEX_PATH,
  isCreditInquiryPost,
  inquiryPostOf,
  stepRetries,
  inquiryMarkerQuery,
} from '../inquiry-post'
import { INQUIRY_APEX_PATH } from '../../lib/main-flow-port/transform'

const SUB = 'a0XUi00000AbCdEFGH'
const LEAD = '00QUi00000XyZaBCDE'
const body = (inquiriesJson: unknown, submissionId: unknown = SUB) => ({ submissionId, inquiriesJson })

describe('isCreditInquiryPost', () => {
  it('is the Apex POST to the credit-inquiries endpoint, however its path is spelled', () => {
    expect(isCreditInquiryPost({ operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH })).toBe(true)
    expect(isCreditInquiryPost({ operation: 'apex', apex_path: 'services/apexrest/credit-inquiries' })).toBe(true)
    expect(isCreditInquiryPost({ operation: 'apex', apex_path: '/services/apexrest/credit-inquiries/', apex_method: 'POST' })).toBe(true)
  })

  it('is not a GET, another Apex endpoint, or another operation', () => {
    expect(isCreditInquiryPost({ operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, apex_method: 'GET' })).toBe(false)
    expect(isCreditInquiryPost({ operation: 'apex', apex_path: '/services/apexrest/credit-trades' })).toBe(false)
    expect(isCreditInquiryPost({ operation: 'update', apex_path: CREDIT_INQUIRY_APEX_PATH })).toBe(false)
  })

  it('names the same endpoint the Main Flow port builds its Apex call with', () => {
    expect(CREDIT_INQUIRY_APEX_PATH).toBe(INQUIRY_APEX_PATH)
  })
})

describe('stepRetries', () => {
  const node = (config: Record<string, unknown>) => ({ type: 'salesforce', config })

  it('keeps the engine default of 2, and a step\'s own count, for every other step', () => {
    expect(stepRetries(node({ operation: 'update' }))).toBe(2)
    expect(stepRetries(node({ operation: 'update', retries: 4 }))).toBe(4)
    expect(stepRetries({ type: 'code', config: { retries: 1 } })).toBe(1)
    expect(stepRetries(node({ operation: 'apex', apex_path: '/services/apexrest/credit-trades' }))).toBe(2)
  })

  it('is 0 for a credit inquiry post whatever its config asks, so the engine never sends it twice', () => {
    expect(stepRetries(node({ operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH }))).toBe(0)
    expect(stepRetries(node({ operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, retries: 2 }))).toBe(0)
  })
})

describe('inquiryPostOf', () => {
  it('reads a list of inquiries and the Submission it is for', () => {
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: [{ type: 'H' }, { type: 'S' }] })))).toEqual({ kind: 'inquiries', submissionId: SUB, count: 2 })
  })

  it('reads the key the way Apex does, whatever its case', () => {
    expect(inquiryPostOf({ SubmissionId: SUB, inquiriesJSON: JSON.stringify({ inquiries: [{}] }) })).toEqual({ kind: 'inquiries', submissionId: SUB, count: 1 })
  })

  it('an empty list is a post that writes nothing and is answered 200', () => {
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: [] })))).toEqual({ kind: 'empty', submissionId: SUB })
  })

  it('a missing or null list is a post Salesforce answers 500 before writing anything', () => {
    expect(inquiryPostOf(body(JSON.stringify({})))).toEqual({ kind: 'missing_list', submissionId: SUB })
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: null })))).toEqual({ kind: 'missing_list', submissionId: SUB })
  })

  it('anything else is malformed, with why', () => {
    expect(inquiryPostOf(null)).toMatchObject({ kind: 'malformed' })
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: [] }), ''))).toMatchObject({ kind: 'malformed', reason: expect.stringMatching(/Submission/) })
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: [] }), 'not an id'))).toMatchObject({ kind: 'malformed' })
    expect(inquiryPostOf(body('not json'))).toMatchObject({ kind: 'malformed', reason: expect.stringMatching(/JSON/) })
    expect(inquiryPostOf(body({ inquiries: [] }))).toMatchObject({ kind: 'malformed' })
    expect(inquiryPostOf(body(JSON.stringify({ inquiries: 'three' })))).toMatchObject({ kind: 'malformed' })
  })
})

describe('inquiryMarkerQuery', () => {
  it('asks for the Inquiries file linked to the Lead and created since the post began, less a margin', () => {
    const soql = inquiryMarkerQuery(LEAD, Date.parse('2026-10-15T20:00:00.000Z'))
    expect(soql).toBe(
      `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${LEAD}' AND ContentDocument.Title = 'Inquiries_${LEAD}' AND ContentDocument.CreatedDate >= 2026-10-15T19:59:58Z`,
    )
  })

  it('refuses anything that is not a record id, so nothing reaches the query text', () => {
    expect(() => inquiryMarkerQuery("00Q' OR Id != '", 0)).toThrow(/record id/)
  })
})
