// Final execution-status resolution for the post-walk finalize handler (#310).
//
// Execution `status` means "was the lead served correctly", NOT "did every
// post-response side-effect succeed". A run that delivered a correct response but
// whose post-response continuation (the Salesforce writeback after the Offer
// Response) later failed is 'degraded' — served, but a side-effect didn't land.
// It is visible (not silently 'completed') yet does not hard-page as 'failed';
// the failure is surfaced via a rate-aggregated dead-letter alert instead.
//
// The genuine backstops stay 'failed' — they mean the lead was NOT served right:
//   - flush error: the step-log rows were rejected by Postgres (data loss).
//   - never advanced: no node recorded a successful output past the trigger.
// A flush/never-advanced condition outranks a continuation error.
//
// A flush that only TIMED OUT is not a flush error (#1881, part of #688): the
// database answered too slowly to confirm the step rows inside the post-response
// budget, which says nothing about whether they landed (on 2026-10-08 all 273 of
// them had). The lead was answered, so the run is 'degraded', it pages nobody per
// run, and the minute sweep reads the rows back. A flush that RETURNED an error
// is still 'failed'.

export interface ContinuationFlags {
  hasContinuationError: boolean
  hasFlushError: boolean
  /** The step flush timed out at the budget; nothing came back either way. */
  hasFlushUnconfirmed: boolean
  neverAdvanced: boolean
  /**
   * The base execution row was missing and was reconstructed at finalize (#688).
   * The lead was served, but the primary write path DID fail, so the run is
   * degraded rather than a clean completed. This is the floor for a reconstructed
   * run: a genuine step-persist failure (the recovery re-flush itself failed) is
   * reported through `hasFlushError` and OUTRANKS this, so such a run is still
   * failed. Set from "the row was reconstructed" alone; the re-flush outcome is
   * carried by `hasFlushError`/`hasFlushUnconfirmed`. Defaults false.
   */
  wasReconstructed?: boolean
}

export function resolveContinuationStatus(executionStatus: string, flags: ContinuationFlags): string {
  if (executionStatus !== 'completed') return executionStatus
  if (flags.hasFlushError) return 'failed'
  if (flags.neverAdvanced) return 'failed'
  if (flags.wasReconstructed) return 'degraded'
  if (flags.hasContinuationError) return 'degraded'
  if (flags.hasFlushUnconfirmed) return 'degraded'
  return 'completed'
}
