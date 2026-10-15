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

/**
 * When a still running tick logs the jobs it is waiting on. A tick killed at
 * its limit never reaches the end of tick line, so this is the one that names
 * the job in that case. Well past the usual 15 s and the 20 s line.
 */
export const TICK_CHECKPOINT_MS = 60_000

export interface CheckpointSeams {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  log: (line: string) => void
}

interface Timed { name: string; ms: number | null; failed: boolean; timedOut: boolean; startedAt: number }

export function tickTimer(now: () => number = Date.now) {
  const started = now()
  const jobs: Timed[] = []
  return {
    /** Times `work` and hands its outcome on unchanged. */
    track<T>(name: string, work: Promise<T>): Promise<T> {
      const job: Timed = { name, ms: null, failed: false, timedOut: false, startedAt: now() }
      jobs.push(job)
      return work.then(
        (v) => { job.ms = now() - job.startedAt; return v },
        (e: unknown) => { job.ms = now() - job.startedAt; job.failed = true; throw e },
      )
    },
    /**
     * Marks a job the minute stopped waiting for at its deadline (#2058), so
     * the line says the deadline cut it off rather than that it was unfinished.
     */
    timedOut(name: string): void {
      for (const j of jobs) if (j.name === name && j.ms === null) j.timedOut = true
    },
    /** One line when the tick ran past `slowMs`, otherwise null. */
    report(cron: string, slowMs: number = TICK_SLOW_MS): string | null {
      const at = now()
      const total = at - started
      // A tick that timed no job has nothing to name.
      if (jobs.length === 0 || total <= slowMs) return null
      // A job still running is named with its time so far, never left out:
      // the one that has not finished is the likeliest to be the slow one.
      const list = jobs
        .map((j) => ({ ...j, shown: j.ms ?? at - j.startedAt }))
        .sort((a, b) => b.shown - a.shown)
        .map((j) => `${j.name}:${j.shown}${j.ms === null ? (j.timedOut ? ' timed out' : ' unfinished') : j.failed ? ' failed' : ''}`)
      return `[tick-timing] cron="${cron}" total_ms=${total} jobs=${list.join(',')}`
    },
    /** Logs the report once at TICK_CHECKPOINT_MS if the tick is still running; returns the stop. */
    checkpoint(cron: string, seams: CheckpointSeams): () => void {
      const handle = seams.setTimer(() => {
        const line = this.report(cron)
        if (line) seams.log(`${line} (checkpoint, still running)`)
      }, TICK_CHECKPOINT_MS)
      return () => seams.clearTimer(handle)
    },
  }
}

export type TickTimer = ReturnType<typeof tickTimer>
