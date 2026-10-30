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
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  StepTimeoutError,
  STEP_DEADLINE,
  PARALLEL_BLOCK_DEADLINE,
  CODE_CHAIN_DEADLINE,
  REQUEST_DEADLINE,
  PARTNER_BID_DEADLINE,
  BID_GROUP_DEADLINE,
  BUYER_SELECT_DEADLINE,
  BUYER_CALL_DEADLINE,
  ACHIEVE_OFFERS_DEADLINE,
  CLICK_POST_DEADLINE,
  TIMEOUT_KINDS,
  abortAfter,
  carryDeadline,
  markDeadline,
  stepTimeoutMessage,
  stepTimeoutMarkerOf,
  timeoutMarker,
  stepTimedOut,
  stepTimedOutAfterMs,
  deadlineKindOf,
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

  // timed_out_after_ms is an INTEGER column, and a step's timeout_ms comes from
  // its config unvalidated: a value the column refuses would fail the step's row,
  // so it is rounded into range, or left out with the step still marked.
  it('records a deadline the column can hold: rounded to whole ms, or none when it cannot be', () => {
    expect(stepTimeoutMarkerOf(new StepTimeoutError(4_500.4))).toEqual({ timeout_kind: STEP_DEADLINE, timed_out_after_ms: 4_500 })
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 3_000_000_000, '5000' as unknown as number]) {
      expect(stepTimeoutMarkerOf(new StepTimeoutError(ms))).toEqual({ timeout_kind: STEP_DEADLINE, timed_out_after_ms: null })
    }
    expect(timeoutMarker(PARALLEL_BLOCK_DEADLINE, 20_000.6)).toEqual({ timeout_kind: PARALLEL_BLOCK_DEADLINE, timed_out_after_ms: 20_001 })
    expect(timeoutMarker(PARALLEL_BLOCK_DEADLINE, 2 ** 31)).toEqual({ timeout_kind: PARALLEL_BLOCK_DEADLINE, timed_out_after_ms: null })
  })

  it('marks nothing for any other failure, even one whose text reads like a timeout', () => {
    expect(stepTimeoutMarkerOf(new Error(stepTimeoutMessage(5_250)))).toBeNull()
    expect(stepTimeoutMarkerOf(new Error('Salesforce token fetch timed out after 10000 ms'))).toBeNull()
    expect(stepTimeoutMarkerOf({ message: stepTimeoutMessage(5_250) })).toBeNull()
    expect(stepTimeoutMarkerOf(null)).toBeNull()
    expect(stepTimeoutMarkerOf(undefined)).toBeNull()
  })

  it('names each of our deadlines as its own kind (#3068)', () => {
    expect([...TIMEOUT_KINDS]).toEqual([STEP_DEADLINE, PARALLEL_BLOCK_DEADLINE, CODE_CHAIN_DEADLINE, REQUEST_DEADLINE, PARTNER_BID_DEADLINE, BID_GROUP_DEADLINE, BUYER_SELECT_DEADLINE, BUYER_CALL_DEADLINE, ACHIEVE_OFFERS_DEADLINE, CLICK_POST_DEADLINE])
    expect(STEP_DEADLINE).toBe('step')
    expect(PARALLEL_BLOCK_DEADLINE).toBe('parallel_block')
    expect(CODE_CHAIN_DEADLINE).toBe('code_chain')
    expect(REQUEST_DEADLINE).toBe('request')
    expect(PARTNER_BID_DEADLINE).toBe('partner_bid')
    expect(BID_GROUP_DEADLINE).toBe('bid_group')
    expect(BUYER_SELECT_DEADLINE).toBe('buyer_select')
    // #3075: the buyer select live buyer call's timer and the achieve_offers node's own wait.
    expect(BUYER_CALL_DEADLINE).toBe('buyer_call')
    expect(ACHIEVE_OFFERS_DEADLINE).toBe('achieve_offers')
    // #3079: buyer_click_send stopped waiting for its post, which had not ended at its own abort.
    expect(CLICK_POST_DEADLINE).toBe('click_post')
    // Only the step's own deadline is what the audit and the daily report count.
    expect(TIMEOUT_KINDS.filter((k) => k === 'step')).toEqual([STEP_DEADLINE])
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

/**
 * #3068: deadlines other than the step's own are marked where they pass. A
 * node's own request timer aborts its fetch, which fails with the platform's
 * "The operation was aborted", the same words any other abort produces. So the
 * error is marked by the timer that fired, never read from its text.
 */
describe('our own timers mark the error they caused, and only that one', () => {
  afterEach(() => { vi.useRealTimers() })

  const platformAbort = () => new DOMException('The operation was aborted.', 'AbortError')

  it('a marked error carries its kind and deadline to the step row', () => {
    const err = markDeadline(platformAbort(), REQUEST_DEADLINE, 15_000)
    expect(stepTimeoutMarkerOf(err)).toEqual({ timeout_kind: REQUEST_DEADLINE, timed_out_after_ms: 15_000 })
  })

  it('an abort nothing marked is not a timeout, whatever it says', () => {
    expect(stepTimeoutMarkerOf(platformAbort())).toBeNull()
    expect(stepTimeoutMarkerOf(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBeNull()
  })

  it('the step deadline wins over any mark, since it is what stopped the step', () => {
    const err = markDeadline(new StepTimeoutError(4_500), REQUEST_DEADLINE, 15_000)
    expect(stepTimeoutMarkerOf(err)).toEqual({ timeout_kind: STEP_DEADLINE, timed_out_after_ms: 4_500 })
  })

  it('a node that re-wraps the error carries the mark onto the new one, and an unmarked one stays unmarked', () => {
    const marked = markDeadline(platformAbort(), PARTNER_BID_DEADLINE, 15_000)
    const wrapped = carryDeadline(marked, new Error('The operation was aborted.'))
    expect(stepTimeoutMarkerOf(wrapped)).toEqual({ timeout_kind: PARTNER_BID_DEADLINE, timed_out_after_ms: 15_000 })
    expect(stepTimeoutMarkerOf(carryDeadline(platformAbort(), new Error('x')))).toBeNull()
    expect(stepTimeoutMarkerOf(carryDeadline(null, new Error('x')))).toBeNull()
  })

  it('marking something that is not an object is a no-op, never a throw', () => {
    expect(markDeadline('a string', REQUEST_DEADLINE, 1)).toBe('a string')
    expect(markDeadline(null, REQUEST_DEADLINE, 1)).toBeNull()
    expect(stepTimeoutMarkerOf('a string')).toBeNull()
  })

  it('a timer that fired aborts the controller and marks what the abort threw', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const timer = abortAfter(controller, 15_000, REQUEST_DEADLINE)
    vi.advanceTimersByTime(14_999)
    expect(controller.signal.aborted).toBe(false)
    expect(timer.fired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(controller.signal.aborted).toBe(true)
    expect(timer.fired()).toBe(true)
    expect(stepTimeoutMarkerOf(timer.mark(platformAbort()))).toEqual({ timeout_kind: REQUEST_DEADLINE, timed_out_after_ms: 15_000 })
  })

  it('an abort from elsewhere (the step deadline through linkAbort) is not the timer: nothing is marked, even after the timer would have run', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const timer = abortAfter(controller, 15_000, REQUEST_DEADLINE)
    controller.abort()
    vi.advanceTimersByTime(15_000)
    expect(timer.fired()).toBe(false)
    expect(stepTimeoutMarkerOf(timer.mark(platformAbort()))).toBeNull()
  })

  // #3075: a node that does not fail when its own timer fires (achieve_offers
  // records the timeout in its output and completes) has no error to mark, so
  // it asks the timer for the marker its row should carry.
  it('a timer that fired gives the marker for the row it cut short; one that did not gives none', () => {
    vi.useFakeTimers()
    const fired = abortAfter(new AbortController(), 9_000, ACHIEVE_OFFERS_DEADLINE)
    expect(fired.marker()).toBeNull()
    vi.advanceTimersByTime(9_000)
    expect(fired.marker()).toEqual({ timeout_kind: ACHIEVE_OFFERS_DEADLINE, timed_out_after_ms: 9_000 })

    const elsewhere = new AbortController()
    const notOurs = abortAfter(elsewhere, 9_000, ACHIEVE_OFFERS_DEADLINE)
    elsewhere.abort()
    vi.advanceTimersByTime(9_000)
    expect(notOurs.marker()).toBeNull()

    const cleared = abortAfter(new AbortController(), 9_000, ACHIEVE_OFFERS_DEADLINE)
    cleared.clear()
    vi.advanceTimersByTime(9_000)
    expect(cleared.marker()).toBeNull()
  })

  it('a timer cleared before it ran never fires and marks nothing', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const timer = abortAfter(controller, 15_000, REQUEST_DEADLINE)
    timer.clear()
    vi.advanceTimersByTime(60_000)
    expect(controller.signal.aborted).toBe(false)
    expect(timer.fired()).toBe(false)
    expect(stepTimeoutMarkerOf(timer.mark(new Error('fetch failed')))).toBeNull()
  })
})

describe('which deadline stopped a step, from the marker alone (#3069)', () => {
  it('names the step\'s own deadline and its parallel block\'s', () => {
    expect(deadlineKindOf({ timeout_kind: STEP_DEADLINE })).toBe(STEP_DEADLINE)
    expect(deadlineKindOf({ timeout_kind: PARALLEL_BLOCK_DEADLINE })).toBe(PARALLEL_BLOCK_DEADLINE)
  })

  // #3068: the outage check counts a run as an upstream timeout by this read, so
  // each of our other deadlines must be named by it too, not only the first two.
  // Read from the one list, so a kind added later (click_post, #3079) cannot be
  // left out here; the list itself is pinned by the test that names each kind.
  it('names every one of our deadlines, the ones #3068 added included', () => {
    expect(TIMEOUT_KINDS).toContain(CLICK_POST_DEADLINE)
    for (const kind of TIMEOUT_KINDS) {
      expect(deadlineKindOf({ timeout_kind: kind })).toBe(kind)
    }
  })

  it('reads nothing from a row with no marker, whatever its text says', () => {
    expect(deadlineKindOf({ timeout_kind: null, error_message: stepTimeoutMessage(5_250) })).toBeNull()
    expect(deadlineKindOf({ error_message: stepTimeoutMessage(5_250) })).toBeNull()
  })

  it('reads nothing from a value the engine never writes', () => {
    for (const timeout_kind of ['gateway', 'STEP', '', 1, true]) {
      expect(deadlineKindOf({ timeout_kind })).toBeNull()
    }
  })
})
