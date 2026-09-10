/**
 * Whether a repair may run right now, given how far behind the live archive is
 * (#1027, #1032).
 *
 * WHAT HAPPENED. On 2026-08-23 a backlog walker drove `POST /api/admin/re-archive`
 * every three minutes for three hours. Each call takes the same run lock the
 * hourly archive takes and holds it for 80 to 320 seconds, so every hourly run
 * answered `skipped-locked`, the live watermark sat at 15:00 UTC, and the
 * standstill alert fired at 22:00 blaming Snowflake. Nothing was down. The
 * archive was starving itself, and the thing starving it was its own repair.
 *
 * WHY THE REPAIR IS ALWAYS THE ONE THAT YIELDS. Today's hours have a seven day
 * retention clock running on them; a six day old day being repaired has at most
 * one night left either way. Spending the live archive's slots to repair an old
 * day is therefore always the wrong trade, whichever day it is: the repair can
 * wait an hour, and the hours it displaces cannot.
 *
 * A THRESHOLD, NOT A FLAT REFUSAL. The archive is legitimately one or two hours
 * behind at all times, because it will not touch an hour until the settle
 * window has passed. Refusing a repair on that would refuse every repair, which
 * makes the remedy unreachable exactly when it is needed (L362, L109).
 */

/**
 * How far behind the live archive may be before a repair stands aside.
 *
 * The settle window is two hours, so a healthy archive sits at two to three
 * hours behind and this has to clear that. Four is the first value that does,
 * with an hour of ordinary slack on top, so a repair is refused when the live
 * archive has genuinely lost ground rather than when it is doing its job.
 */
export const REPAIR_YIELDS_ABOVE_HOURS_BEHIND = 4

export type RepairVerdict =
  | { allowed: true }
  | { allowed: false; reason: string }

export function mayRepairRun(input: {
  /** Hours between the archive's watermark and now, or null when it cannot be read. */
  hoursBehind: number | null
  /** Set when the caller has said, explicitly and in this request, to go anyway. */
  force?: boolean
}): RepairVerdict {
  if (input.force === true) return { allowed: true }

  // UNREADABLE IS NOT HEALTHY. A watermark that could not be read tells us
  // nothing about whether the live archive is keeping up, and proceeding on
  // that is proceeding on an assumption nobody measured. It refuses, and says
  // which of the two it is, because the remedies differ (L11, L215).
  if (input.hoursBehind === null) {
    return {
      allowed: false,
      reason:
        'how far behind the live archive is could not be read, so there is no way to tell whether a repair ' +
        'would displace hours that still matter. Check the archive watermark, or force this deliberately.',
    }
  }

  if (input.hoursBehind > REPAIR_YIELDS_ABOVE_HOURS_BEHIND) {
    return {
      allowed: false,
      reason:
        `the live archive is ${input.hoursBehind} hours behind, over the ${REPAIR_YIELDS_ABOVE_HOURS_BEHIND} ` +
        'hour limit, and a repair takes the same lock, so running it now would hold today\'s hours back further. ' +
        'Today\'s hours have a retention clock running and the day being repaired has at most one night either ' +
        'way, so the repair is the one that waits. Try again once the archive has caught up, or force this ' +
        'deliberately.',
    }
  }

  return { allowed: true }
}
