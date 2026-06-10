import { describe, it, expect, vi } from 'vitest'
import { extractAchieveEvaluations, insertAchieveEvaluations } from '../achieve-log'
import type { StepLogEntry } from '../step-logger'

const meta = {
  trace_id: 'trace-1',
  execution_id: 'exec-1',
  workflow_id: 'wf-1',
  submission_id: 'a04Ui00000I6lTKIAZ',
  is_test: false,
}

function makeEntry(overrides: Partial<StepLogEntry>): StepLogEntry {
  return {
    execution_id: 'exec-1',
    execution_started_at: '2026-06-10T12:00:00.000Z',
    step_namespace: 'achieve_fdr',
    step_type: 'code',
    status: 'completed',
    input: {},
    output: null,
    retries_used: 0,
    started_at: '2026-06-10T12:00:01.000Z',
    completed_at: '2026-06-10T12:00:05.000Z',
    duration_ms: 4000,
    step_order: 5,
    ...overrides,
  }
}

const achieveOutput = {
  _achieve_evaluation: true as const,
  ok: true,
  status: 200,
  response_status: 'accepted',
  response_reason: null,
  offer_count: 2,
  request: {
    email: 'lead@example.com',
    social_security_number: '113-52-2922',
    date_of_birth: '1959-12-29',
    unsecured_debt: 30000,
  },
  response: { id: 749606, response: 'accepted' },
  offers: [{ provider: 'fdr', amount: 32787 }, { provider: 'fdr', amount: 30000 }],
}

describe('extractAchieveEvaluations', () => {
  it('returns empty array when no step carries the marker', () => {
    const queue = [
      makeEntry({ step_namespace: 'equifax_credit_report', output: { error: false } }),
      makeEntry({ step_namespace: 'bid_race', output: { winner: null } }),
    ]
    expect(extractAchieveEvaluations(queue, meta)).toEqual([])
  })

  it('extracts a row from a marked step output', () => {
    const queue = [makeEntry({ output: achieveOutput })]
    const rows = extractAchieveEvaluations(queue, meta)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      trace_id: 'trace-1',
      execution_id: 'exec-1',
      workflow_id: 'wf-1',
      node_namespace: 'achieve_fdr',
      submission_id: 'a04Ui00000I6lTKIAZ',
      requested_at_utc: '2026-06-10T12:00:01.000Z',
      duration_ms: 4000,
      http_status: 200,
      response_status: 'accepted',
      offer_count: 2,
      is_test: false,
    })
    expect(rows[0].offers).toEqual(achieveOutput.offers)
    expect(rows[0].response_body).toEqual(achieveOutput.response)
  })

  it('redacts SSN and DOB in the stored request copy', () => {
    const queue = [makeEntry({ output: achieveOutput })]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.request_payload).toEqual({
      email: 'lead@example.com',
      social_security_number: '[redacted]',
      date_of_birth: '[redacted]',
      unsecured_debt: 30000,
    })
    expect(achieveOutput.request.social_security_number).toBe('113-52-2922')
  })

  it('handles error-shaped outputs with no offers', () => {
    const queue = [
      makeEntry({
        output: {
          _achieve_evaluation: true,
          ok: false,
          status: 401,
          response_status: 'error',
          response_reason: 'Invalid credentials',
        },
      }),
    ]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.http_status).toBe(401)
    expect(row.response_status).toBe('error')
    expect(row.response_reason).toBe('Invalid credentials')
    expect(row.offer_count).toBe(0)
    expect(row.offers).toBeNull()
    expect(row.request_payload).toBeNull()
  })

  it('ignores outputs without a strictly-true marker', () => {
    const queue = [
      makeEntry({ output: { _achieve_evaluation: 'yes' } }),
      makeEntry({ output: 'string output' }),
      makeEntry({ output: null }),
    ]
    expect(extractAchieveEvaluations(queue, meta)).toEqual([])
  })

  it('extracts multiple rows when several nodes report', () => {
    const queue = [
      makeEntry({ step_namespace: 'achieve_fdr', output: achieveOutput }),
      makeEntry({ step_namespace: 'achieve_fdr_20k', output: achieveOutput }),
    ]
    const rows = extractAchieveEvaluations(queue, meta)
    expect(rows.map((r) => r.node_namespace)).toEqual(['achieve_fdr', 'achieve_fdr_20k'])
  })

  it('passes through is_test and null submission_id', () => {
    const queue = [makeEntry({ output: achieveOutput })]
    const [row] = extractAchieveEvaluations(queue, { ...meta, submission_id: null, is_test: true })
    expect(row.submission_id).toBeNull()
    expect(row.is_test).toBe(true)
  })
})

describe('insertAchieveEvaluations', () => {
  it('skips the insert entirely when rows is empty', async () => {
    const insert = vi.fn()
    const supabase = { from: vi.fn(() => ({ insert })) }
    await insertAchieveEvaluations(supabase as never, [])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('inserts rows and does not throw on Supabase error', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const supabase = { from: vi.fn(() => ({ insert })) }
    const queue = [makeEntry({ output: achieveOutput })]
    const rows = extractAchieveEvaluations(queue, meta)
    await expect(insertAchieveEvaluations(supabase as never, rows)).resolves.toBeUndefined()
    expect(supabase.from).toHaveBeenCalledWith('achieve_evaluations')
    expect(insert).toHaveBeenCalledWith(rows)
  })
})
