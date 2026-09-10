/**
 * Which alerts a finished archive run should raise (#871, Phase A3).
 *
 * Two rules shape this, and both come from defects the plan's own audit found.
 *
 * ONE NAME PER INDEPENDENT CONDITION. `notifyExportFailure` keys both its grace
 * marker and its cooldown on the job name, so a single name would let every
 * archiver condition share one status field: a per-execution refusal paging
 * would suppress a genuine ingest outage for the next eight hours through the
 * shared backstop cooldown (L53).
 *
 * A CLEAN STOP NEVER TOUCHES THE FAILURE STATE. That function DELETES both keys
 * when called with an empty errors array, so an hourly job alternating a
 * transient failure with a clean stop would re-arm the grace every other run and
 * never reach the second consecutive failure that pages. So a healthy run
 * produces no call at all rather than a call with nothing in it.
 */
import type { RunResult } from './run-loop'
import type { AlertRemedy } from '../lib/export-alerts'

export const ARCHIVE_JOB_NAMES = {
  ingest: 'execution-archive-ingest',
  refusal: 'execution-archive-refusal',
  lag: 'execution-archive-lag',
  /**
   * A run taking over a lock its predecessor never released (#954).
   *
   * Its own name, not folded into `ingest`. The remedy is different and the
   * cooldown must be too: an ingest failure clears by the next successful run,
   * while a killed run is a statement about an invocation that is already over
   * and whose hours are simply unarchived until the loop reaches them again.
   */
  killed: 'execution-archive-killed',
} as const

/**
 * Hours behind at which the lag becomes an alert.
 *
 * Above the settle window, which is a permanent offset by design: the archive is
 * always at least two hours behind, so a threshold at or below that would fire
 * forever on a healthy system. Six hours means a run has failed to catch up
 * across several cadences before anyone is told, which is the point at which it
 * is a trend rather than one slow run.
 */
export const LAG_ALERT_HOURS = 6

/**
 * The wording each condition carries (2026-09-10).
 *
 * Held BESIDE the condition that raises it rather than chosen at the call site,
 * because one call site forwards three different job names and picking the
 * wording there would be a second place the mapping has to stay in step (L70).
 * None of these is an export: nothing here is sent to Snowflake by the run being
 * described, so none of them may borrow the export alerter's default sentences.
 */
export const ARCHIVE_INGEST_REMEDY: AlertRemedy = {
  consequence:
    'The archive run stopped before it finished. The hours it did not reach have no backup yet and are ' +
    'archived when the loop returns to them, which is a problem only if their Postgres partition is ' +
    'purged first. The stop reason is below:',
  fixHint:
    'Read the stop reason and the [execution-archive] worker logs for that run. If a whole day is at ' +
    'risk of being purged before it is archived, re-archive it with POST /api/admin/re-archive and a ' +
    'day of YYYY-MM-DD.',
}

export const ARCHIVE_MISCONFIGURED_REMEDY: AlertRemedy = {
  consequence:
    'The archive refused to run at all because a secret it needs is not set. It is not writing incomplete ' +
    'rows, which is the safe choice, but no hour is being archived while this stands:',
  fixHint:
    'Set the named secret with wrangler secret put <NAME> --name bidspoke-worker. The next hourly run ' +
    'picks it up on its own and the skipped hours are archived when the loop reaches them.',
  headlineVerb: 'cannot run',
  itemNoun: { one: 'reason', many: 'reasons' },
}

export const ARCHIVE_REFUSAL_REMEDY: AlertRemedy = {
  consequence:
    'The archive read these executions and refused to write them, so they have no copy anywhere while ' +
    'their Postgres partition is still deleted on the retention schedule. Refusing everything means a ' +
    'systemic cause rather than one bad row:',
  fixHint:
    'Read the reasons in the execution_archive_refusals table for this run, resolve the cause, then ' +
    're-archive the affected hours with POST /api/admin/re-archive.',
  headlineVerb: 'refused executions',
  itemNoun: { one: 'refusal', many: 'refusals' },
}

export const ARCHIVE_LAG_REMEDY: AlertRemedy = {
  consequence:
    'Every run is reporting success and the archive is still falling behind its own cadence. Nothing is ' +
    'lost yet. While it trails, the deletion gate cannot clear those days:',
  fixHint:
    'This is throughput, not a failure. Compare the per run hour cap, the subrequest budget and the wall ' +
    'time budget against the subrequests and stop reason in the [execution-archive] logs, and catch up a ' +
    'day at a time with POST /api/admin/re-archive if the gap is not closing.',
  headlineVerb: 'is behind',
  itemNoun: { one: 'reading', many: 'readings' },
}

export const ARCHIVE_KILLED_REMEDY: AlertRemedy = {
  consequence:
    'This run found a lock its predecessor never released and took it over, so the previous invocation ' +
    'was killed part way through. This run is proceeding normally. The work the killed one did not ' +
    'finish is simply unarchived and is picked up when the loop returns to it:',
  fixHint:
    'One occurrence needs nothing. If this repeats, read the cron trigger events and invocation metrics ' +
    'for bidspoke-worker in the Cloudflare dashboard to see what is killing the run.',
  headlineVerb: 'took over a killed run',
  itemNoun: { one: 'takeover', many: 'takeovers' },
}

export interface ArchiveAlert {
  jobName: string
  errors: string[]
  /** Carried with the condition, so the call site cannot pair them wrongly. */
  remedy: AlertRemedy
}

export function alertsFor(result: RunResult): ArchiveAlert[] {
  const alerts: ArchiveAlert[] = []

  if (result.failed) {
    alerts.push({
      jobName: ARCHIVE_JOB_NAMES.ingest,
      errors: [`archive run stopped on ${result.stop}: ${result.detail}`],
      remedy: ARCHIVE_INGEST_REMEDY,
    })
  }

  if (result.executionsRefused > 0) {
    // Counted against a RATE, not just reported. The code waving a survivable
    // refusal through has no notion of volume, so one benign refusal and a
    // systemic failure refusing everything otherwise arrive on the same path and
    // read identically (L77). A run that refused EVERYTHING gets its own
    // wording, because a proportion cannot distinguish one bad out of two from
    // all bad out of all (L139).
    const seen = result.executionsArchived + result.executionsRefused
    const everything = result.executionsArchived === 0
    alerts.push({
      jobName: ARCHIVE_JOB_NAMES.refusal,
      errors: [
        everything
          ? `archive refused every one of the ${result.executionsRefused} executions it read, so nothing was backed up this run`
          : `archive refused ${result.executionsRefused} of ${seen} executions, which have no backup until the refusal is resolved`,
      ],
      remedy: ARCHIVE_REFUSAL_REMEDY,
    })
  }

  if (result.hoursBehind > LAG_ALERT_HOURS) {
    // Every clean stop is honestly successful, so without this the archive can
    // fall permanently behind while every run reports success (L13).
    alerts.push({
      jobName: ARCHIVE_JOB_NAMES.lag,
      errors: [
        `archive is ${result.hoursBehind} hours behind after stopping on ${result.stop}, ` +
          `past the ${LAG_ALERT_HOURS} hour threshold, so it is not keeping up with its own cadence`,
      ],
      remedy: ARCHIVE_LAG_REMEDY,
    })
  }

  return alerts
}
