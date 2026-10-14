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
 * A CLEAN STOP REPORTS ITS RECOVERY, IT DOES NOT ERASE THE FAILURE. A clean run
 * clears the standing condition (stopping the reminders) but KEEPS the grace
 * marker, stamped as interrupted, so an hourly job alternating a transient
 * failure with a clean stop still reaches the failure that pages (#1441, #1445;
 * before #1445 an empty errors array deleted the grace marker and that
 * alternating pattern never paged). This runner reports its recovery through the
 * recovery entry point rather than an empty failure call, because it computes
 * its failures and its recoveries from different predicates.
 */
import type { RunResult, RunStop } from './run-loop'
import type { TitledRemedy } from '../lib/export-alerts'

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
  /**
   * The archive refusing to run because a required secret is unset (#1259).
   *
   * Its own name, not folded into `ingest`. It is a different condition from a
   * run that stopped partway, and `notifyExportFailure` keys its grace marker
   * and backstop cooldown on the job name, so sharing `ingest` let whichever
   * fired first silence the other for eight hours (L53). The remedy also differs:
   * it names the missing setting rather than a stop reason, and for a recovery
   * secret it says to restore the escrowed value, never to make a new one (#835).
   */
  misconfigured: 'execution-archive-misconfigured',
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
 * The wording each condition carries.
 *
 * Titled (#1300, Dan, 2026-09-10: "They're not easy to read"): a plain title in
 * place of the job name, then the findings, one line saying what is at risk, and
 * a fix line only where there is something to do. Mechanism is left out; the
 * stop reason the run classified is in the findings for whoever wants it.
 *
 * Held BESIDE the condition that raises it rather than chosen at the call site,
 * because one call site forwards three different job names and picking the
 * wording there would be a second place the mapping has to stay in step (L70).
 * None of these is an export, so none may borrow the export alerter's sentences.
 */
export const ARCHIVE_INGEST_REMEDY: TitledRemedy = {
  title: 'The hourly backup stopped before it finished',
  context:
    'Nothing is lost: the hours it did not reach are backed up on a later run. They are at risk only if they ' +
    'come up for deletion first, which has its own alert.',
  fixHint:
    'Read the stop reason above. Nothing to do unless this repeats. If a whole day could be deleted before ' +
    'it is backed up, back it up with POST /api/admin/re-archive and its day as YYYY-MM-DD.',
}

/**
 * Where a read failure actually points (#1042): Postgres, not Snowflake. On
 * 2026-08-24 the cause was a statement timeout on our own unindexed count.
 */
export const ARCHIVE_READ_FAILED_REMEDY: TitledRemedy = {
  title: 'The hourly backup could not read the run history',
  context:
    'It stopped before sending anything. Nothing is lost; the hours it did not reach are backed up on a later run.',
  fixHint:
    'The failure above names the query, which is in our database, not Snowflake. A timeout on a count usually ' +
    'means a day without the index the backup reads by.',
}

/** Where a send failure points, which is the one case Snowflake belongs in. */
export const ARCHIVE_SEND_FAILED_REMEDY: TitledRemedy = {
  title: 'The hourly backup could not reach Snowflake',
  context:
    'Those hours are not backed up yet and are tried again on the next run. While it stands, their history is ' +
    'kept rather than deleted on schedule, so the database grows until a run succeeds.',
  fixHint:
    'Check Snowflake availability and the backup writer credentials. If the sends are timing out, ' +
    'docs/snowflake-slow-write.md finds where the time went, read only.',
}

/**
 * The remedy for a failed run, chosen from the stop reason the run already
 * classified (#1042), so a wrong cause never costs a diagnosis (L11, L111).
 */
export function ingestRemedyFor(stop: RunStop, detail = ''): TitledRemedy {
  if (stop === 'read-failed') return ARCHIVE_READ_FAILED_REMEDY
  if (stop === 'send-failed') return ARCHIVE_SEND_FAILED_REMEDY
  // Chosen from the setting the run reported missing, never assumed (#835).
  if (stop === 'misconfigured') return detail.includes('SSN_HASH_PEPPER') ? ARCHIVE_PEPPER_MISSING_REMEDY : ARCHIVE_MISCONFIGURED_REMEDY
  // Everything else stopped for a budget reason rather than a fault, so the
  // generic wording is the honest one: it says to read the stop reason.
  return ARCHIVE_INGEST_REMEDY
}

export const ARCHIVE_MISCONFIGURED_REMEDY: TitledRemedy = {
  title: 'The hourly backup cannot run: a setting is missing',
  context: 'No hour is being backed up while this stands. It is not writing incomplete records, which is the safe choice.',
  fixHint:
    'Set the setting the line names with wrangler secret put <NAME> --name bidspoke-worker, piping the value in. ' +
    'If it is a recovery secret, restore it from the 1Password item "Bidspoke recovery keys", never a new value. ' +
    'The next hourly run picks it up and the skipped hours are backed up on later runs.',
}

// SSN_HASH_PEPPER cannot be re-derived: a NEW value leaves every record already
// archived unfindable by SSN for an erasure request (#835). So when the run
// reports it missing, the fix restores the escrowed value and says never to
// make one.
export const ARCHIVE_PEPPER_MISSING_REMEDY: TitledRemedy = {
  title: ARCHIVE_MISCONFIGURED_REMEDY.title,
  context: ARCHIVE_MISCONFIGURED_REMEDY.context,
  fixHint:
    'Restore SSN_HASH_PEPPER from the 1Password item "Bidspoke recovery keys" with wrangler secret put ' +
    'SSN_HASH_PEPPER --name bidspoke-worker, piping the value in. Never a new value: a new one leaves every ' +
    'record already backed up unfindable by SSN. The next hourly run picks it up and the skipped hours are ' +
    'backed up on later runs.',
}

export const ARCHIVE_REFUSAL_REMEDY: TitledRemedy = {
  title: 'The hourly backup refused some executions',
  context:
    'Refused executions have no backup anywhere, and their history is still deleted on the usual schedule. ' +
    'Refusing every execution points at one shared cause rather than one bad record.',
  fixHint:
    'Read the reasons in the execution_archive_refusals table for this run, fix the cause, then back the ' +
    'affected hours up again with POST /api/admin/re-archive.',
}

export const ARCHIVE_LAG_REMEDY: TitledRemedy = {
  title: 'The hourly backup is falling behind',
  context:
    'Every run reports success, but the backup is not keeping up. Nothing is lost yet; until it catches up, ' +
    'those days are kept rather than deleted.',
  fixHint:
    'This is throughput, not a failure. If the gap is not closing, catch up a day at a time with POST ' +
    '/api/admin/re-archive, then compare the per run hour cap and time budget with the [execution-archive] logs.',
}

export const ARCHIVE_KILLED_REMEDY: TitledRemedy = {
  title: 'The hourly backup cleaned up after a stopped run',
  context:
    'The previous run stopped part way through. If a "started and never finished" alert for the backup came ' +
    'before this, it is the same event. This run is going ahead normally. Nothing is lost: the hours the ' +
    'stopped run did not reach are backed up on a later run.',
  fixHint:
    'Nothing to do unless this repeats. If it does, read the stopped runs\' outcomes for bidspoke-worker in ' +
    'the Cloudflare dashboard to see what is stopping them.',
}

/** Each stop reason as a reader says it (#1300); every value of RunStop is named, so a new one fails to compile. */
const STOP_IN_WORDS: Record<RunStop, string> = {
  'caught-up': 'it had caught up',
  'wall-time': 'it used up its time for this run',
  subrequests: 'it used up its outside calls for this run',
  'max-hours': 'it reached the most hours one run may back up',
  'read-failed': 'it could not read the run history',
  'send-failed': 'it could not send to Snowflake',
  misconfigured: 'a setting it needs is missing',
}

export interface ArchiveAlert {
  jobName: string
  errors: string[]
  /** Carried with the condition, so the call site cannot pair them wrongly. */
  remedy: TitledRemedy
}

export function alertsFor(result: RunResult): ArchiveAlert[] {
  const alerts: ArchiveAlert[] = []

  if (result.failed) {
    // The misconfigured exit is its own condition with its own cooldown (#1259),
    // so it never shares a status field with a run that stopped partway.
    alerts.push({
      jobName: result.stop === 'misconfigured' ? ARCHIVE_JOB_NAMES.misconfigured : ARCHIVE_JOB_NAMES.ingest,
      errors: [`Stopped because ${STOP_IN_WORDS[result.stop]}: ${result.detail}`],
      remedy: ingestRemedyFor(result.stop, result.detail),
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
          ? `Refused every one of the ${result.executionsRefused} executions it read, so nothing was backed up this run.`
          : `Refused ${result.executionsRefused} of ${seen} executions, which have no backup until the cause is fixed.`,
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
        `${result.hoursBehind} hours behind, past the ${LAG_ALERT_HOURS} hour line. ` +
          `The last run stopped because ${STOP_IN_WORDS[result.stop]}.`,
      ],
      remedy: ARCHIVE_LAG_REMEDY,
    })
  }

  return alerts
}

