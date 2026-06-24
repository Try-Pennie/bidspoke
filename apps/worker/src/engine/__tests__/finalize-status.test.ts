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
  const ok = { hasContinuationError: false, hasFlushError: false, neverAdvanced: false }

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
    expect(resolveContinuationStatus('completed', { hasContinuationError: true, hasFlushError: true, neverAdvanced: false })).toBe('failed')
  })

  it('passes a pre-response failed run straight through', () => {
    expect(resolveContinuationStatus('failed', { ...ok, hasContinuationError: true })).toBe('failed')
  })
})
