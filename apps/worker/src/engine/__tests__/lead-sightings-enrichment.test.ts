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

  it('leaves the score null when the completed output holds no report at all', () => {
    const got = extractEnrichment(completed({ data: { consumers: null, status: 'completed' }, error: null, statusCode: 200 }))
    expect(got.equifax_score).toBeNull()
    expect(got.equifax_status).toBe('completed')
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
