/**
 * A clock for the post-response budget tests (#1850): time only moves when the
 * test drives it, so a ladder that would wait 20 seconds in production runs in
 * microseconds here, and every wait the code asked for is recorded.
 *
 * `sleep` is what a retry ladder calls, so `sleeps` is the list of delays it
 * requested. `timer` is a deadline watch, and `delay` is for a test double that
 * stands for a slow request: both move time the same way but are NOT recorded
 * as requested waits.
 */
import type { RetryClock } from '../post-response-budget'

interface Timer {
  at: number
  seq: number
  resolve: () => void
}

export class VirtualClock implements RetryClock {
  private t = 0
  private seq = 0
  private timers: Timer[] = []
  /** Every delay a caller asked `sleep` for, in the order asked. */
  readonly sleeps: number[] = []

  now(): number {
    return this.t
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    return this.schedule(ms)
  }

  /** A deadline watch: not a requested wait, so not in `sleeps`. */
  timer(ms: number, signal: AbortSignal): Promise<void> {
    return this.schedule(ms, signal)
  }

  /** A slow request: time passes, but nobody asked to wait. */
  delay(ms: number): Promise<void> {
    return this.schedule(ms)
  }

  /** A request that never answers. */
  hang(): Promise<never> {
    return new Promise<never>(() => {})
  }

  private schedule(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve }
      this.timers.push(timer)
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((x) => x !== timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  /**
   * Fires timers in time order, letting every promise chain settle between
   * them, up to `untilMs`, and returns the time it stopped at. Given a finite
   * `untilMs`, the clock ends there even when nothing was waiting (#2470): a
   * test that runs to 1 s before starting work means the work starts at 1 s, and
   * every mark it then counts from that start lands where the test says.
   */
  async run(untilMs = Number.POSITIVE_INFINITY): Promise<number> {
    for (let guard = 0; guard < 100_000; guard++) {
      await settle()
      if (this.timers.length === 0) {
        if (Number.isFinite(untilMs) && untilMs > this.t) this.t = untilMs
        return this.t
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.timers[0]
      if (next.at > untilMs) {
        this.t = untilMs
        return this.t
      }
      this.timers.shift()
      this.t = next.at
      next.resolve()
    }
    throw new Error('VirtualClock.run: timers kept rescheduling themselves')
  }
}

/** Lets every queued promise reaction run, across several macrotask turns. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}
