/** The timers a cut is made with. */
export interface CutTimers {
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: never) => void
}

/**
 * The timers as this module found them, when it was loaded and before any run
 * lifted the engine's (#3137). A run replaces the global setTimeout with one
 * that keeps every timer pending on the replay's time, and the replay moves that
 * time on by running the timer due first, early. A cut set through it was one of
 * those: due 1 s into the replay, before a 7.5 s held answer after the response,
 * so the advance ran the cut first and ended the run mid walk.
 */
const BEFORE_ANY_LIFT: CutTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis) as CutTimers['setTimeout'],
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
}

/**
 * Wait for `work`, but at most `ms` of real time (#1851): the hung shape's
 * post-response work stuck behind the database is cut here, as the real 25 s
 * budget would cut it. The cut is real time the replay cannot move on (#3137),
 * so work waiting only on the replay's time is never cut by it. The timer is
 * cleared on every path, the rejected one included, and a rejection is passed on
 * rather than swallowed. `timers` is for a test on fake timers.
 */
export async function waitAtMost(work: Promise<unknown>, ms: number, timers: CutTimers = BEFORE_ANY_LIFT): Promise<void> {
  let cut: unknown
  try {
    await Promise.race([work, new Promise<void>((resolve) => { cut = timers.setTimeout(resolve, ms) })])
  } finally {
    if (cut !== undefined) timers.clearTimeout(cut as never)
  }
}
