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
import type { Env } from '../index'

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
}

export interface ExpiryResult {
  cutoff: string | null
  daysExpired: string[]
  rowsDeleted: number
  failed: boolean
  detail: string
}

function cell(data: unknown[][] | undefined, row: number, col: number): string | null {
  const v = data?.[row]?.[col]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null
}

export async function expireArchivedDays(
  env: Env,
  _supabase: SupabaseClient,
  deps: ExpiryDeps = {},
): Promise<ExpiryResult> {
  const now = (deps.now ?? (() => new Date()))()
  // The ERASER, which is the only identity in the account holding DELETE on this
  // table. Using the writer would mean the archive's own writer could destroy it.
  const query =
    deps.query ??
    ((statement: string, bindings?: unknown[]) =>
      executeStatement(archiveConfig(env, 'eraser'), statement, bindings))

  const cutoff = cutoffDay(now)
  if (cutoff === null) {
    // Refused rather than defaulted. A cutoff this cannot compute would, on any
    // fallback, name a date nobody chose, and the action behind it is permanent.
    const detail = 'the retention cutoff could not be computed, so nothing was deleted'
    return { cutoff: null, daysExpired: [], rowsDeleted: 0, failed: true, detail }
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
    return { cutoff, daysExpired: [], rowsDeleted: 0, failed: true, detail }
  }

  if (days.length === 0) {
    return {
      cutoff,
      daysExpired: [],
      rowsDeleted: 0,
      failed: false,
      detail: `nothing is older than ${cutoff}, so no archived day was deleted`,
    }
  }

  const capped = days.length > MAX_DAYS_PER_RUN
  const toDelete = days.slice(0, MAX_DAYS_PER_RUN)

  const daysExpired: string[] = []
  let rowsDeleted = 0
  for (const day of toDelete) {
    try {
      const deleted = await query(`DELETE FROM ${QUALIFIED_TABLE} WHERE archive_day = ?::DATE`, [day])
      const count = Number(cell(deleted.data, 0, 0) ?? '0')
      rowsDeleted += Number.isFinite(count) ? count : 0
      daysExpired.push(day)
    } catch (err) {
      // Stops here rather than carrying on. The days after this one stay listed,
      // so the next run finds them; pressing on would turn one failing day into
      // a run that reports a failure while having deleted around it.
      return {
        cutoff,
        daysExpired,
        rowsDeleted,
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
  return {
    cutoff,
    daysExpired,
    rowsDeleted,
    failed: false,
    detail: `deleted ${daysExpired.length} expired ${daysExpired.length === 1 ? 'day' : 'days'} (${rowsDeleted} rows) older than ${cutoff}.${more}`,
  }
}
