/**
 * Reading the execution purge jobs' retention back out of the database, daily
 * (#1017).
 *
 * The decision is in `archive/retention-drift.ts` and is pure. This is the half
 * that goes and asks, through the `execution_purge_retention` function added by
 * migration `20260903170000`, which returns only the two named purge jobs.
 *
 * WHY A RUNTIME CHECK WHEN A CI GUARD EXISTS.
 * `apps/web/src/lib/__guards__/worker/archive-retention-matches-purge.test.ts`
 * compares the code against the MIGRATIONS, so it catches a recorded change
 * before it merges. It cannot see a `cron.job` row edited directly in the
 * database, and that is not hypothetical: #1017 was written because both jobs had
 * been changed by hand. Retention is a setting whose whole effect is on what data
 * still exists, so its current value is asserted on a schedule rather than
 * audited when somebody changes it (L502).
 *
 * A FAILED READ IS ITS OWN FINDING, never silence. This check exists to say
 * whether the window is what the code believes, and an RPC that errored has not
 * measured it. Answering "no differences" there would make a broken check and a
 * healthy system the same output, which is the one thing it must not do (L98).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { RETENTION_DAYS } from '../archive/candidate-days'
import { retentionDifferences, type ObservedPurgeJob, type RetentionDifference } from '../archive/retention-drift'
import type { Env } from '../index'

/**
 * The live purge jobs' retention window disagrees with the one this repo
 * declares. Both jobs had been edited by hand in the database, where no check in
 * the repository can see them.
 *
 * This wording is true only when every difference is a window that disagrees.
 * A missing job, a disabled one or a window that could not be read gets its own
 * sentences from `retentionRemedyFor` (lessons review, #835).
 */
export const RETENTION_CHECK_REMEDY: AlertRemedy = {
  consequence:
    'The window the database purge jobs actually destroy execution data on, and the window this repo ' +
    'declares, disagree. Nothing failed and nothing is missing. What is wrong is that the deletion gate ' +
    'measures days on one window while the purge deletes on another:',
  fixHint:
    'Decide which side is right, then either re-align the scheduled purge jobs in Postgres with the ' +
    'declared value, or change the declared value in this repo and its guard test.',
  headlineVerb: 'found the purge window disagrees',
  itemNoun: { one: 'difference', many: 'differences' },
}

/** Differences that are a real disagreement between two windows that were both read. */
const DISAGREEMENTS = new Set(['retention-disagrees', 'jobs-disagree'])

/**
 * The wording for THIS run's differences, one sentence per kind present.
 *
 * The drift path carries five kinds, and one remedy said "disagree. Nothing
 * failed and nothing is missing" over a job that was missing, a job that was
 * disabled and a window nothing could read (lessons review, #835).
 */
export function retentionRemedyFor(codes: readonly string[]): AlertRemedy {
  // No difference is the clear path, which carries the declared remedy rather
  // than one built from nothing.
  if (codes.length === 0 || codes.every((c) => DISAGREEMENTS.has(c))) return RETENTION_CHECK_REMEDY
  const has = (code: string) => codes.includes(code)
  const consequences: string[] = []
  const fixes: string[] = []
  if (codes.some((c) => DISAGREEMENTS.has(c))) {
    consequences.push(
      'The deletion gate measures days on one window while a purge job deletes on another.',
    )
    fixes.push(
      'Decide which side is right, then either re-align the scheduled purge jobs in Postgres with the ' +
        'declared value, or change the declared value in this repo and its guard test.',
    )
  }
  if (has('job-missing') || has('job-inactive')) {
    consequences.push(
      'A purge job that is missing or disabled is not doing its part, so execution retention is not being ' +
        'enforced as declared.',
    )
  }
  if (has('job-missing')) {
    fixes.push(
      'Recreate the missing job from the migration that schedules it, or, if it was renamed on purpose, ' +
        'update the job names in execution_purge_retention and this check.',
    )
  }
  if (has('job-inactive')) fixes.push('Re-enable the disabled job in pg_cron (cron.alter_job with active set to true).')
  if (has('retention-unreadable')) {
    consequences.push("Where a job's window could not be read from its command, whether it matches is unknown.")
    fixes.push(
      "If a line says a job's window could not be read, the check itself needs attention rather than the " +
        'schedule: the command no longer has the shape execution_purge_retention reads, so read it in ' +
        'cron.job and either restore the call or teach the function the new shape.',
    )
  }
  return {
    // Opens with "not as declared" only when a difference was measured; a
    // window that could not be read says only that it is unknown (#835).
    consequence:
      (codes.some((c) => c !== 'retention-unreadable') ? 'The execution purge jobs are not as this repo declares. ' : '') +
      consequences.join(' ').replace(/\.$/, ':'),
    fixHint: fixes.join(' '),
    headlineVerb: 'found a problem with the purge jobs',
    itemNoun: { one: 'difference', many: 'differences' },
  }
}

/**
 * The jobs could not be read, or the check itself failed, so whether the
 * windows match is unknown (#835). It used to arrive under "disagree. Nothing
 * failed", which nothing had measured.
 */
