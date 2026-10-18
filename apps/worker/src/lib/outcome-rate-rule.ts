/**
 * The outcome rate rule: whether a buyer failed or declined an unusual share of
 * the last hour's attempts, against a baseline share (#1413). One decision, two
 * checks reading it (L370): buyer-outcome-rate in the buyer sales checks, over
 * buyer_sales, and the Tripoint bridge on the Engine tripoint_ping path
 * (tripoint-ping-outcome-rate.ts, #2392). Each check counts its own attempts and
 * sizes its own floors for the volume it sees (L716); the rule that turns those
 * counts into a verdict, and the words it says, live only here.
 *
 * A share is elevated when it is at least 25 points above the baseline share.
 * Until #2392 it also had to be more than double the baseline. Below a 25%
 * baseline the 25 points already more than double it, so the double clause
 * changed nothing there; above 25% it was the only clause that bit, and above
 * 50% it could never be met. Tripoint declines about 42% of what it is sent
 * (Oct 11 to 13, 3,541 of 8,377), so when it began declining about 67% on
 * 2026-10-14 no version of the rule could say so. Dropping the clause leaves
 * every baseline under 25% judged exactly as before.
 *
 * Saturation is judged first and needs no baseline (L139): an hour in which
 * every attempt failed, from `saturationMinAttempts`, and, where a check sets
 * it, an hour in which nothing was accepted, from `noAcceptSaturationMinAttempts`.
 * Below `minAttempts` the hour is otherwise QUIET, a third state distinct from
 * normal (L11). A baseline that could not be read, or one thinner than
 * `baselineMinAttempts`, leaves the rate unmeasured with the reason.
 */

/** One window's resolved attempts: every one, those that failed before the buyer processed them, those the buyer declined. */
export interface OutcomeCounts {
  attempts: number
  failed: number
  declined: number
}

/** The baseline's counts, and optionally what span they cover when that is not the rule's whole window (L11). */
export interface OutcomeBaseline extends OutcomeCounts {
  span?: string
}

/** How a baseline that could not be read is handed to the judge, with the reason. */
export interface BaselineUnreadable {
  unreadable: string
}

export interface OutcomeRateRule {
  /** Attempts an hour must hold before its shares are judged against the baseline. */
  minAttempts: number
  /** Attempts an hour must hold for every one of them failing to be a finding on its own (L139). */
  saturationMinAttempts: number
  /** Attempts an hour must hold for none being accepted to be a finding on its own, or null where the check does not judge that. */
  noAcceptSaturationMinAttempts: number | null
  /** Attempts the baseline must hold before an hour is judged against it. */
  baselineMinAttempts: number
  /** The baseline window, in Eastern days before today. */
  baselineDays: number
}

export type OutcomeRateVerdict =
  | { verdict: 'normal' | 'quiet'; detail?: string }
  | { verdict: 'elevated'; detail: string }
  | { verdict: 'unmeasured'; reason: string }

/** Elevated means at least this many points above the baseline share. */
export const OUTCOME_RATE_MIN_RISE = 0.25

/** Shares are ratios of integers; this keeps a rise of exactly 25 points from reading as 24.999. */
const RISE_TOLERANCE = 1e-9

const percent = (n: number): string => `${Math.round(n * 100)}%`
const FAILED_WHAT = 'failed before the buyer processed the lead (a buyer error or an answer nobody could classify)'

export function judgeOutcomeShares(
  hour: OutcomeCounts,
  baseline: OutcomeBaseline | BaselineUnreadable | null,
  rule: OutcomeRateRule,
): OutcomeRateVerdict {
  const { attempts, failed, declined } = hour
  const accepted = attempts - failed - declined
  const noAcceptMin = rule.noAcceptSaturationMinAttempts

  if (attempts >= rule.saturationMinAttempts && failed === attempts) {
    return { verdict: 'elevated', detail: `all ${attempts} attempts in the last hour ${FAILED_WHAT}` }
  }
  if (noAcceptMin !== null && attempts >= noAcceptMin && accepted === 0) {
    return {
      verdict: 'elevated',
      detail: `none of the ${attempts} attempts in the last hour was accepted: ${declined} declined by the buyer, ${failed} ${FAILED_WHAT}`,
    }
  }
  if (attempts < rule.minAttempts) {
    let shape: string
    if (attempts > 0 && failed === attempts) shape = `every one failed, fewer than the ${rule.saturationMinAttempts} that makes that a finding on its own`
    else if (noAcceptMin !== null && attempts > 0 && accepted === 0) shape = `none was accepted, fewer than the ${noAcceptMin} that makes that a finding on its own`
    else shape = noAcceptMin === null ? 'and not every one failed' : 'and not every one failed or went unaccepted'
    return { verdict: 'quiet', detail: `${attempts} attempts in the last hour, fewer than the ${rule.minAttempts} a rate needs, ${shape}` }
  }

  const window = `the prior ${rule.baselineDays} days`
  if (baseline === null) return { verdict: 'unmeasured', reason: `the baseline over ${window} could not be read` }
  if ('unreadable' in baseline) return { verdict: 'unmeasured', reason: `the baseline over ${window} could not be read: ${baseline.unreadable}` }
  const span = baseline.span ?? window
  if (baseline.attempts < rule.baselineMinAttempts) {
    return { verdict: 'unmeasured', reason: `the baseline over ${span} holds ${baseline.attempts} attempts, fewer than the ${rule.baselineMinAttempts} it needs` }
  }

  const elevated = (now: number, base: number) => now - base >= OUTCOME_RATE_MIN_RISE - RISE_TOLERANCE
  const against = (base: number) => `against ${percent(base)} over ${span}`
  const findings: string[] = []
  const failedShare = failed / attempts
  const failedBase = baseline.failed / baseline.attempts
  if (elevated(failedShare, failedBase)) findings.push(`${failed} of ${attempts} attempts in the last hour ${FAILED_WHAT}, ${percent(failedShare)} ${against(failedBase)}`)
  const declinedShare = declined / attempts
  const declinedBase = baseline.declined / baseline.attempts
  if (elevated(declinedShare, declinedBase)) findings.push(`${declined} of ${attempts} attempts in the last hour were declined by the buyer, ${percent(declinedShare)} ${against(declinedBase)}`)
  if (findings.length > 0) return { verdict: 'elevated', detail: findings.join('; ') }
  return { verdict: 'normal', detail: `${attempts} attempts in the last hour, ${percent(failedShare)} failed ${against(failedBase)}, ${percent(declinedShare)} declined ${against(declinedBase)}` }
}
