import { describe, it, expect } from 'vitest'
import { attributeWalkFailure } from '../index'
import type { StepLogEntry } from '../step-logger'

// Minimal step-log factory — only the fields attributeWalkFailure reads.
function step(p: Partial<StepLogEntry> & { step_namespace: string }): StepLogEntry {
  return {
    execution_id: 'e',
    execution_started_at: 't',
    step_type: 'code',
    status: 'completed',
    input: null,
    output: null,
    retries_used: 0,
    started_at: 't',
    completed_at: 't',
    duration_ms: 1,
    step_order: 0,
    ...p,
  }
}

const GROUP_ID = 'bidgroup-node-id'

describe('attributeWalkFailure', () => {
  it('returns null when no step failed (walk 5xx but nothing errored)', () => {
    const queue = [step({ step_namespace: 'a' }), step({ step_namespace: 'b' })]
    expect(attributeWalkFailure(queue, 502, 'b')).toBeNull()
  })

  it('blames the last genuinely-failed top-level step', () => {
    const queue = [
      step({ step_namespace: 'sf_create', step_type: 'salesforce' }),
      step({ step_namespace: 'sf_update', step_type: 'salesforce', status: 'failed', error_type: 'transient', error_message: 'SF 503' }),
    ]
    const r = attributeWalkFailure(queue, 503, 'sf_update')
    expect(r).toEqual({ failedStep: 'sf_update', failedErrorType: 'transient', errorMessage: 'SF 503' })
  })

  it('does NOT blame a partner child a completed bid_group absorbed — attributes to the terminal node', () => {
    const queue = [
      // completed bid_group (tolerated the partner error, routed no_winner)
      step({ step_namespace: 'bid_race', step_type: 'bid_group', step_node_id: GROUP_ID, status: 'completed' }),
      // synthesized child failure carries the group id as parallel_group_id
      step({ step_namespace: 'bid_race.tripoint', step_type: 'partner_bid', step_node_id: GROUP_ID, parallel_group_id: GROUP_ID, status: 'failed', error_type: 'transient', error_message: 'Partner API returned 502' }),
      // downstream fallback + terminal response both complete (terminal emitted the 5xx)
      step({ step_namespace: 'engine_no_bids_call', step_type: 'code', status: 'completed' }),
      step({ step_namespace: 'engine_failure_response', step_type: 'response', status: 'completed' }),
    ]
    const r = attributeWalkFailure(queue, 502, 'engine_failure_response')
    expect(r).toEqual({
      failedStep: 'engine_failure_response',
      failedErrorType: 'permanent',
      errorMessage: 'Workflow returned HTTP 502',
    })
    // crucially, NOT the tolerated partner blip
    expect(r?.failedStep).not.toBe('bid_race.tripoint')
    expect(r?.failedErrorType).not.toBe('transient')
  })

  it('still blames a partner child when its bid_group itself FAILED (not absorbed)', () => {
    const queue = [
      step({ step_namespace: 'bid_race', step_type: 'bid_group', step_node_id: GROUP_ID, status: 'failed', error_message: 'group threw' }),
      step({ step_namespace: 'bid_race.tripoint', step_type: 'partner_bid', step_node_id: GROUP_ID, parallel_group_id: GROUP_ID, status: 'failed', error_type: 'transient', error_message: 'Partner API returned 502' }),
    ]
    const r = attributeWalkFailure(queue, 502, 'bid_race')
    // group not in the absorbed set (it failed), so the child is a valid cause
    expect(r?.failedStep).toBe('bid_race.tripoint')
    expect(r?.failedErrorType).toBe('transient')
  })

  it('prefers a real downstream failure over an absorbed bid_group child', () => {
    const queue = [
      step({ step_namespace: 'bid_race', step_type: 'bid_group', step_node_id: GROUP_ID, status: 'completed' }),
      step({ step_namespace: 'bid_race.tripoint', step_type: 'partner_bid', step_node_id: GROUP_ID, parallel_group_id: GROUP_ID, status: 'failed', error_type: 'transient', error_message: '502' }),
      step({ step_namespace: 'save_result', step_type: 'salesforce', status: 'failed', error_type: 'permanent', error_message: 'SF 500' }),
    ]
    const r = attributeWalkFailure(queue, 500, 'save_result')
    expect(r?.failedStep).toBe('save_result')
    expect(r?.failedErrorType).toBe('permanent')
  })

  it('falls back to HTTP message when the cause step has no error_message', () => {
    const queue = [step({ step_namespace: 'x', status: 'failed', error_type: 'permanent' })]
    const r = attributeWalkFailure(queue, 500, 'x')
    expect(r?.errorMessage).toBe('Workflow returned HTTP 500')
  })
})
