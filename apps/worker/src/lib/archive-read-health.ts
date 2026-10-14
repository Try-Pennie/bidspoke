/**
 * Counting archived read failures, so an archive outage is visible (#1272).
 *
 * `readArchivedExecution` and its siblings answer `unavailable` when the archive
 * cannot be reached, and the page renders that honestly with a retry. Nothing
 * counted those answers, so a Snowflake warehouse that will not resume, a reader
 * role that lost its grant, and one slow query all produced the same sentence on
 * the screen and no signal anywhere. That is L77: an error deliberately
 * classified as expected must still be counted against something, because the
 * code waving it through has no notion of volume.
 *
 * It matters more here than usual because of WHO is affected. An archived read
 * happens when somebody is investigating a partner dispute or a lead complaint.
 * They will try again, get the same sentence, and conclude the feature is broken
 * rather than report an outage.
 *
 * WHY A STREAK RATHER THAN A RATIO. #1272 asked for a ratio of failures to total
 * reads over a window, above a minimum volume floor, and said in the same breath
 * that the floor could not be guessed and had to be measured once this shipped.
 * An alert that cannot fire until somebody returns with data is not an alert
 * yet. Two archived reads failing back to back is a signal at any volume, so the
 * streak needs no floor and works from the first day. Dan chose this shape over
 * the ratio on 2026-09-11.
 *
 * WHAT THIS DOES NOT COVER, deliberately. Zero reads and zero failures is the
 * ordinary quiet day, and it is also what a total outage looks like when nobody
 * happens to try. Nothing derived from read traffic can tell those apart. What
 * does is the daily identity check (`archive-identity-check.ts`), which connects
 * to Snowflake AS THE READER on a schedule and reports when it cannot, whether
 * or not anybody read anything. So the pair is: that check answers "is the
 * archive reachable at all", once a day, with no traffic needed; this answers
 * "are the reads people actually make working", within two reads. Neither
 * replaces the other, and removing either leaves a real gap.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { ARCHIVE_WAREHOUSE } from './archive-snowflake'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Names this signal in the alert header and in its KV keys. Never rename it. */
export const ARCHIVE_READ_ALERT_JOB = 'execution-archive-reads'

/**
 * Consecutive failed reads before this speaks. Two, because a single archived
 * read can fail for reasons that clear on their own (a cold warehouse resuming,
 * one slow query), while a second one straight after it cannot be explained that
 * way.
 */
export const ARCHIVE_READ_FAILURE_THRESHOLD = 2

/**
 * Between repeat alerts for an outage that is still going. Half an hour, because
 * archived reads are driven by a person clicking rather than by a schedule, so
 * without this a determined operator retrying produces one Slack message per
 * click.
 */
export const ARCHIVE_READ_COOLDOWN_TTL_SECONDS = 30 * 60

/**
 * How long a streak survives without being added to. A day, so two failures a
 * month apart are not counted as consecutive: they are two separate blips and
 * the second one deserves the same benefit of the doubt as the first.
 */
const ARCHIVE_READ_STREAK_TTL_SECONDS = 24 * 60 * 60

export const ARCHIVE_READ_REMEDY: AlertRemedy = {
  consequence:
    'Archived executions cannot be read. Nothing has been deleted and nothing is missing: what is ' +
    'broken is the path that serves executions older than the seven days Postgres keeps, so anybody ' +
    'investigating a dispute on an older lead is being told to try again:',
  fixHint:
    'Check Snowflake first: whether the warehouse the archive reads from can resume, and whether ' +
    'bidspoke_archive_reader still holds SELECT on the archive table. If both are fine, the named ' +
    'secret is the next place to look: wrangler secret put ARCHIVE_READER_PRIVATE_KEY --name ' +
    'bidspoke-worker. The daily archive identity check reports the same account from the other ' +
    'direction and is worth reading beside this.',
  headlineVerb: 'could not be read',
  itemNoun: { one: 'failed read', many: 'failed reads' },
}

/** A secret the failure says is unset, as `archiveConfig` words it. */
const UNSET_SECRET = /\b([A-Z][A-Z0-9_]+) is not set\b/

/**
 * The fix line led by what the failure names (#835). It used to lead with
 * "check Snowflake first" for every failure, including an unset secret, where
 * Snowflake was never asked, and a timeout, where the warehouse is the place to
 * look and a retry once it answers is served.
 */
