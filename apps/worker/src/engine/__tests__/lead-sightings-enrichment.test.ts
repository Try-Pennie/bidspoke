/**
 * extractEnrichment reads the Equifax score for a sighting (#1379).
 *
 * Main Flow's equifax_credit_report step wraps the report one level deeper than the Engine
 * workflow does ({ data: { consumers, status }, error, statusCode } against { consumers,
 * status }). The writer read only the flat shape, so every Main Flow sighting since
 * 2026-08-19 carried equifax_score null, 87,954 rows measured on 2026-09-17, while recording
 * equifax_status 'success', a word no workflow ever emits: it was the fallback written when
 * no status string was found, so the missing score read as a healthy pull.
 *
 * The shapes below are the two observed in production (see achieve-credit-report.test.ts,
 * measured across 500 live pulls), and the nested status value is the one measured live on
 * 2026-09-17 ('completed' on 40 of 40 Main Flow steps).
 */
import { describe, it, expect } from 'vitest'
import { extractEnrichment } from '../lead-sightings'
import type { StepOutput } from '../../types'

function report(score: string | number = '612') {
  return { models: [{ score }], trades: [], inquiries: [] }
}

/** Engine workflow shape: consumers and status at the top level of the step output. */
function engineShape(rep: unknown, status = 'completed') {
  return { consumers: { equifaxUSConsumerCreditReport: [rep] }, status }
}

/** Main Flow shape: the same report and status wrapped one level deeper under `data`. */
function mainFlowShape(rep: unknown, status = 'completed') {
  return { data: { consumers: { equifaxUSConsumerCreditReport: [rep] }, status }, error: null, statusCode: 200 }
}

function completed(output: unknown): Record<string, StepOutput> {
  return { equifax_credit_report: { status: 'completed', output } }
}

describe('extractEnrichment: Equifax score and status', () => {
  it('reads the score from the Main Flow nested shape', () => {
    const got = extractEnrichment(completed(mainFlowShape(report('612'))))
    expect(got.equifax_score).toBe(612)
  })

  it('reads the status from the Main Flow nested shape rather than inventing one', () => {
    const got = extractEnrichment(completed(mainFlowShape(report(), 'completed')))
    expect(got.equifax_status).toBe('completed')
  })

  it('still reads the score and status from the Engine flat shape', () => {
    const got = extractEnrichment(completed(engineShape(report(640), 'completed')))
    expect(got.equifax_score).toBe(640)
    expect(got.equifax_status).toBe('completed')
  })

  it('records the step status, never the word success, when the output carries no status', () => {
    const got = extractEnrichment(completed({ consumers: { equifaxUSConsumerCreditReport: [report()] } }))
    expect(got.equifax_status).toBe('completed')
    expect(got.equifax_status).not.toBe('success')
  })

  it('records a completed step that holds no report at all as an error, never as completed (#1381)', () => {
    // Before #1381 this read 'completed', the word the output carried about the
    // CALL. A pull that produced no report found nothing, so it is not a
    // completed pull in the sense a reader of the sighting means.
    const got = extractEnrichment(completed({ data: { consumers: null, status: 'completed' }, error: null, statusCode: 200 }))
    expect(got.equifax_score).toBeNull()
    expect(got.equifax_status).toBe('error')
  })

  it('records a failed pull as error with its type', () => {
    const steps: Record<string, StepOutput> = {
      equifax_credit_report: { status: 'failed', output: null, error: 'boom', error_type: 'transient' },
    }
    const got = extractEnrichment(steps)
    expect(got.equifax_status).toBe('error')
    expect(got.equifax_error_type).toBe('transient')
    expect(got.equifax_score).toBeNull()
  })
})

/**
 * What the pull FOUND, not what the call did (#1381).
 *
 * The shells below carry exactly the sections measured on live pulls on
 * 2026-09-24 (12 hours, 15,773 completed steps), with every value replaced:
 * a file that was not delivered comes back with only the envelope sections,
 * and Equifax's own wording for each hit code was read from the Eligibility
 * Scout errors that quote it ('[A - Consumer Requested Security Freeze on
 * His/Her Credit File Report Unavailable]', '[I - Information from your
 * inquiry has been identified as potentially fraudulent or misused ...]',
 * '[2 - No-Hit]', '[4 - MANUAL FILE REVIEW REQUIRED]', '[5 - REFERRED FILE]').
 */
function envelope(hit: string, extra: Record<string, unknown> = {}) {
  return {
    consumerReferralCode: '000',
    customerNumber: 'X',
    customerReferenceNumber: 'X',
    ECOAInquiryType: 'I',
    fraudIDScanAlertCodes: [],
    hitCode: { code: hit },
    identifier: 'X',
    multipleReportIndicator: 'N',
    reportDate: '09242026',
    ...extra,
  }
}

describe('extractEnrichment: the Equifax hit outcome (#1381)', () => {
  it.each([
    ['A', 'frozen'],
    ['I', 'fraud'],
    ['2', 'no_hit'],
    ['4', 'referred'],
    ['5', 'referred'],
  ])('records hit code %s as %s, with no score', (hit, outcome) => {
    const got = extractEnrichment(completed(mainFlowShape(envelope(hit))))
    expect(got.equifax_status).toBe(outcome)
    expect(got.equifax_score).toBeNull()
  })

  it('does not record the no-hit model value 4 as a credit score', () => {
    // 20 of 66 no-hit pulls measured carry models[0].score '4', a reject code
    // on a 300 to 850 scale. It was being recorded as the lead's score.
    const rep = envelope('2', { models: [{ type: 'MODEL', score: '4', modelNumber: '05402' }] })
    const got = extractEnrichment(completed(mainFlowShape(rep)))
    expect(got.equifax_status).toBe('no_hit')
    expect(got.equifax_score).toBeNull()
  })

  it('keeps completed for a delivered and scored file, under either hit code', () => {
    for (const hit of ['1', '6']) {
      const got = extractEnrichment(completed(mainFlowShape({ ...report('655'), hitCode: { code: hit } })))
      expect(got.equifax_status).toBe('completed')
      expect(got.equifax_score).toBe(655)
    }
  })

  it('records a delivered file whose score was rejected as unscored', () => {
    const rep = { trades: [], hitCode: { code: '1' }, models: [{ type: 'MODEL', rejects: [{ code: 'X' }], modelNumber: '05402' }] }
    const got = extractEnrichment(completed(mainFlowShape(rep)))
    expect(got.equifax_status).toBe('unscored')
    expect(got.equifax_score).toBeNull()
  })

  it('records an Equifax refusal to search as an error of the permanent kind', () => {
    const rep = {
      errors: [{ code: '07C', message: 'INSUFFICIENT INFORMATION FOR FILE SEARCH - ADDITIONAL DATA IS NEEDED', errorType: 'X' }],
      status: '200',
      timeStamp: 'X',
    }
    const got = extractEnrichment(completed(mainFlowShape(rep)))
    expect(got.equifax_status).toBe('error')
    expect(got.equifax_error_type).toBe('permanent')
    expect(got.equifax_score).toBeNull()
  })

  it('reads the outcome from the Engine flat shape too', () => {
    const got = extractEnrichment(completed(engineShape(envelope('A'))))
    expect(got.equifax_status).toBe('frozen')
  })
})
