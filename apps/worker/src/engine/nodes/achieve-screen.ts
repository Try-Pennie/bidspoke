/**
 * Pre-send screening for the Achieve Offers node.
 *
 * Achieve's APL team gave us a list of criteria they recommend applying before we ping their
 * API (Evan Raciti, 2026-07-15). Dan chose on 2026-08-17 to apply them as a HARD GATE: a lead
 * failing any configured criterion is not sent at all.
 *
 * Two consequences of that choice are worth knowing when reading this file:
 *
 *   1. A rejected lead never reaches Achieve, so we can never learn whether Achieve would have
 *      funded it. Every rejection therefore carries its OWN reason, written onto the execution
 *      record, so the held-back volume can at least be counted and attributed for as long as
 *      executions are retained. A single shared "skipped" reason would make that impossible,
 *      and it cannot be recovered afterwards.
 *   2. Measured against live leads reaching the node, the four payload-only criteria pass about
 *      20%, and the full set with a 600 score floor passes about 7%. So this gate cuts Achieve's
 *      volume from roughly 2,300 leads a day to around 150. That is the intended behaviour, not
 *      a defect, and it is worth re-reading before anyone concludes Achieve has no appetite for
 *      our traffic.
 *
 * EVERY threshold lives in an environment variable and EVERY one is inert when unset, so all
 * six Achieve nodes are configured from one page and no node config is ever touched. A deploy
 * with nothing set changes nothing about which leads are sent.
 *
 * Not implementable, and deliberately absent: citizenship or permanent residency, which no form
 * or credit report we hold collects. That is the ONLY one of Achieve's criteria we cannot apply.
 * DTI was originally thought impossible too, on the belief that we hold no monthly obligations;
 * that was wrong, the credit report carries a scheduled monthly payment per account, and Dan
 * caught it (2026-08-17).
 */

import type { ExecutionContext } from '../../types'
import { resolveValue } from '../context'
import {
  findEquifaxReport,
  countDelinquentTrades,
  countInquiryEpisodes,
  monthsSinceLatestBankruptcy,
  monthlyDebtPayments,
  BANKRUPTCY_DATE_UNKNOWN,
  type DelinquencyMode,
} from './achieve-credit-report'

/**
 * Every reason a lead can be held back. Exported as a list so a reader can enumerate the
 * categories without having to find them all in the code, and so a new criterion cannot be
 * added without a reason of its own.
 */
export const ACHIEVE_SCREEN_REASONS = [
  'no_credit_report',
  'below_vantage_floor',
  'loan_amount_below_min',
  'loan_amount_above_max',
  'state_not_allowed',
  'loan_to_income_too_high',
  'has_current_delinquency',
  'recent_bankruptcy',
  'too_many_inquiries',
  'under_min_age',
  'dti_too_high',
] as const

export type AchieveScreenReason = (typeof ACHIEVE_SCREEN_REASONS)[number]

export interface AchieveScreenConfig {
  /** Per-node override for where the pulled score lives, for flows shaped unlike Main Flow. */
  vantage_score_ref?: string
  /** Per-node override for the step holding the Equifax report. */
  credit_report_ref?: string
}

export interface AchieveScreenVerdict {
  pass: boolean
  reason?: AchieveScreenReason
  /** The measured value and the threshold it was judged against, for the execution record. */
  detail?: Record<string, unknown>
}

const INQUIRY_LOOKBACK_DAYS = 180

// Inquiries closer together than this belong to one shopping episode. Approximates Achieve's
// "after consolidating mortgage and auto inquiries" by TIME, which is how the credit bureaus
// de-duplicate rate shopping, because the industry code on a real report cannot separate auto
// and mortgage cleanly. Override with ACHIEVE_INQUIRY_EPISODE_DAYS once Achieve names a window.
const DEFAULT_EPISODE_WINDOW_DAYS = 14

/** A threshold is active only when it parses to a finite number. Unset, blank and junk are all off. */
function threshold(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * A positive-only threshold, for the score floor. Kept separate from `threshold` because 0 is a
 * meaningful "allow none" for delinquency counts but means "no floor" for a score.
 */
function positiveThreshold(raw: string | undefined): number | null {
  const n = threshold(raw)
  return n != null && n > 0 ? n : null
}

function stateList(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim() === '') return null
  const states = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)
  return states.length > 0 ? new Set(states) : null
}