export function archiveReadRemedyFor(detail: string): AlertRemedy {
  const unset = UNSET_SECRET.exec(detail)?.[1]
  if (unset !== undefined) {
    return {
      ...ARCHIVE_READ_REMEDY,
      fixHint:
        `Set ${unset} with wrangler secret put ${unset} --name bidspoke-worker, piping the value in. ` +
        'Archived reads fail before reaching Snowflake until it is set.',
    }
  }
  if (/did not answer within/.test(detail)) {
    return {
      ...ARCHIVE_READ_REMEDY,
      fixHint:
        `The reads are timing out. Check in Snowflake that the ${ARCHIVE_WAREHOUSE} warehouse can resume and ` +
        'is not queued; a read retried once it answers is served.',
    }
  }
  return ARCHIVE_READ_REMEDY
}

const streakKey = `archive-read-failures:${ARCHIVE_READ_ALERT_JOB}`
const cooldownKey = `archive-read-alert-cooldown:${ARCHIVE_READ_ALERT_JOB}`

export type ArchiveReadOutcome = { kind: 'ok' } | { kind: 'unavailable'; detail: string }

export interface ArchiveReadHealthDeps {
  notify?: typeof notifyExportFailure
}

/**
 * Record one archived read's outcome, and announce a run of failures.
 *
 * Returns whether an alert was delivered, which is what the tests assert on.
 * Best effort by contract: callers run it beside a read that has already been
 * answered, and its own failure must never turn a served read into an error.
 */
export async function recordArchiveReadOutcome(
  supabase: SupabaseClient,
  kv: KvLike | undefined,
  outcome: ArchiveReadOutcome,
  deps: ArchiveReadHealthDeps = {},
): Promise<boolean> {
  const notify = deps.notify ?? notifyExportFailure

  if (outcome.kind === 'ok') {
    if (kv) await kv.delete(streakKey)
    return false
  }

  // No KV means no memory, so the streak cannot be kept. The choice then is
  // between announcing every failure and announcing none, and none is the one
  // there is no recovering from: a binding that is missing is exactly when a
  // signal is most likely to be needed and least likely to be looked for (L42).
  if (!kv) {
    await post(notify, supabase, outcome.detail, 1)
    return true
  }

  const streak = countFailure(await kv.get(streakKey))
  await kv.put(streakKey, String(streak), { expirationTtl: ARCHIVE_READ_STREAK_TTL_SECONDS })

  if (streak < ARCHIVE_READ_FAILURE_THRESHOLD) {
    console.log(
      `[archive-read-health] failure ${streak} of ${ARCHIVE_READ_FAILURE_THRESHOLD} held (no alert unless the next read also fails): ${outcome.detail}`,
    )
    return false
  }

  if (await kv.get(cooldownKey)) return false

  await post(notify, supabase, outcome.detail, streak)
  await kv.put(cooldownKey, '1', { expirationTtl: ARCHIVE_READ_COOLDOWN_TTL_SECONDS })
  return true
}

/**
 * This failure's position in the streak, from whatever the last one stored.
 *
 * A value that cannot be read is treated as already AT the threshold, so the
 * failure speaks. It is written as a decision rather than left to arithmetic:
 * the first version compared `Number(stored) + 1` directly, and a corrupt entry
 * gave NaN, which is less than nothing, so it alerted by accident and then wrote
 * "NaN" back and could never be read again (L50).
 *
 * Absent is different from unreadable and is the ordinary case: no entry means
 * this is the first failure.
 */
function countFailure(stored: string | null): number {
  if (stored === null) return 1
  const n = Number(stored)
  return Number.isInteger(n) && n >= 0 ? n + 1 : ARCHIVE_READ_FAILURE_THRESHOLD
}

/**
 * Deliver through the shared archive alerter, passing it NO KV on purpose.
 *
 * `notifyExportFailure` holds a first failure and pages on the second, which is
 * the same shape as the streak above, but it decides what to hold by matching
 * the error TEXT against rules written for the export jobs. An archive read's
 * wording is not text those rules recognise, so its own holding would apply
 * unpredictably on top of the holding this module has already done. Handing it
 * no KV turns that off, and it is written here rather than left as an omission
 * so it cannot be "fixed" back in by somebody passing the binding through.
 *
 * WHAT THE COOLDOWN ACTUALLY MEASURES. It starts on the ATTEMPT, not on
 * confirmed delivery, because `notifyExportFailure` returns nothing and cannot
 * say whether Slack took the message. So a Slack outage at the same moment
 * costs half an hour of silence about the archive. Every archive check that
 * borrows this alerter has the same property; naming it here rather than
 * leaving it to be discovered during an incident.
 */
async function post(
  notify: typeof notifyExportFailure,
  supabase: SupabaseClient,
  detail: string,
  streak: number,
): Promise<void> {
  await notify(
    supabase,
    ARCHIVE_READ_ALERT_JOB,
    [`${streak} archived reads in a row could not be served. The last one said: ${detail}`],
    undefined,
    archiveReadRemedyFor(detail),
  )
}
