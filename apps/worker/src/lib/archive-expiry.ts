/**
 * Deleting archived days once they pass 13 months (#875, Phase A7).
 *
 * WHY THIS IS THE PART THAT MATTERED. Moving from a 7 day truncate to a 13 month
 * archive multiplies the window in which an applicant's SSN, date of birth,
 * address and credit report sit in one queryable place by about 56 times, and
 * A7's framing was that the controls ship with the archive or the archive does
 * not ship. Every other control did. This one did not: until it existed, every
 * `13 month` string in the worker was a comment describing what needed
 * protecting, nothing deleted an archived row on age, and the multiplier had no
 * upper bound at all. The retention was aspirational.
 *
 * WHAT IT DOES NOT COVER, said out loud so this is not read as 13 months being
 * enforced everywhere. It expires the EXECUTION ARCHIVE. `LEAD_SIGHTINGS` and
 * `LEAD_SIGHTING_BIDS` carry a raw SSN and are retained indefinitely by a
 * separate decision, and they are reachable by the erasure path rather than by
 * this. Their retention is its own question and this job does not answer it.
 *
 * RESUMABLE BY CONSTRUCTION. It holds no cursor and remembers nothing between
 * runs: it asks the archive which days are past the cutoff, deletes them oldest
 * first, and stops at the first one that fails. The next run asks again and the
 * days it did not reach are still there. A remembered position would be a second
 * thing that can be wrong, and the one it would protect against (re-listing) is
 * cheap.
 *
 * OLDEST FIRST is deliberate. A run cut short by a failure, a timeout or the cap
 * has then removed the most exposed days rather than an arbitrary subset.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeStatement } from './snowflake'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import type { Env } from '../index'

/**
 * A retention job that fails silently is the worst shape this can take: the
 * policy is then not in force and nothing says so, and the only symptom is data
 * living longer than it should, which nothing looks at. So a failed run alerts
 * (L13). A run that found nothing to delete does NOT, because for most of this
 * job's life that is the correct and expected outcome.
 */
export const ARCHIVE_EXPIRY_REMEDY: AlertRemedy = {
  consequence:
    'The 13 month retention on the execution archive is not being applied. Nothing has been lost: the ' +
    'opposite, archived executions are being KEPT past the point they should have been deleted, so ' +
    'unredacted SSNs, dates of birth, addresses and credit reports stay queryable in Snowflake for longer ' +
    'than the policy allows:',
  fixHint:
    'The job deletes as bidspoke_archive_eraser, the only identity holding DELETE on the archive table, so ' +
    'check that role and its key first: wrangler secret put ARCHIVE_ERASER_PRIVATE_KEY --name ' +
    'bidspoke-worker. It is resumable, so a run that failed part way needs no repair: the next run finds ' +
    'the days it did not reach. A run that keeps failing is holding data past its retention, which is a ' +
    'compliance matter rather than an availability one.',
  headlineVerb: 'could not apply the retention',
  itemNoun: { one: 'failure', many: 'failures' },
}

export const ARCHIVE_EXPIRY_JOB = 'execution-archive-expiry'

