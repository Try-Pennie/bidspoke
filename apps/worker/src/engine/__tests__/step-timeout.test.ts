/**
 * A step that hit a deadline is marked as such on its step row (#3047, L35).
 *
 * Before this, a timed out step said so only in its `error_message` text, and
 * `error_type` was just `transient`, so the daily direct write report (#2938)
 * and the step timeout audit (#2934) each found timeouts by matching that text.
 * The engine now classifies the timeout once, where it happens: withTimeout
 * rejects with a StepTimeoutError, and the step row carries `timeout_kind` and
 * `timed_out_after_ms`. Readers ask the marker, and fall back to the text only
 * for a row written before the marker existed.
 */
import { describe, it, expect } from 'vitest'
import {
  StepTimeoutError,
  STEP_DEADLINE,
  PARALLEL_BLOCK_DEADLINE,
  TIMEOUT_KINDS,
  stepTimeoutMessage,
  stepTimeoutMarkerOf,
  stepTimedOut,
  stepTimedOutAfterMs,
} from '../step-timeout'

describe('the step deadline error carries its own classification', () => {
  it('says what it always said, and carries the deadline as a number', () => {
    const err = new StepTimeoutError(4_500)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Step timed out after 4500ms (in-flight upstream call canceled via abort signal)')
    expect(err.message).toBe(stepTimeoutMessage(4_500))
    expect(err.timeoutMs).toBe(4_500)
  })

  it('marks the step row of a step its own deadline stopped', () => {
    expect(stepTimeoutMarkerOf(new StepTimeoutError(5_250))).toEqual({ timeout_kind: STEP_DEADLINE, timed_out_after_ms: 5_250 })
  })

  it('marks nothing for any other failure, even one whose text reads like a timeout', () => {
    expect(stepTimeoutMarkerOf(new Error(stepTimeoutMessage(5_250)))).toBeNull()
    expect(stepTimeoutMarkerOf(new Error('Salesforce token fetch timed out after 10000 ms'))).toBeNull()
    expect(stepTimeoutMarkerOf({ message: stepTimeoutMessage(5_250) })).toBeNull()
    expect(stepTimeoutMarkerOf(null)).toBeNull()
    expect(stepTimeoutMarkerOf(undefined)).toBeNull()
  })

  it('names two kinds of deadline, the step\'s own and its parallel block\'s', () => {
    expect([...TIMEOUT_KINDS]).toEqual([STEP_DEADLINE, PARALLEL_BLOCK_DEADLINE])
    expect(STEP_DEADLINE).toBe('step')
    expect(PARALLEL_BLOCK_DEADLINE).toBe('parallel_block')
  })
})

describe('reading a step row: did the step time out at its own deadline, and after how long', () => {
  it('reads the marker', () => {
    const row = { timeout_kind: 'step', timed_out_after_ms: 4_500, error_message: 'any wording at all' }
    expect(stepTimedOut(row)).toBe(true)
    expect(stepTimedOutAfterMs(row)).toBe(4_500)
  })

  it('a parallel block cutting a child off is a timeout of the block, not of the step', () => {
    const row = { timeout_kind: 'parallel_block', timed_out_after_ms: 20_000, error_message: 'Parallel group timed out after 20000ms before this child completed' }
    expect(stepTimedOut(row)).toBe(false)
    expect(stepTimedOutAfterMs(row)).toBeNull()
  })

  it('a marked row is judged by its marker alone, never by its text', () => {
    const row = { timeout_kind: 'parallel_block', timed_out_after_ms: 20_000, error_message: stepTimeoutMessage(4_500) }
    expect(stepTimedOut(row)).toBe(false)
    expect(stepTimedOut({ timeout_kind: 'some_new_kind', timed_out_after_ms: 1, error_message: stepTimeoutMessage(1) })).toBe(false)
  })

  it('a step marked as timed out whose deadline did not survive still timed out, with no deadline to state', () => {
    expect(stepTimedOut({ timeout_kind: 'step', timed_out_after_ms: null })).toBe(true)
    expect(stepTimedOutAfterMs({ timeout_kind: 'step', timed_out_after_ms: null })).toBeNull()
    expect(stepTimedOutAfterMs({ timeout_kind: 'step', timed_out_after_ms: 'soon' })).toBeNull()
  })

  it('a row written before the marker existed is still read by its text', () => {
    expect(stepTimedOut({ error_message: stepTimeoutMessage(5_250) })).toBe(true)
    expect(stepTimedOutAfterMs({ error_message: stepTimeoutMessage(5_250) })).toBe(5_250)
    expect(stepTimedOut({ timeout_kind: null, timed_out_after_ms: null, error_message: stepTimeoutMessage(5_250) })).toBe(true)
  })

  it('reads nothing from any other error, nor from no error', () => {
    for (const error_message of [
      'Salesforce token fetch timed out after 10000 ms',
      'Parallel group timed out after 20000ms before this child completed',
      'HTTP 503: Step timed out after 10ms',
      null,
      undefined,
    ]) {
      expect(stepTimedOut({ error_message })).toBe(false)
      expect(stepTimedOutAfterMs({ error_message })).toBeNull()
    }
  })
})
