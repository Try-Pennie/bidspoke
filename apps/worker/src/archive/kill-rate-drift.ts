/**
 * Keeping the archive kill-rate thresholds honest over time (#1355).
 *
 * KILLS_IN_DAY_THAT_SPEAK and KILLS_IN_WEEK_THAT_SPEAK (kill-rate.ts) were measured
 * once, on 2026-09-15: ordinary weeks carried 2 to 4 kills and the 7/week threshold
 * sat clear of them. They are fixed constants, not a rolling baseline, because at one
 * to four kills a week a rolling baseline measures noise (#1211). But a fixed
 * constant calibrated once expires in silence: if Cloudflare's termination behaviour
 * or the archive's run length changes, the constant describes a distribution that no
 * longer exists, and nothing says so.
 *
 * So this re-measures the LIVE weekly distribution periodically and says when the
 * calibration premise no longer holds. It keeps the constants (the detector stays
 * stable) but makes them answerable: the premise is now re-checked against the data
 * rather than trusted forever.
 *
 * It judges the WEEKLY counts, not the daily ones, because kills are sparse (most
 * days carry zero, so a daily median is uninformative); the weekly count is where
 * the calibrated "ordinary 2 to 4, threshold 7" shape lives.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { KILLS_IN_WEEK_THAT_SPEAK } from './kill-rate'
import { countWeeklyKills, ARCHIVE_JOB_RUN, KILL_COUNT_READ_LIMIT } from '../lib/job-run-record'
import { rateLimitedOrgAlert, type CooldownKv } from '../lib/alert-fanout'
import { getSlackConnection, postMessage } from '../lib/slack'

/**
 * How many ordinary weeks must have crept to within one of the threshold before it
 * counts as drift rather than a single bad week. Two or more is a pattern; one is a
 * blip the alert itself already handles. This also keeps the check conservative on
 * thin history: the per-week reader zero-fills weeks with no data (including weeks
 * before the archive existed), and those zeros never count toward this, so a new or
 * quiet archive cannot drift.
 */
export const DRIFT_MARGIN_WEEKS = 2

export interface DriftVerdict {
  /** Whether the thresholds no longer sit where they were calibrated. */
  drifted: boolean
  /** The sentence for the alert, naming the measurement; null when not drifted. */
  reason: string | null
}

/**
 * Decide whether the weekly kill distribution has drifted from the threshold's
 * calibration (#1355). Pure, so it is exercised against measured shapes with no
 * database near the test.
 *
 * `weeklyCounts` is one kill count per rolling week in the trailing window, with
 * weeks that have no data (including weeks before the archive existed) read as zero
 * by the reader. Drift is a SUSTAINED change, never a single week, counted by weeks
 * so the zero-filled weeks keep it conservative on thin history:
 *  - the rate has reached the threshold in DRIFT_MARGIN_WEEKS or more weeks, so a
 *    trip is no longer rare (counted by tripping weeks, not "every week", which a
 *    single zero-filled week would otherwise defeat), or
 *  - DRIFT_MARGIN_WEEKS or more ordinary weeks (below the threshold) have crept to
 *    one below it, so the margin the constant relied on has closed and a normal week
 *    could now trip it.
 *
 * The "too loose" direction (kills dropping toward zero) is deliberately not flagged:
 * a rate that low is not harmful, and a genuinely dead archive is caught by the
 * vanished-run check and the lag alert, which run outside the archive.
 */
export function decideKillRateDrift(
  weeklyCounts: readonly number[],
  weeklyThreshold: number = KILLS_IN_WEEK_THAT_SPEAK,
): DriftVerdict {
  const trippingWeeks = weeklyCounts.filter((c) => c >= weeklyThreshold).length
  if (trippingWeeks >= DRIFT_MARGIN_WEEKS) {
    return {
      drifted: true,
      reason:
        `The archive kill rate has reached the ${weeklyThreshold} a week threshold in ${trippingWeeks} of the last ` +
        `${weeklyCounts.length} weeks, so a rate that used to be rare has become routine. Re-measure the ordinary ` +
        `rate and reset KILLS_IN_WEEK_THAT_SPEAK (and KILLS_IN_DAY_THAT_SPEAK) in kill-rate.ts, or find why the ` +
        `archive is being killed this often.`,
    }
  }

  // Ordinary weeks that sit one below the threshold: with an integer threshold these
  // are exactly weeklyThreshold - 1, so the message names that one value, not a range.
  const atMargin = weeklyCounts.filter((c) => c >= weeklyThreshold - 1 && c < weeklyThreshold).length
  if (atMargin >= DRIFT_MARGIN_WEEKS) {
    return {
      drifted: true,
      reason:
        `${atMargin} ordinary weeks (weeks that did not themselves trip the alert) have reached ` +
        `${weeklyThreshold - 1} archive kills, one below the ${weeklyThreshold} a week threshold. The margin the ` +
        `threshold was calibrated with (ordinary weeks of 2 to 4 on 2026-09-15) is gone, so a normal week could ` +
        `now trip it. Re-measure the ordinary rate and reset the thresholds in kill-rate.ts, or find why kills ` +
        `have crept up.`,
    }
  }

  return { drifted: false, reason: null }
}

