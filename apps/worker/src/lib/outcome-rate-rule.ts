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
 * Below `minAttempts`, while no page stands, the hour is otherwise QUIET, a
 * third state distinct from normal (L11); while one stands see HYSTERESIS. A baseline that could not be read, or one thinner than
 * `baselineMinAttempts`, leaves the rate unmeasured with the reason.
 *
 * HYSTERESIS (#2421). A page is raised at 25 points above the baseline and,
 * once it stands, held until the share falls back under 12.5 points above it,
 * half the rise that raised it (OUTCOME_RATE_CLEAR_RISE). On 2026-10-14
 * Tripoint's decline share swung between 18 and 33 points above its 42%
 * baseline hour to hour, so a rule that raised and cleared on the one line
 * stood the page down and raised it again through one incident. A share inside
 * the band between the two lines is HELD while a page stands, and normal while
 * none does, so the band never raises a page on its own. Each check says
 * whether its page stands (`pageStanding`), from its own marker; the rule reads
 * no storage. While a page stands an hour below `minAttempts` is judged
 * against the clear line too, since being thin shows nothing about whether the
 * share fell back: one still above it holds the page, one back under it (or
 * with no attempts at all) is quiet and clears it. A thin hour never raises.
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
  /** A page stands and this hour is not back under the clear line, so it stands on (#2421). */
  | { verdict: 'held'; detail: string }
  | { verdict: 'unmeasured'; reason: string }

/**
 * Whether a verdict may move a page. An hour that could not be measured says
 * nothing about a page already standing, so it neither raises one nor clears
 * one (L98, L695): only a measured hour, elevated, normal or quiet, does. A
 * held hour is measured but is by definition one that keeps a standing page as
 * it is (#2421), so it moves nothing either. Both checks gate their page on
 * this one predicate (L261), the bridge on its single page and
 * buyer-outcome-rate per buyer (#2420).
 */
export function verdictMovesThePage(v: OutcomeRateVerdict): boolean {
  return v.verdict !== 'unmeasured' && v.verdict !== 'held'
}

/** Elevated means at least this many points above the baseline share. */
export const OUTCOME_RATE_MIN_RISE = 0.25

/**
 * A standing page clears once the share is back under this many points above
 * the baseline share: half the rise that raises one (#2421). At 40 sends an
 * hour's decline share has a standard deviation of about 8 points, so an hour
 * from a buyer back at its baseline lands under 12.5 points above it about 19
 * times in 20, and a busier hour more often: a real recovery clears within an
 * hour or two. At buyer-outcome-rate's 10 attempts the deviation is nearer 15
 * points and such an hour lands under the line about 4 times in 5, so a
 * recovery there now and then clears an hour late, which is the price of not
 * raising the page again on every swing. On 2026-10-14 every judged hour sat
 * at least 18 points above Tripoint's baseline, more than 5 points clear of
 * this line, so the incident reads as one page. A share exactly on the line
 * still stands: it clears only once it is under it.
 */
export const OUTCOME_RATE_CLEAR_RISE = OUTCOME_RATE_MIN_RISE / 2

/** A rise as the page prints it, in points: 25, 12.5. */
const points = (rise: number): string => `${Math.round(rise * 1000) / 10}`

/** Shares are ratios of integers; this keeps a rise of exactly 25 points from reading as 24.999. */
const RISE_TOLERANCE = 1e-9

/** A share as a whole percent, the way every outcome rate line prints one. */
export const percent = (n: number): string => `${Math.round(n * 100)}%`

/** The calendar date `days` before an ISO date (negative for after): how both checks walk their baseline window. */
export function isoDateMinus(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}
const FAILED_WHAT = 'failed before the buyer processed the lead (a buyer error or an answer nobody could classify)'

/**
 * `pageStanding` is whether the caller's page for these attempts stands now,
 * read from the caller's own marker. It is required, so no caller can leave
 * its page without the hysteresis by omission.
 */
export function judgeOutcomeShares(
  hour: OutcomeCounts,
  baseline: OutcomeBaseline | BaselineUnreadable | null,
  rule: OutcomeRateRule,
  pageStanding: boolean,
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
  const thin = attempts < rule.minAttempts
  const quiet = (): OutcomeRateVerdict => {
    let shape: string
    if (attempts > 0 && failed === attempts) shape = `every one failed, fewer than the ${rule.saturationMinAttempts} that makes that a finding on its own`
    else if (noAcceptMin !== null && attempts > 0 && accepted === 0) shape = `none was accepted, fewer than the ${noAcceptMin} that makes that a finding on its own`
    else shape = noAcceptMin === null ? 'and not every one failed' : 'and not every one failed or went unaccepted'
    return { verdict: 'quiet', detail: `${attempts} attempts in the last hour, fewer than the ${rule.minAttempts} a rate needs, ${shape}` }
  }
  // With no page standing, or nothing sent at all, a thin hour is quiet as it
  // always was; while a page stands it is held to the clear line below.
  if (thin && (!pageStanding || attempts === 0)) return quiet()

  const window = `the prior ${rule.baselineDays} days`
  if (baseline === null) return { verdict: 'unmeasured', reason: `the baseline over ${window} could not be read` }
  if ('unreadable' in baseline) return { verdict: 'unmeasured', reason: `the baseline over ${window} could not be read: ${baseline.unreadable}` }
  const span = baseline.span ?? window
  if (baseline.attempts < rule.baselineMinAttempts) {
    return { verdict: 'unmeasured', reason: `the baseline over ${span} holds ${baseline.attempts} attempts, fewer than the ${rule.baselineMinAttempts} it needs` }
  }

  const against = (base: number) => `against ${percent(base)} over ${span}`
  const failedShare = failed / attempts
  const failedBase = baseline.failed / baseline.attempts
  const declinedShare = declined / attempts
  const declinedBase = baseline.declined / baseline.attempts
  /** Each share at least `rise` above its baseline share, as the page words it. */
  const sharesAtLeast = (rise: number): string[] => {
    const over = (now: number, base: number) => now - base >= rise - RISE_TOLERANCE
    const findings: string[] = []
    if (over(failedShare, failedBase)) findings.push(`${failed} of ${attempts} attempts in the last hour ${FAILED_WHAT}, ${percent(failedShare)} ${against(failedBase)}`)
    if (over(declinedShare, declinedBase)) findings.push(`${declined} of ${attempts} attempts in the last hour were declined by the buyer, ${percent(declinedShare)} ${against(declinedBase)}`)
    return findings
  }

  const raised = thin ? [] : sharesAtLeast(OUTCOME_RATE_MIN_RISE)
  if (raised.length > 0) return { verdict: 'elevated', detail: raised.join('; ') }
  if (pageStanding) {
    const holding = sharesAtLeast(OUTCOME_RATE_CLEAR_RISE)
    if (holding.length > 0) {
      const lead = thin ? `${attempts} attempts in the last hour, fewer than the ${rule.minAttempts} a rate needs to raise a page; ` : ''
      return {
        verdict: 'held',
        detail: `${lead}${holding.join('; ')}: under the ${points(OUTCOME_RATE_MIN_RISE)} points above the baseline that raise a page, but not back under the ${points(OUTCOME_RATE_CLEAR_RISE)} that clear one, so the standing page holds`,
      }
    }
  }
  if (thin) return quiet()
  return { verdict: 'normal', detail: `${attempts} attempts in the last hour, ${percent(failedShare)} failed ${against(failedBase)}, ${percent(declinedShare)} declined ${against(declinedBase)}` }
}
