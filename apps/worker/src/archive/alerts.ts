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

export const ARCHIVE_JOB_NAMES = {
  ingest: 'execution-archive-ingest',
  refusal: 'execution-archive-refusal',
  lag: 'execution-archive-lag',
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

export interface ArchiveAlert {
  jobName: string
  errors: string[]
}

export function alertsFor(result: RunResult): ArchiveAlert[] {
  const alerts: ArchiveAlert[] = []

  if (result.failed) {
    alerts.push({
      jobName: ARCHIVE_JOB_NAMES.ingest,
      errors: [`archive run stopped on ${result.stop}: ${result.detail}`],
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
    })
  }

  return alerts
}