/** How many trailing weeks the drift check reads (#1355). */
export const DRIFT_WINDOW_WEEKS = 8
// Re-surface monthly until someone re-measures: drift is a slow recalibration
// signal, not an incident, so a weekly reminder would be noise.
const DRIFT_COOLDOWN_SECONDS = 30 * 24 * 60 * 60
const DRIFT_COOLDOWN_KEY = 'killrate-drift-cooldown'

function buildBlocks(reason: string, weeksLine: string | null, appUrl: string): unknown[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Archive kill-rate thresholds may need re-measuring', emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: reason } },
    ...(weeksLine ? [{ type: 'section', text: { type: 'mrkdwn', text: weeksLine } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/dashboard|Open dashboard>` } },
  ]
}

/**
 * Daily check (#1355): re-measure the live weekly kill distribution and, when it has
 * drifted from the thresholds' calibration, announce it, re-surfacing monthly until
 * someone re-measures. Returns whether it alerted. Best-effort; the caller runs it in
 * the daily batch's waitUntil. It stays silent on an unreadable read: this is a slow
 * recalibration reminder, not a safety detector, and the takeover notice already
 * speaks when the live kill counts cannot be read.
 */
export async function runKillRateDriftCheck(
  supabase: SupabaseClient,
  kv: CooldownKv,
  appUrl: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const counts = await countWeeklyKills(supabase, ARCHIVE_JOB_RUN, nowMs, DRIFT_WINDOW_WEEKS)

  let reason: string
  let weeksLine: string | null
  if (counts.kind === 'unreadable') {
    // A read ERROR is skipped, and this is deliberately NOT a silent success over a
    // dead check (L98): a read failure here is the database being unreadable, which the
    // volume-cliff database-unreachable alert reports at once and the daily batch's own
    // completion heartbeat (#985) reports if the whole batch fails; a query broken by a
    // schema change is caught before deploy by the DB types gate and the SQL suite. So
    // the ways this read can fail are each covered by a louder alarm, and this slow
    // recalibration reminder should not add a duplicate page on every transient blip. A
    // FLOOR, more unfinished runs than the read limit, is itself extreme drift and is
    // announced below.
    if (counts.cause !== 'floor') {
      console.error(`[killrate-drift] could not read the weekly kill counts, skipping: ${counts.detail}`)
      return false
    }
    reason =
      `The archive has more than ${KILL_COUNT_READ_LIMIT} unfinished (killed) runs in the last ${DRIFT_WINDOW_WEEKS} ` +
      `weeks, far above the rate the kill-rate thresholds were calibrated for. Something is killing the archive at ` +
      `scale, or the thresholds are badly out of date. Investigate, then re-measure and reset the thresholds in ` +
      `kill-rate.ts.`
    weeksLine = null
  } else {
    const verdict = decideKillRateDrift(counts.weeks)
    if (!verdict.drifted) return false
    reason = verdict.reason ?? ''
    // weeks[0] is the most recent 7 day window; read oldest to newest for a person.
    weeksLine = `*Kills per week, oldest to newest:* ${[...counts.weeks].reverse().join(', ')}.`
  }

  return rateLimitedOrgAlert({
    kv,
    cooldownKey: DRIFT_COOLDOWN_KEY,
    ttlSeconds: DRIFT_COOLDOWN_SECONDS,
    supabase,
    logLabel: 'killrate-drift',
    perOrg: async (orgId) => {
      const slack = await getSlackConnection(supabase, orgId)
      if (!slack || !slack.config_alerts_enabled) return false
      return (await postMessage(slack.bot_token, slack.default_channel, buildBlocks(reason, weeksLine, appUrl), 'Archive kill-rate thresholds may need re-measuring')) !== null
    },
  })
}