export const RETENTION_CHECK_UNREADABLE_REMEDY: AlertRemedy = {
  consequence:
    'The execution purge jobs could not be read, so whether their window matches the one this repo ' +
    'declares is unknown, and a drift would go unreported until this check reads them again:',
  fixHint:
    'The line below names what failed: the execution_purge_retention function in our database, or this ' +
    'check itself. Fix that; the check runs again on its next daily pass.',
  headlineVerb: 'could not read the purge window',
  itemNoun: { one: 'failure', many: 'failures' },
}

export const RETENTION_CHECK_JOB = 'execution-retention-drift'

export interface RetentionCheckResult {
  observed: ObservedPurgeJob[]
  differences: RetentionDifference[]
  alerted: boolean
}

/** One row of `execution_purge_retention()`, before anything is assumed about it. */
interface RetentionRow {
  jobname?: unknown
  active?: unknown
  retention_days?: unknown
  command?: unknown
}

/**
 * A row read defensively, because these values cross a boundary this code does
 * not own. `retention_days` in particular is legitimately null (the command's
 * argument could not be parsed) and must stay null rather than becoming 0, which
 * would read as a real window of zero days and refuse against the code.
 */
function toObserved(row: RetentionRow): ObservedPurgeJob {
  const days = row.retention_days
  return {
    // Strings are accepted only as strings. Coercing an unexpected shape would
    // stringify an object to '[object Object]' and hand that to the comparison as
    // if it were a job name; an unreadable name simply matches neither of the two
    // jobs, which is reported as that job being missing.
    jobname: typeof row.jobname === 'string' ? row.jobname : '',
    active: row.active === true,
    retentionDays: typeof days === 'number' && Number.isInteger(days) ? days : null,
    command: typeof row.command === 'string' ? row.command : '',
  }
}

/**
 * NEVER THROWS. It reports, including about itself.
 *
 * Its caller is a `waitUntil` inside `scheduled()`, where the only thing a
 * rejection can do is reach a `console.error` nobody is watching, and where
 * failure behaviour is unreachable from any test. So the contract lives here:
 * every way this can fail resolves to a result whose `alerted` says what
 * happened. The daily batch's heartbeat covers this check never RUNNING; nothing
 * else would cover it dying halfway (L13).
 */
export async function checkExecutionRetention(
  env: Env,
  supabase: SupabaseClient,
): Promise<RetentionCheckResult> {
  try {
    return await runCheck(env, supabase)
  } catch (err) {
    const detail = `the execution retention check itself failed: ${formatErr(err)}`
    console.error(`[retention-check] ${detail}`)
    await alertQuietly(supabase, env, [detail], RETENTION_CHECK_UNREADABLE_REMEDY)
    return { observed: [], differences: [{ code: 'failed', message: detail }], alerted: true }
  }
}

/**
 * Send the alert, and never let the alerter's own failure become the result.
 *
 * If Slack is what broke, there is nothing left but the log, and throwing would
 * replace a reported problem with an unhandled rejection.
 *
 * AN EMPTY LIST IS STILL SENT. `notifyExportFailure` treats no errors as the
 * RECOVERY signal and uses it to clear its alert state, so short-circuiting a
 * clean run here would leave a resolved drift looking unresolved to the next one.
 */
async function alertQuietly(
  supabase: SupabaseClient,
  env: Env,
  messages: string[],
  remedy: AlertRemedy = RETENTION_CHECK_REMEDY,
): Promise<void> {
  try {
    await notifyExportFailure(supabase, RETENTION_CHECK_JOB, messages, env.IDEMPOTENCY, remedy)
  } catch (err) {
    console.error('[retention-check] could not send its alert:', formatErr(err))
  }
}

async function runCheck(env: Env, supabase: SupabaseClient): Promise<RetentionCheckResult> {
  const { data, error } = await supabase.rpc('execution_purge_retention')

  // Both an error and a null payload are unreadable. A null with no error is a
  // shape PostgREST can return, and treating it as an empty list would report
  // "no purge jobs exist" for what is actually "the read did not work" (L215).
  if (error !== null || data === null || data === undefined) {
    const detail =
      error !== null
        ? `the execution purge jobs could not be read: ${formatErr(error)}`
        : 'the execution purge jobs could not be read: the function answered with no payload at all'
    const differences = [{ code: 'unreadable', message: detail }]
    await alertQuietly(supabase, env, [detail], RETENTION_CHECK_UNREADABLE_REMEDY)
    console.error(`[retention-check] ${detail}`)
    return { observed: [], differences, alerted: true }
  }

  const observed = (data as RetentionRow[]).map(toObserved)
  const differences = retentionDifferences(observed, RETENTION_DAYS)

  await alertQuietly(
    supabase,
    env,
    differences.map((d) => d.message),
    retentionRemedyFor(differences.map((d) => d.code)),
  )

  // Logged on every run including a clean one, so a working check is visible from
  // the outside rather than only being heard from when it complains (#842).
  const seen = observed.map((j) => `${j.jobname}=${String(j.retentionDays)}${j.active ? '' : ' (inactive)'}`).join(' ')
  console.log(`[retention-check] declared=${RETENTION_DAYS} ${seen} differences=${differences.length}`)

  return { observed, differences, alerted: differences.length > 0 }
}
