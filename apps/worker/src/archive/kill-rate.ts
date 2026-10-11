/**
 * Whether a killed archive run is worth telling somebody about (#1211).
 *
 * The takeover alert used to fire on every kill. Every kill so far has been a
 * harmless self recovery: Cloudflare terminates a long scheduled invocation
 * every few days, re-dispatches the same cron event within a minute or two, and
 * the replacement takes the dead run's lock and archives the hour its
 * predecessor never reached. The notice even said "No action for a single
 * occurrence", which is an alert arguing against its own delivery.
 *
 * Worse, it arrives with no counterpart. The vanished-run check in
 * `cron-heartbeat.ts` waits 50 minutes for a completion before calling a run
 * killed, and the recovery lands inside three, so nothing ever reports the kill
 * itself. Dan, holding the 2026-09-15 00:23 UTC notice: "I don't need an alert
 * that the run was picked up if I didn't know it was down in the first place
 * because there was no failure alert."
 *
 * Detection is NOT what goes away here, and deleting the alert outright was
 * considered and rejected when this was decided with Dan on 2026-09-08. Nothing
 * else in the system names the CAUSE: the general vanished-run detector cannot
 * see this case at all, because the replacement run completes and overwrites the
 * same started stamp, so the job reads as healthy. What goes away is the routine
 * page. Every takeover still logs and still leaves its `job_runs` row, and real
 * harm is still covered by the standstill check at three hours of no progress
 * and the lag alert at six hours behind, both of which run OUTSIDE the archive
 * so a dead archive cannot silence its own watchdog.
 *
 * WHY TWO WINDOWS. A seven day window alone is too coarse to see a cluster: the
 * 2026-08-23 outage put ten kills into a handful of hours, which a weekly count
 * spreads across days that each look survivable. A daily window alone cannot see
 * a slow degradation: two kills a day is double the normal rate and never
 * reaches three in a day. So each window catches the shape the other is blind
 * to, and either one speaking is enough.
 */

/**
 * The counts the decision is made from, or the fact that they could not be read.
 *
 * `unreadable` is deliberately its own case rather than a zero. A rate gate that
 * treats a failed lookup as "nothing recorded" concludes the rate is normal and
 * goes quiet, which switches the detection off at exactly the moment the
 * database is unwell (L215, L345).
 */
export type KillCounts =
  | { kind: 'counted'; day: number; week: number }
  | { kind: 'unreadable'; detail: string }

export interface KillNotice {
  /** Whether this takeover is worth a Slack message. */
  speak: boolean
  /** The sentence for the alert body, naming the rate. Null when silent. */
  rate: string | null
  /** Why it decided either way, for the log line that is always written. */
  reason: string
}

/**
 * Kills in 24 hours at which the rate stops looking ordinary.
 *
 * Measured from `job_runs` on 2026-09-15, over every kill since the table
 * shipped on 2026-08-22: ten on 2026-08-23 (the exceededMemory outage), two on
 * 08-24 as its tail, and then exactly one on each of 08-25, 08-26, 09-01, 09-05,
 * 09-08, 09-10, 09-11 and 09-15. So an ordinary day carries exactly one and no
 * healthy day has ever reached three.
 */
export const KILLS_IN_DAY_THAT_SPEAK = 3

/**
 * Kills in 7 days at which the rate stops looking ordinary.
 *
 * The three full weeks after that outage carried 4, 2 and 3, the 4 being the
 * week that held the outage's tail. Seven sits clear of all of them, and a
 * sustained two a day, which never trips the daily rule, arrives here in four
 * days.
 *
 * This is a measurement with a date, so it can expire. kill-rate-drift.ts
 * re-measures the live weekly distribution and alerts if these constants no longer
 * sit clear of the ordinary rate, so the premise is re-checked rather than trusted
 * forever (#1355).
 */
export const KILLS_IN_WEEK_THAT_SPEAK = 7

/** How far back each count reaches, named once so the prose cannot drift from it. */
export const KILL_DAY_WINDOW_HOURS = 24
export const KILL_WEEK_WINDOW_DAYS = 7

/** "1 time" and "4 times", because a person reads this sentence in Slack. */
const times = (n: number): string => `${n} time${n === 1 ? '' : 's'}`

/**
 * Pure decision, so the thresholds can be exercised against the measured
 * distribution without a database anywhere near the test.
 *
 * Note what this deliberately never says: "failed", or "error". The takeover is
 * a recovery that worked, and dressing it in the wording that carries genuine
 * outages is what teaches a reader to discount those too (#1210, L11, L112).
 */
export function decideKillNotice(counts: KillCounts): KillNotice {
  if (counts.kind === 'unreadable') {
    return {
      speak: true,
      rate:
        `How often this has been happening could not be read (${counts.detail}), so whether this ` +
        `takeover is routine or one of a cluster is not established here.`,
      reason: `speaking because the recent kill counts could not be read: ${counts.detail}`,
    }
  }

  const { day, week } = counts
  const dayIsHigh = day >= KILLS_IN_DAY_THAT_SPEAK
  const weekIsHigh = week >= KILLS_IN_WEEK_THAT_SPEAK
  if (!dayIsHigh && !weekIsHigh) {
    return {
      speak: false,
      rate: null,
      reason:
        `staying quiet: ${day} in the last ${KILL_DAY_WINDOW_HOURS} hours and ${week} in ` +
        `${KILL_WEEK_WINDOW_DAYS} days is the ordinary rate, and this run recovered the work`,
    }
  }

  // Which window tripped is part of the finding, because the two describe
  // different shapes: a burst inside one day, or a rate that has crept up over
  // the week. A reader acts on those differently.
  const shape = dayIsHigh
    ? 'several in quick succession, which is the shape of a run that cannot finish rather than a platform blip'
    : 'a rate that has crept up over the week rather than a single burst'
  return {
    speak: true,
    rate:
      `The archive has been killed ${times(day)} in the last ${KILL_DAY_WINDOW_HOURS} hours and ` +
      `${times(week)} in ${KILL_WEEK_WINDOW_DAYS} days, against an ordinary rate of about one a day. ` +
      `That is ${shape}.`,
    reason: `speaking because the rate is unusual: ${day} in ${KILL_DAY_WINDOW_HOURS}h, ${week} in ${KILL_WEEK_WINDOW_DAYS}d`,
  }
}