/**
 * Which conditions this run shows to be CLEAR, so the reminders for them stop
 * (#1441).
 *
 * The counterpart of `alertsFor`, and deliberately in the same file: the two
 * decide the same conditions from the same result, and split across files they
 * would drift into a run that both raises and clears one.
 *
 * A FAILED RUN CLEARS NOTHING. Its other numbers look healthy without having
 * been measured: the misconfigured exit returns an empty result whose
 * `hoursBehind` and refusal count are both zero, and treating those as evidence
 * would report two conditions clear on a run that never looked at either (L98).
 *
 * The killed condition is not cleared here, because this runs on the END-of-run
 * `RunResult`, which is not evidence about a killed predecessor: a run's own
 * healthy numbers say nothing about whether it took over a dead one. The killed
 * condition is cleared at LOCK ACQUISITION instead (execution-archive.ts), where
 * a clean take IS the evidence that no predecessor was killed this cycle, so a
 * later kill posts as a fresh incident rather than a stale "(still)" (#1784).
 */
export function clearedConditionsFor(result: RunResult): string[] {
  if (result.failed) return []
  // A run that reached the end is the evidence that both the ingest condition and
  // the misconfigured one (#1259) have cleared: it ran, so no required secret is
  // missing. Clear both, or the misconfigured reminder would page forever once it
  // has its own name.
  const cleared: string[] = [ARCHIVE_JOB_NAMES.ingest, ARCHIVE_JOB_NAMES.misconfigured]
  if (result.executionsRefused === 0) cleared.push(ARCHIVE_JOB_NAMES.refusal)
  if (result.hoursBehind <= LAG_ALERT_HOURS) cleared.push(ARCHIVE_JOB_NAMES.lag)
  return cleared
}