function delinquencyMode(raw: string | undefined): DelinquencyMode {
  return raw?.trim().toLowerCase() === 'ever' ? 'ever' : 'current'
}

function numberFrom(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Whole years between a date of birth and now, or null when the date cannot be read. */
function ageInYears(dateOfBirth: unknown, now: Date): number | null {
  if (typeof dateOfBirth !== 'string' || dateOfBirth.trim() === '') return null
  const born = new Date(dateOfBirth)
  if (Number.isNaN(born.getTime())) return null
  let age = now.getUTCFullYear() - born.getUTCFullYear()
  const monthDiff = now.getUTCMonth() - born.getUTCMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1
  return age
}

function fail(reason: AchieveScreenReason, detail: Record<string, unknown>): AchieveScreenVerdict {
  return { pass: false, reason, detail }
}

/**
 * Judges one lead against every configured criterion, returning the FIRST failure.
 *
 * `now` is injected so the tests can pin both ends of every date comparison. A fixture whose
 * meaning is the gap between a stored date and the clock drifts into a different case as real
 * time passes if only one end is pinned.
 */
export function screenLead(
  ctx: ExecutionContext,
  config: AchieveScreenConfig = {},
  now: Date = new Date()
): AchieveScreenVerdict {
  const env = ctx.env ?? {}
  const payload = (ctx.trigger?.payload ?? {}) as {
    personalInformation?: { state?: unknown; dateOfBirth?: unknown }
    loanInformation?: { loanAmount?: unknown }
    financialInformation?: { annualIncome?: unknown }
  }

  const minLoan = threshold(env.ACHIEVE_MIN_LOAN_AMOUNT)
  const maxLoan = threshold(env.ACHIEVE_MAX_LOAN_AMOUNT)
  const allowedStates = stateList(env.ACHIEVE_ALLOWED_STATES)
  const maxLti = threshold(env.ACHIEVE_MAX_LOAN_TO_INCOME)
  const minScore = positiveThreshold(env.ACHIEVE_MIN_VANTAGE_SCORE)
  const maxDelinquencies = threshold(env.ACHIEVE_MAX_CURRENT_DELINQUENCIES)
  const minBankruptcyMonths = threshold(env.ACHIEVE_MIN_MONTHS_SINCE_BANKRUPTCY)
  const maxEpisodes = threshold(env.ACHIEVE_MAX_INQUIRY_EPISODES_6MO)
  const episodeWindow = threshold(env.ACHIEVE_INQUIRY_EPISODE_DAYS) ?? DEFAULT_EPISODE_WINDOW_DAYS
  const minAge = threshold(env.ACHIEVE_MIN_AGE)
  const maxDti = threshold(env.ACHIEVE_MAX_DTI)

  const loanAmount = numberFrom(payload.loanInformation?.loanAmount)
  const income = numberFrom(payload.financialInformation?.annualIncome)

  // Loan amount, floor and ceiling reported separately: "asked for too little" and "asked for
  // too much" are different populations and would be indistinguishable under one reason.
  if (minLoan != null && (loanAmount == null || loanAmount < minLoan)) {
    return fail('loan_amount_below_min', { loan_amount: loanAmount, min: minLoan })
  }
  if (maxLoan != null && loanAmount != null && loanAmount > maxLoan) {
    return fail('loan_amount_above_max', { loan_amount: loanAmount, max: maxLoan })
  }

  if (allowedStates != null) {
    // Only a real string counts. Coercing an unexpected shape would compare the literal
    // '[object Object]' against the list, which reads as a state we do not lend in but for
    // the wrong reason; a non-string state is refused as unknown instead.
    const raw = payload.personalInformation?.state
    const state = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
    if (!state || !allowedStates.has(state)) {
      return fail('state_not_allowed', { state: state || null })
    }
  }

  if (maxLti != null) {
    if (loanAmount == null || income == null) {
      return fail('loan_to_income_too_high', { loan_amount: loanAmount, annual_income: income, max: maxLti })
    }
    const ratio = loanAmount / income
    if (ratio >= maxLti) {
      return fail('loan_to_income_too_high', { ratio: Number(ratio.toFixed(4)), max: maxLti })
    }
  }

  if (minAge != null) {
    const age = ageInYears(payload.personalInformation?.dateOfBirth, now)
    if (age == null || age < minAge) {
      return fail('under_min_age', { age, min: minAge })
    }
  }

  // The score keeps its existing source and its existing reason string: it is the criterion
  // already live in production, and renaming it would break continuity with the rows already
  // recorded under `below_vantage_floor`.
  if (minScore != null) {
    const raw = config.vantage_score_ref
      ? resolveValue(config.vantage_score_ref, ctx)
      : ctx.steps?.gen_vantage_score?.output
    const score = numberFrom(raw)
    if (score == null || score < minScore) {
      return fail('below_vantage_floor', { vantage_score: score, min: minScore })
    }
  }

  const needsReport =
    maxDelinquencies != null || minBankruptcyMonths != null || maxEpisodes != null || maxDti != null
  if (!needsReport) return { pass: true }

  // A missing report is NOT a clean report. Refusing here means an Equifax outage stops leads
  // rather than sending them unscreened at exactly the moment we cannot screen them.
  const report = findEquifaxReport(ctx, config.credit_report_ref)
  if (report == null) {
    return fail('no_credit_report', {})
  }

  if (maxDelinquencies != null) {
    const mode = delinquencyMode(env.ACHIEVE_DELINQUENCY_MODE)
    const count = countDelinquentTrades(report, mode)
    if (count > maxDelinquencies) {
      return fail('has_current_delinquency', { delinquent_accounts: count, max: maxDelinquencies, mode })
    }
  }

  if (minBankruptcyMonths != null) {
    const months = monthsSinceLatestBankruptcy(report, now)
    // A filing on record whose date we cannot read counts as recent: it is on the report, and
    // treating it as absent would pass the lead as though it had never filed.
    if (months === BANKRUPTCY_DATE_UNKNOWN) {
      return fail('recent_bankruptcy', { months_since_bankruptcy: null, min: minBankruptcyMonths })
    }
    if (months != null && months < minBankruptcyMonths) {
      return fail('recent_bankruptcy', { months_since_bankruptcy: months, min: minBankruptcyMonths })
    }
  }

  // Counts shopping EPISODES rather than raw inquiries. Six lenders pulled in one week is one
  // trip, which is exactly what Achieve's consolidation exists to let through: measured on 525
  // live reports, 40% of the leads with more than 5 raw inquiries had only one or two episodes.
  if (maxEpisodes != null) {
    const episodes = countInquiryEpisodes(report, episodeWindow, INQUIRY_LOOKBACK_DAYS, now)
    if (episodes > maxEpisodes) {
      return fail('too_many_inquiries', {
        inquiry_episodes: episodes,
        max: maxEpisodes,
        episode_window_days: episodeWindow,
      })
    }
  }

  // Debt to income, from the scheduled monthly payments on the report over monthly gross income.
  // Note this UNDERSTATES a renter's true ratio, because rent never appears on a credit report
  // while a mortgage does. Understatement pushes a lead under the ceiling rather than over it,
  // so the error sends leads the partner may decline rather than excluding leads we should send.
  //
  // A file with no accounts at all yields null, and passes: a ceiling on how much of an income
  // goes to debt is not a reason to refuse somebody with no debt. No stated income is different,
  // and refuses, because the ratio genuinely cannot be computed.
  if (maxDti != null) {
    if (income == null) {
      return fail('dti_too_high', { annual_income: income, max: maxDti })
    }
    const monthly = monthlyDebtPayments(report)
    if (monthly != null) {
      const dti = monthly / (income / 12)
      if (dti > maxDti) {
        return fail('dti_too_high', {
          dti: Number(dti.toFixed(4)),
          monthly_debt_payments: monthly,
          max: maxDti,
        })
      }
    }
  }

  return { pass: true }
}
