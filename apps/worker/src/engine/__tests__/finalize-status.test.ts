/**
 * #310 / #309 Phase 5: a lead served a correct response whose POST-response
 * continuation (e.g. the Salesforce writeback) later fails is 'degraded', not
 * 'failed' — the lead was served; only a side-effect didn't land. The genuine
 * backstops (step logs didn't persist; never advanced past the trigger) mean the
 * lead was NOT served correctly and stay 'failed'.
 */
import { describe, it, expect } from 'vitest'
import { resolveContinuationStatus } from '../finalize-status'

describe('resolveContinuationStatus (#310)', () => {
  const ok = { hasContinuationError: false, hasFlushError: false, hasFlushUnconfirmed: false, neverAdvanced: false }

  it('keeps a clean completed run completed', () => {
    expect(resolveContinuationStatus('completed', ok)).toBe('completed')
  })

  it('degrades (not fails) a served lead whose post-response continuation threw', () => {
    expect(resolveContinuationStatus('completed', { ...ok, hasContinuationError: true })).toBe('degraded')
  })

  it('fails when step logs did not persist (lead not served correctly)', () => {
    expect(resolveContinuationStatus('completed', { ...ok, hasFlushError: true })).toBe('failed')
  })

  it('fails when the run never advanced past the trigger', () => {
    expect(resolveContinuationStatus('completed', { ...ok, neverAdvanced: true })).toBe('failed')
  })

  it('a flush error outranks a continuation error (more severe wins → failed)', () => {
    expect(resolveContinuationStatus('completed', { hasContinuationError: true, hasFlushError: true, hasFlushUnconfirmed: false, neverAdvanced: false })).toBe('failed')
  })

  // #1881: a flush that only timed out (the database answered too slowly) is not
  // a lost record. The lead was answered, so the run is degraded and does not page
  // per run; the minute sweep reads the step rows back. Part of #688.
  it('degrades, not fails, a served lead whose step records were only unconfirmed', () => {
    expect(resolveContinuationStatus('completed', { ...ok, hasFlushUnconfirmed: true })).toBe('degraded')
  })

  it('a returned flush error still outranks an unconfirmed one', () => {
    expect(resolveContinuationStatus('completed', { ...ok, hasFlushError: true, hasFlushUnconfirmed: true })).toBe('failed')
  })

  it('a run that never advanced stays failed even when its flush was only unconfirmed', () => {
    expect(resolveContinuationStatus('completed', { ...ok, neverAdvanced: true, hasFlushUnconfirmed: true })).toBe('failed')
  })

  it('passes a pre-response failed run straight through', () => {
    expect(resolveContinuationStatus('failed', { ...ok, hasContinuationError: true })).toBe('failed')
  })

  // #688: a run whose base row was missing and was reconstructed at finalize, with
  // its step logs re-flushed successfully, was SERVED and fully recovered. It is
  // degraded (the primary write path did fail), not a hard failure.
  it('degrades a served lead whose record was reconstructed and recovered', () => {
    expect(resolveContinuationStatus('completed', { ...ok, wasReconstructed: true })).toBe('degraded')
  })

  it('still fails a reconstructed run whose re-flush genuinely failed (flush error outranks)', () => {
    expect(resolveContinuationStatus('completed', { ...ok, wasReconstructed: true, hasFlushError: true })).toBe('failed')
  })

  it('still fails a reconstructed run that never advanced past the trigger', () => {
    expect(resolveContinuationStatus('completed', { ...ok, wasReconstructed: true, neverAdvanced: true })).toBe('failed')
  })
})