const QUALIFIED_TABLE = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`

/** The retention this enforces, in months. */
export const RETENTION_MONTHS = 13

/**
 * The most days one run will delete.
 *
 * THE CAP IS THE GUARD AGAINST A WRONG CUTOFF. At 13 months exactly one day
 * falls out per day, so a run facing many days is either catching up after an
 * outage, which this handles across a few runs, or computing the wrong date,
 * which must not be able to empty thirteen months of archive in one pass. Ten is
 * comfortably more than catch-up needs and far less than a mistake would want.
 */
export const MAX_DAYS_PER_RUN = 10

/**
 * The day on or after which rows are kept, as YYYY-MM-DD.
 *
 * Month arithmetic is done by clamping rather than by adding months and letting
 * the date overflow: 13 months before 31 March is 28 February, and the naive
 * form produces 3 March, which would delete three days early every year and
 * would do it silently.
 */
export function cutoffDay(now: Date): string | null {
  const ms = now.getTime()
  if (!Number.isFinite(ms)) return null
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() - RETENTION_MONTHS
  const day = now.getUTCDate()
  // Day 0 of the following month is the last day of the month we want, which is
  // how the clamp is expressed without a table of month lengths.
  const lastOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const clamped = Math.min(day, lastOfTarget)
  return new Date(Date.UTC(year, month, clamped)).toISOString().slice(0, 10)
}

export interface ExpiryDeps {
  query?: (statement: string, bindings?: unknown[]) => Promise<{ data?: unknown[][] }>
  now?: () => Date
  notify?: typeof notifyExportFailure
  /**
   * List what would be deleted, and delete nothing (#875).
   *
   * THIS EXISTS BECAUSE THE JOB IS INERT FOR A YEAR. Measured 2026-09-11, the
   * oldest archived day is 2026-08-16 and the cutoff is 2025-08-11, so nothing
   * is past it and nothing will be until about 2027-09. A job whose real work
   * cannot be observed for a year is a job whose only evidence is its tests, and
   * a check that has never actually done anything is not known to work (L1,
   * L557). A dry run makes the day selection provable today, against production,
   * without deleting a row.
   *
   * It reads as the READER, so a preview is never performed by the one
   * credential in the account that can destroy the archive.
   */
  dryRun?: boolean
}

export interface ExpiryResult {
  cutoff: string | null
  daysExpired: string[]
  rowsDeleted: number
  /** Days deleted whose row count could not be read, so the total is a floor. */
  uncounted: string[]
  /** On a dry run, the days it WOULD have deleted. Empty on a real run. */
  wouldExpire?: string[]
  failed: boolean
  detail: string
}

function cell(data: unknown[][] | undefined, row: number, col: number): string | null {
  const v = data?.[row]?.[col]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null
}

/**
 * Runs the expiry and announces a run that could not apply the retention.
 *
 * The alert is raised HERE rather than by the caller, so a second caller cannot
 * get the work without the alerting (L621). A clean run clears any standing
 * alert, so a retention that starts working again stops announcing itself.
 */
export async function expireArchivedDays(
  env: Env,
  supabase: SupabaseClient,
  deps: ExpiryDeps = {},
): Promise<ExpiryResult> {
  const notify = deps.notify ?? notifyExportFailure
  const result = await runExpiry(env, deps)
  await notify(
    supabase,
    ARCHIVE_EXPIRY_JOB,
    result.failed ? [result.detail] : [],
    env.IDEMPOTENCY,
    ARCHIVE_EXPIRY_REMEDY,
  )
  return result
}

async function runExpiry(env: Env, deps: ExpiryDeps): Promise<ExpiryResult> {
  const now = (deps.now ?? (() => new Date()))()
  // The ERASER, which is the only identity in the account holding DELETE on this
  // table. Using the writer would mean the archive's own writer could destroy it.
  const dryRun = deps.dryRun === true
  const query =
    deps.query ??
    ((statement: string, bindings?: unknown[]) =>
      executeStatement(archiveConfig(env, dryRun ? 'reader' : 'eraser'), statement, bindings))

  const cutoff = cutoffDay(now)
  if (cutoff === null) {
    // Refused rather than defaulted. A cutoff this cannot compute would, on any
    // fallback, name a date nobody chose, and the action behind it is permanent.
    const detail = 'the retention cutoff could not be computed, so nothing was deleted'
    return { cutoff: null, daysExpired: [], rowsDeleted: 0, uncounted: [], failed: true, detail }
  }

  let days: string[]
  try {
    const listed = await query(
      `SELECT DISTINCT archive_day FROM ${QUALIFIED_TABLE} WHERE archive_day < ?::DATE ORDER BY archive_day ASC`,
      [cutoff],
    )
    days = (listed.data ?? [])
      .map((row) => (typeof row?.[0] === 'string' ? row[0].slice(0, 10) : null))
      .filter((d): d is string => d !== null)
      // Sorted HERE as well as in the statement. Oldest first is load bearing,
      // because a run cut short by a failure or the cap must have removed the
      // most exposed days rather than an arbitrary subset, and a guarantee that
      // lives only in a remote store's ORDER BY is lost silently the first time
      // the statement is edited (L343). ISO dates sort correctly as strings.
      .sort()
  } catch (err) {
    const detail = `the expired days could not be listed, so nothing was deleted: ${formatErr(err)}`
    return { cutoff, daysExpired: [], rowsDeleted: 0, uncounted: [], failed: true, detail }
  }

  if (days.length === 0) {
    return {
      cutoff,
      daysExpired: [],
      rowsDeleted: 0,
      uncounted: [],
      failed: false,
      detail: `nothing is older than ${cutoff}, so no archived day was deleted`,
    }
  }

  const capped = days.length > MAX_DAYS_PER_RUN
  const toDelete = days.slice(0, MAX_DAYS_PER_RUN)

  if (dryRun) {
    return {
      cutoff,
      daysExpired: [],
      rowsDeleted: 0,
      uncounted: [],
      failed: false,
      wouldExpire: toDelete,
      detail:
        `dry run: ${days.length} archived ${days.length === 1 ? 'day is' : 'days are'} older than ${cutoff}` +
        `${capped ? `, of which the first ${toDelete.length} would be deleted this run` : ''}` +
        `${toDelete.length > 0 ? ` (${toDelete.join(', ')})` : ''}. Nothing was deleted.`,
    }
  }

  const daysExpired: string[] = []
  let rowsDeleted = 0
  // Days whose delete SUCCEEDED but whose row count could not be read. Counted
  // separately rather than added as zero: the rows are gone either way, and a
  // total that quietly understates itself is worse than one that says which
  // part of it is unknown (L50, L11).
  const uncounted: string[] = []
  for (const day of toDelete) {
    try {
      const deleted = await query(`DELETE FROM ${QUALIFIED_TABLE} WHERE archive_day = ?::DATE`, [day])
      const raw = cell(deleted.data, 0, 0)
      const count = raw === null ? Number.NaN : Number(raw)
      if (Number.isFinite(count)) rowsDeleted += count
      else uncounted.push(day)
      daysExpired.push(day)
    } catch (err) {
      // Stops here rather than carrying on. The days after this one stay listed,
      // so the next run finds them; pressing on would turn one failing day into
      // a run that reports a failure while having deleted around it.
      return {
        cutoff,
        daysExpired,
        rowsDeleted,
        uncounted,
        failed: true,
        detail:
          `deleted ${daysExpired.length} expired ${daysExpired.length === 1 ? 'day' : 'days'} ` +
          `(${rowsDeleted} rows), then stopped at ${day}: ${formatErr(err)}. ` +
          `The remaining days are still past the cutoff and the next run will find them.`,
      }
    }
  }

  const more = capped
    ? ` ${days.length - toDelete.length} more remain past the cutoff and are capped to the next run.`
    : ''
  const unknown =
    uncounted.length > 0
      ? ` ${uncounted.length} of those days deleted without a readable row count (${uncounted.join(', ')}), so the row total is a floor rather than the figure.`
      : ''
  return {
    cutoff,
    daysExpired,
    rowsDeleted,
    uncounted,
    failed: false,
    detail: `deleted ${daysExpired.length} expired ${daysExpired.length === 1 ? 'day' : 'days'} (${rowsDeleted} rows) older than ${cutoff}.${more}${unknown}`,
  }
}
