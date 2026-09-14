import { describe, it, expect, vi } from 'vitest'
import { extractAchieveEvaluations, insertAchieveEvaluations } from '../achieve-log'
import * as durability from '../durability'
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

describe('extractAchieveEvaluations credit metrics', () => {
  it('carries the derived credit metrics onto the row', () => {
    const metrics = { vantage_score: 645, revolving_utilisation: 0.82, collections: 2 }
    const [row] = extractAchieveEvaluations(
      [makeEntry({ output: { ...achieveOutput, credit_metrics: metrics } })],
      meta
    )
    expect(row.credit_metrics).toEqual(metrics)
  })

  // Null, not undefined: undefined is dropped from the insert entirely, which would leave the
  // column unset and indistinguishable from a row written before this shipped.
  it('writes null when the output carries no metrics', () => {
    const [row] = extractAchieveEvaluations([makeEntry({ output: achieveOutput })], meta)
    expect(row.credit_metrics).toBeNull()
  })
})

describe('extractAchieveEvaluations response identifiers', () => {
  // Achieve's decline responses carry no detail beyond one sentence, so their own request
  // id is what lets support find a call. It is worth nothing unless it reaches the row.
  it('carries both identifiers from the step output onto the row', () => {
    const queue = [
      makeEntry({
        output: {
          ...achieveOutput,
          achieve_request_id: 'fb455718-1770-40fd-ac81-67df5c5b49b1',
          cf_ray: 'a397a44589f60c9b-EWR',
        },
      }),
    ]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.achieve_request_id).toBe('fb455718-1770-40fd-ac81-67df5c5b49b1')
    expect(row.cf_ray).toBe('a397a44589f60c9b-EWR')
  })

  // Rows written before this shipped, and any path that never made a call, carry neither
  // key. Null keeps "nothing was captured" distinguishable from a value, where an absent
  // key would leave the column silently unset.
  it('writes null for an output that carries neither identifier', () => {
    const [row] = extractAchieveEvaluations([makeEntry({ output: achieveOutput })], meta)
    expect(row.achieve_request_id).toBeNull()
    expect(row.cf_ray).toBeNull()
  })
})

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

  // The achieve_offers node is a PASS-THROUGH: its marked output becomes the input of
  // everything downstream, and a branch_end re-emits what it received. Keying purely off
  // the marker therefore logged one row per node the output travelled through, not one
  // per Achieve call.
  //
  // Observed in prod 2026-07-13: a single call wrote 6 identical rows (the real node at
  // 552ms, plus branch_end_2 / branch_end_4 / state_condition_check_end /
  // eligibility_success_end / adv_bes_leg_screening_end at 0ms each), inflating the table
  // 6x and polluting node_namespace, which is the column the analysis slices by.
  //
  // Only a node type that can actually PRODUCE an evaluation may be logged. Node NAME
  // stays free-form (the docs promise that); it is the type that is constrained.
  it('logs one row per Achieve call, not per node the output passes through', () => {
    const queue = [
      makeEntry({ step_namespace: 'achieve_under_10k', step_type: 'achieve_offers', output: achieveOutput }),
      makeEntry({ step_namespace: 'branch_end_4', step_type: 'branch_end', output: achieveOutput, duration_ms: 0 }),
      makeEntry({ step_namespace: 'state_condition_check_end', step_type: 'branch_end', output: achieveOutput, duration_ms: 0 }),
      makeEntry({ step_namespace: 'eligibility_success_end', step_type: 'branch_end', output: achieveOutput, duration_ms: 0 }),
      makeEntry({ step_namespace: 'parallel_end_1', step_type: 'parallel_end', output: achieveOutput, duration_ms: 0 }),
    ]
    const rows = extractAchieveEvaluations(queue, meta)
    expect(rows.map((r) => r.node_namespace)).toEqual(['achieve_under_10k'])
  })

  it('still logs a code node that emits the marker itself', () => {
    const queue = [makeEntry({ step_namespace: 'achieve_fdr', step_type: 'code', output: achieveOutput })]
    const rows = extractAchieveEvaluations(queue, meta)
    expect(rows.map((r) => r.node_namespace)).toEqual(['achieve_fdr'])
  })

  // Off production the node sends Achieve's seeded showroom identity, so the offers and the
  // accept/decline are for a FAKE person: they say nothing about our real leads. The lead
  // VOLUME and the real debt figure in the row are still real, though, so the row must be
  // flagged rather than hidden (is_test would hide it from the export and every documented
  // analysis query). Analysts filter on is_sandbox deliberately.
  it('flags a sandbox evaluation with is_sandbox', () => {
    const queue = [
      makeEntry({
        step_type: 'achieve_offers',
        output: { ...achieveOutput, sandbox: true },
      }),
    ]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.is_sandbox).toBe(true)
  })

  it('marks a production evaluation as not sandbox', () => {
    const queue = [
      makeEntry({
        step_type: 'achieve_offers',
        output: { ...achieveOutput, sandbox: false },
      }),
    ]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.is_sandbox).toBe(false)
  })

  // Defaults to sandbox when the marker is absent: an unflagged row is more likely an old
  // sandbox row than real production data, and a false negative here silently poisons the
  // analysis.
  it('defaults is_sandbox to true when the output carries no flag', () => {
    const queue = [makeEntry({ step_type: 'achieve_offers', output: achieveOutput })]
    const [row] = extractAchieveEvaluations(queue, meta)
    expect(row.is_sandbox).toBe(true)
  })

  it('logs both Achieve nodes when two of them genuinely fire', () => {
    const queue = [
      makeEntry({ step_namespace: 'achieve_no_bids', step_type: 'achieve_offers', output: achieveOutput }),
      makeEntry({ step_namespace: 'branch_end_3', step_type: 'branch_end', output: achieveOutput, duration_ms: 0 }),
      makeEntry({ step_namespace: 'achieve_under_10k', step_type: 'achieve_offers', output: achieveOutput }),
      makeEntry({ step_namespace: 'branch_end_4', step_type: 'branch_end', output: achieveOutput, duration_ms: 0 }),
    ]
    const rows = extractAchieveEvaluations(queue, meta)
    expect(rows.map((r) => r.node_namespace)).toEqual(['achieve_no_bids', 'achieve_under_10k'])
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

  // #362: achieve_evaluations is analytical volume data — classified tier-1
  // (loss-tolerant), so the write declares that tier at the call site via the
  // durability seam (greppable + CI-visible), even though behavior is unchanged.
  it('routes the write through the tier-1 observability seam', async () => {
    const spy = vi.spyOn(durability, 'writeObservability')
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn(() => ({ insert })) }
    const rows = extractAchieveEvaluations([makeEntry({ output: achieveOutput })], meta)
    await insertAchieveEvaluations(supabase as never, rows)
    expect(spy).toHaveBeenCalledWith('achieve_evaluation', expect.any(Function))
    expect(insert).toHaveBeenCalledWith(rows)
    spy.mockRestore()
  })

  it('does not call the seam when there are no rows', async () => {
    const spy = vi.spyOn(durability, 'writeObservability')
    const supabase = { from: vi.fn() }
    await insertAchieveEvaluations(supabase as never, [])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
