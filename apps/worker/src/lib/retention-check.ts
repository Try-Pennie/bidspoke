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
import { notifyExportFailure } from './export-alerts'
import { RETENTION_DAYS } from '../archive/candidate-days'
import { retentionDifferences, type ObservedPurgeJob, type RetentionDifference } from '../archive/retention-drift'
import type { Env } from '../index'

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
    await alertQuietly(supabase, env, [detail])
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
async function alertQuietly(supabase: SupabaseClient, env: Env, messages: string[]): Promise<void> {
  try {
    await notifyExportFailure(supabase, RETENTION_CHECK_JOB, messages, env.IDEMPOTENCY)
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
    await alertQuietly(supabase, env, [detail])
    console.error(`[retention-check] ${detail}`)
    return { observed: [], differences, alerted: true }
  }

  const observed = (data as RetentionRow[]).map(toObserved)
  const differences = retentionDifferences(observed, RETENTION_DAYS)

  await alertQuietly(
    supabase,
    env,
    differences.map((d) => d.message),
  )

  // Logged on every run including a clean one, so a working check is visible from
  // the outside rather than only being heard from when it complains (#842).
  const seen = observed.map((j) => `${j.jobname}=${String(j.retentionDays)}${j.active ? '' : ' (inactive)'}`).join(' ')
  console.log(`[retention-check] declared=${RETENTION_DAYS} ${seen} differences=${differences.length}`)

  return { observed, differences, alerted: differences.length > 0 }
}
