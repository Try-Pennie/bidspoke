/**
 * One live buyer_select attempt's time, split at the buyer call (#1804), and the
 * object calls inside it (#1835). Its own module so the node that writes it and
 * the Stage B report that reads it (#1909) share one definition, and the report
 * does not pull in the node and everything the node imports.
 */

/** One live attempt's time, split at the buyer call (#1804). */
export interface AttemptTiming {
  /** From the attempt's start to the request leaving: the claim and the reservation. */
  before_call_ms: number
  /** The buyer call alone, up to its answer or its throw. */
  call_ms: number
  /** From the answer to the attempt's end: the breaker record, commit, mark sold and the mirror. */
  after_call_ms: number
  /**
   * Each object call inside those phases, so the one costing the most can be named (#1804). A
   * figure is present only when the attempt reached that call, never as a zero (L90). The claim
   * includes any wait on another holder; the breaker is recording the buyer's answer; the
   * release gives back the reservation and frees the claim after a decline; the mirror is the
   * buyer_sales copy of a sale or a decline, timed even when it fails, since the lead waited for it.
   */
  claim_ms?: number
  reserve_ms?: number
  breaker_ms?: number
  commit_ms?: number
  mark_sold_ms?: number
  release_ms?: number
  mirror_ms?: number
}

/**
 * Every object call an attempt's timing names, in the order they run, so the Stage B report can
 * state each one (#1909). The check below fails to compile when a call is added to AttemptTiming
 * and not here, so the report never silently leaves one out.
 */
export const ATTEMPT_CALLS = ['claim_ms', 'reserve_ms', 'breaker_ms', 'commit_ms', 'mark_sold_ms', 'release_ms', 'mirror_ms'] as const satisfies ReadonlyArray<keyof AttemptTiming>
type AttemptCallField = Exclude<keyof AttemptTiming, 'before_call_ms' | 'call_ms' | 'after_call_ms'>
const everyCallNamed: [AttemptCallField] extends [(typeof ATTEMPT_CALLS)[number]] ? true : never = true
void everyCallNamed
