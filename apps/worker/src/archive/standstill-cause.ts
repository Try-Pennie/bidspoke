/**
 * WHY the archive is standing still, drawn from what its recent runs actually
 * did (#1028).
 *
 * `stalled` covers at least four different situations and used to carry one
 * message and one remedy for all of them: "Check Snowflake availability and the
 * export credentials." On 2026-08-23 that fired while Snowflake was fine, the
 * credentials were fine, and nothing was down: every run was being skipped on a
 * lock held by the archive's own repair. Every sentence of the advice pointed
 * away from the cause, and following it would have found nothing wrong in three
 * separate places, which is the state that teaches somebody to stop reading
 * these (L11, L36, L111).
 *
 * A message may claim only what its check measured, so the cause is READ from
 * the run records rather than assumed. `job_runs` carries an outcome per run,
 * which is exactly the evidence needed and was previously written and never
 * read for this (L46).
 */

export interface RecentRun {
  outcome: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Hours the run archived, when it recorded a summary. */
  hoursArchived?: number | null
}

export type StandstillCause =
  /** Every recent run declined because something else held the lock. */
  | { kind: 'skipped-locked'; runs: number; advice: string }
  /** Recent runs are failing, which is the only case the old advice fitted. */
  | { kind: 'runs-failing'; runs: number; outcomes: string[]; advice: string }
  /** Runs complete cleanly and archive nothing. The original #946 shape. */
  | { kind: 'archiving-nothing'; runs: number; advice: string }
  /** Runs start and never finish, so the platform is killing them. */
  | { kind: 'runs-killed'; runs: number; advice: string }
  /**
   * No run records at all in the window.
   *
   * Its own statement, never folded into the others: "the archive is stuck for
   * a reason we can name" and "we have no idea what the archive has been doing"
   * ask for completely different first moves.
   */
  | { kind: 'no-recent-runs'; advice: string }

/** Outcomes the archive writes when it declined because the lock was held. */
const SKIPPED_OUTCOMES = new Set(['skipped-locked'])

/** Outcomes that mean the run itself went wrong. */
const FAILURE_OUTCOMES = new Set(['read-failed', 'send-failed', 'misconfigured', 'threw', 'failed'])

/**
 * Reads the cause off the recent runs, newest first.
 *
 * The order of the tests is the order of certainty, not preference: a killed
 * run is evidence about the platform whatever else is true, a failing run names
 * itself, and "archiving nothing" is what is left once the runs are healthy.
 */
export function standstillCause(runs: RecentRun[]): StandstillCause {
  if (runs.length === 0) {
    return {
      kind: 'no-recent-runs',
      advice:
        'Nothing has recorded a run in this window at all, so the archive may not be firing rather than ' +
        'being stuck. Check the cron trigger events for bidspoke-worker before looking at the archive ' +
        'itself.',
    }
  }

  const killed = runs.filter((r) => r.startedAt !== null && r.finishedAt === null)
  if (killed.length === runs.length) {
    return {
      kind: 'runs-killed',
      runs: killed.length,
      advice:
        'Every recent run started and never recorded an ending, so the platform is terminating them part ' +
        'way through. Read the invocation statuses under Metrics for bidspoke-worker, which name the ' +
        'termination. Snowflake and the credentials are not implicated by this.',
    }
  }

  const settled = runs.filter((r) => r.finishedAt !== null)

  const skipped = settled.filter((r) => r.outcome !== null && SKIPPED_OUTCOMES.has(r.outcome))
  if (settled.length > 0 && skipped.length === settled.length) {
    return {
      kind: 'skipped-locked',
      runs: skipped.length,
      advice:
        'Every recent run declined because the archive lock was already held, so nothing is wrong with ' +
        'Snowflake or the credentials. Find what is holding the lock: a hand run re-archive takes the ' +
        'same one. Read the execution-archive:run-lock key and the [execution-archive] logs.',
    }
  }

  const failing = settled.filter((r) => r.outcome !== null && FAILURE_OUTCOMES.has(r.outcome))
  if (failing.length > 0) {
    return {
      kind: 'runs-failing',
      runs: failing.length,
      // The distinct outcomes, so the message quotes what was measured rather
      // than naming a cause on its behalf.
      outcomes: [...new Set(failing.map((r) => r.outcome as string))],
      advice:
        'Recent runs are failing. The outcome above says which half: a read failure points at Postgres ' +
        'and the query it timed out on, a send failure at Snowflake and its credentials, and ' +
        'misconfigured at a secret that is not set.',
    }
  }

  return {
    kind: 'archiving-nothing',
    runs: settled.length,
    advice:
      'Recent runs are completing cleanly and archiving no hours, which is the case where every signal ' +
      'reads healthy. Check whether the watermark can reach a settled hour at all, and read the ' +
      '[execution-archive] logs for what the run believed was next.',
  }
}
