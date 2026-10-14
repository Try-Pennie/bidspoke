/**
 * Which job held a slow tick up (#2058).
 *
 * Every minute job (prewarm, the stored copy sweep and checks, the buyer ledger
 * drain, the unconfirmed write sweep, volume cliff, the rate checks, the strand
 * drain, the heartbeat checks) runs inside the one invocation, which has taken
 * 30 s to over 5 minutes with nothing recording which job took the time. A
 * Worker invocation lets only six calls wait for headers at once, so one slow
 * dependency stretches every job in the tick.
 *
 * Each job is timed from when it is handed over to when it settles. A tick past
 * TICK_SLOW_MS logs one line naming every job, slowest first, so the next slow
 * tick says which job it was. A quiet tick logs nothing.
 */

/** The usual minute tick takes 5 to 15 s (measured 2026-10-14), so past 20 s is slow. */
export const TICK_SLOW_MS = 20_000

interface Timed { name: string; ms: number | null; failed: boolean; startedAt: number }

export function tickTimer(now: () => number = Date.now) {
  const started = now()
  const jobs: Timed[] = []
  return {
    /** Times `work` and hands its outcome on unchanged. */
    track<T>(name: string, work: Promise<T>): Promise<T> {
      const job: Timed = { name, ms: null, failed: false, startedAt: now() }
      jobs.push(job)
      return work.then(
        (v) => { job.ms = now() - job.startedAt; return v },
        (e: unknown) => { job.ms = now() - job.startedAt; job.failed = true; throw e },
      )
    },
    /** One line when the tick ran past `slowMs`, otherwise null. */
    report(cron: string, slowMs: number = TICK_SLOW_MS): string | null {
      const at = now()
      const total = at - started
      // A tick that timed no job (only the minute jobs are named) has nothing to name.
      if (jobs.length === 0 || total <= slowMs) return null
      // A job still running is named with its time so far, never left out:
      // the one that has not finished is the likeliest to be the slow one.
      const list = jobs
        .map((j) => ({ ...j, shown: j.ms ?? at - j.startedAt }))
        .sort((a, b) => b.shown - a.shown)
        .map((j) => `${j.name}:${j.shown}${j.ms === null ? ' unfinished' : j.failed ? ' failed' : ''}`)
      return `[tick-timing] cron="${cron}" total_ms=${total} jobs=${list.join(',')}`
    },
  }
}

export type TickTimer = ReturnType<typeof tickTimer>
