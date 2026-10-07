/**
 * One time budget for the writes a run makes after its response (#1850).
 *
 * Cloudflare cancels `ctx.waitUntil` work 30 seconds after the response is
 * sent or the client disconnects, and that 30 seconds is shared by every
 * waitUntil of the request (developers.cloudflare.com/workers/runtime-apis/context,
 * checked 2026-10-07). The execution log writes, the lead sighting writes and
 * their dead letters all run there. Their retry ladders used to be sized as if
 * waitUntil time were free: the finalize ladder spanned 112 seconds, so in a
 * real outage its later rungs and the dead letter after them were cancelled
 * before they ran, and the one record that a served lead was lost was the
 * thing that never got written.
 *
 * So every post-response write chain shares one deadline, POST_RESPONSE_BUDGET_MS
 * after the response, rather than each ladder carrying its own span:
 *
 *  - a retry ladder sleeps only when the sleep ends before its cut-off
 *    (`waitToRetry`), and otherwise gives up and reports its last error;
 *  - a chain that dead-letters on failure stops WAITING at its cut-off
 *    (`withinBudget`), so a request that never answers cannot hold the dead
 *    letter past the platform's limit. The request is not cancelled: a write
 *    that timed out may still land, so it is reported as unconfirmed, never
 *    undone;
 *  - the cut-off is the deadline less a reserve: DEAD_LETTER_RESERVE_MS for a
 *    write whose loss is dead-lettered, FINALIZE_RESERVE_MS for the create and
 *    flush that finalize waits behind, because finalize can reconstruct a
 *    missing execution row on its own and so matters more.
 *
 * The budget starts when it is armed, at the response. Before that nothing is
 * bounded here: the time before the response is not waitUntil time.
 */

/** Cloudflare's own limit on post-response work. */
export const WAIT_UNTIL_LIMIT_MS = 30_000

/**
 * Every post-response write chain, its dead letter included, finishes within
 * this many milliseconds of the response. Five seconds under the platform limit:
 * the response leaves a moment after the engine returns, a client that
 * disconnected early starts the platform's clock sooner, and the Slack alert a
 * dead letter sends needs a moment of its own.
 */
export const POST_RESPONSE_BUDGET_MS = 25_000

/**
 * The tail of the budget no write retry may run into. It is kept for the dead
 * letter: two KV reads and a KV write that count the loss (the durable record),
 * then the Slack connection read (two short retries, 550 ms of waiting) and the
 * alert.
 */
export const DEAD_LETTER_RESERVE_MS = 3_000

/**
 * The tail the execution record create and the step log flush leave for
 * finalize. Finalize reconstructs a missing execution row by itself, so its
 * attempts are worth more than the create's last ones. Includes the dead
 * letter reserve, which finalize keeps for its own dead letter.
 */
export const FINALIZE_RESERVE_MS = 10_000

/**
 * Time, for the retry ladders. Injected so a test drives it instead of waiting
 * (LESSONS L524); production uses `realClock`.
 */
export interface RetryClock {
  now(): number
  /** A wait a retry ladder chose to make: resolves after `ms`. */
  sleep(ms: number): Promise<void>
  /**
   * A watch on a deadline: resolves after `ms`, or at once when `signal`
   * aborts, so the timer never outlives the work it watched. Kept apart from
   * `sleep` so a test can tell the delays a ladder asked for from the watch.
   */
  timer(ms: number, signal: AbortSignal): Promise<void>
}

export const realClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  timer: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const onAbort = () => {
        clearTimeout(handle)
        resolve()
      }
      const handle = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    }),
}

/** The shared deadline of one run's post-response work. */
export class PostResponseBudget {
  private deadline: number | null = null
  private markArmed!: () => void
  /** Settles when the response has gone out and the budget is running. */
  readonly armed: Promise<void> = new Promise<void>((resolve) => {
    this.markArmed = resolve
  })

  constructor(
    readonly clock: RetryClock = realClock,
    readonly budgetMs: number = POST_RESPONSE_BUDGET_MS,
  ) {}

  /** The response has gone out. The first call starts the budget; later calls do nothing. */
  arm(): void {
    if (this.deadline !== null) return
    this.deadline = this.clock.now() + this.budgetMs
    this.markArmed()
  }

  /** When the budget ends, on the clock's own scale; null until armed. */
  get deadlineAt(): number | null {
    return this.deadline
  }

  /**
   * Milliseconds until the cut-off `reserveMs` ahead of the deadline: negative
   * once it has passed, infinite before the response.
   */
  msUntilCutoff(reserveMs = 0): number {
    if (this.deadline === null) return Number.POSITIVE_INFINITY
    return this.deadline - reserveMs - this.clock.now()
  }
}

/**
 * What a retry ladder needs to fit the budget. Every field is optional, and an
 * empty one behaves exactly as before #1850: real time, no deadline.
 */
export interface RetryTiming {
  clock?: RetryClock
  budget?: PostResponseBudget
  /** The tail ahead of the deadline this chain must leave free. */
  reserveMs?: number
}

/** The same deadline with a different reserve, for one stage of a chain. */
export function withReserve(timing: RetryTiming | undefined, reserveMs: number): RetryTiming | undefined {
  return timing ? { ...timing, reserveMs } : undefined
}

/**
 * Waits `delayMs` before a ladder's next attempt. Answers false, so the ladder
 * gives up, when the wait would end past the cut-off (it does not sleep then),
 * or when a wait that began before the response ended past it.
 */
export async function waitToRetry(delayMs: number, timing?: RetryTiming): Promise<boolean> {
  const clock = timing?.clock ?? realClock
  const budget = timing?.budget
  const reserve = timing?.reserveMs ?? 0
  if (budget && budget.msUntilCutoff(reserve) < delayMs) return false
  await clock.sleep(delayMs)
  if (budget && budget.msUntilCutoff(reserve) < 0) return false
  return true
}

export type BudgetOutcome<T> = { settled: true; value: T } | { settled: false }

/**
 * Waits for `work` until the cut-off and no longer. `settled: false` means the
 * work had not answered by then: it is not cancelled, and a write in it may
 * still land, so the caller reports the outcome as unconfirmed. A rejection is
 * passed through unchanged. Without a budget this simply awaits the work.
 */
export async function withinBudget<T>(work: Promise<T>, timing?: RetryTiming): Promise<BudgetOutcome<T>> {
  const budget = timing?.budget
  if (!budget) return { settled: true, value: await work }
  const clock = timing?.clock ?? realClock
  const reserve = timing?.reserveMs ?? 0
  const stop = new AbortController()
  const expired = budget.armed.then(async () => {
    const wait = budget.msUntilCutoff(reserve)
    if (wait > 0) await clock.timer(wait, stop.signal)
    return { settled: false } as const
  })
  try {
    return await Promise.race([work.then((value) => ({ settled: true, value }) as const), expired])
  } finally {
    // The timer must not outlive the work it was racing.
    stop.abort()
  }
}
