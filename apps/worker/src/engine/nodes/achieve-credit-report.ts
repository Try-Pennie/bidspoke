/**
 * Reads the Equifax credit report the lead already carries, so partner screening can use
 * the parts of it we have always paid for and thrown away.
 *
 * Until now the workflow lifted exactly one number out of this report (the score) and
 * discarded the rest. Achieve's own screening criteria (current delinquencies, months since
 * bankruptcy, inquiries in the last six months) are all in the discarded part, so nothing
 * new is fetched or bought here.
 *
 * Three details were measured against 500 live reports on 2026-08-17, and each one silently
 * returns NOTHING rather than failing when read wrong, so each has its own test:
 *
 *   1. The report sits at different depths per workflow. The Engine workflow's step output is
 *      `{consumers, status}`; Main Flow's is `{data: {consumers, status}, error, statusCode}`.
 *      A reader written against one finds no report at all in the other.
 *   2. `equifaxUSConsumerCreditReport` is sometimes an object and sometimes a one-element array.
 *   3. Every date is EIGHT DIGITS in MMDDYYYY order ('07092026'). Read year-first it becomes a
 *      year 707 date, which makes every recency test pass.
 *
 * An absent section means the consumer has none of that thing: Equifax omits empty sections
 * rather than sending an empty array. That was verified rather than assumed, because absence
 * read as an answer is the dangerous direction here: across 400 reports, 29 carried a
 * bankruptcy section and exactly ZERO mentioned a bankruptcy anywhere while lacking the
 * section. So a missing section is a real "none", not an unpurchased field.
 */

import type { ExecutionContext } from '../../types'

export const DEFAULT_REPORT_NAMESPACE = 'equifax_credit_report'

/** Sentinel for a bankruptcy that is on file but carries no readable filing date. */
export const BANKRUPTCY_DATE_UNKNOWN = -1

export interface EquifaxTrade {
  rate?: { code?: number | string }
  scheduledPaymentAmount?: unknown
  balance?: unknown
}

export interface EquifaxInquiry {
  inquiryDate?: unknown
  /**
   * A PLAIN CODE STRING such as 'AN' or 'FA', not an object. Deliberately noted because the
   * neighbouring `rate` on a trade IS an object with a numeric `code`, so the two disagree and
   * assuming either shape applies to the other reads as an absent value rather than failing.
   *
   * Measured against real dealer and lender names on 2026-08-18: 'AN' and 'AU' are car
   * dealerships, and 'FA' mixes captive auto finance arms (Ford Motor Credit, GM Financial,
   * Ally) with personal lenders (Upstart), while 'BB' mixes banks and credit cards with bank
   * auto arms. So the codes do NOT cleanly separate auto from anything else, and mortgage
   * barely appears at all. Nothing consolidates on this field yet for exactly that reason: see
   * ACHIEVE_MAX_INQUIRIES_6MO in docs/nodes/achieve-offers.md.
   */
  industryCode?: string
}

export interface EquifaxBankruptcy {
  dateFiled?: unknown
}

export interface EquifaxReport {
  trades: EquifaxTrade[]
  inquiries: EquifaxInquiry[]
  bankruptcies: EquifaxBankruptcy[]
  score: number | null
}

export type DelinquencyMode = 'current' | 'ever'

/**
 * Account rating codes, measured against the score on 500 live reports rather than taken
 * from a specification:
 *
 *   codes 2-5  currently past due, 30 through 120+ days. Files carrying these average 580
 *              against 632 for clean files, a real 52-point drop.
 *   code  6    NOT delinquency. Files whose only such mark is a 6 average 633, which is the
 *              clean-file average. Counting it would flag 54% of all files as delinquent
 *              while those people score as well as anyone.
 *   code  7    court-supervised repayment plan, on 8 of 500 files. Not a past-due.
 *   codes 8-9  repossession and charge-off/collection. Historical marks, not current
 *              past-dues: a file whose only mark is a 9 averages 622, ten points off clean.
 *   codes 0-1  too new to rate, and pays as agreed.
 */
const CURRENT_DELINQUENT_CODES = new Set([2, 3, 4, 5])
const HISTORICAL_DELINQUENT_CODES = new Set([8, 9])

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * The report for this lead, or null when the pull never ran or failed.
 *
 * Null and an empty report are deliberately different answers: an Equifax failure returns a
 * populated envelope with no report inside, and treating that as an empty-but-valid report
 * would pass every credit-based check on a lead we know nothing about.
 */
export function findEquifaxReport(
  ctx: ExecutionContext,
  namespace: string = DEFAULT_REPORT_NAMESPACE
): EquifaxReport | null {
  const output = ctx.steps?.[namespace]?.output as Record<string, unknown> | undefined
  if (!output || typeof output !== 'object') return null

  // Main Flow nests one level deeper than the Engine workflow. Check both, in that order.
  const nested = output.data as Record<string, unknown> | null | undefined
  const consumers =
    (nested && typeof nested === 'object' ? nested.consumers : undefined) ?? output.consumers
  if (!consumers || typeof consumers !== 'object') return null

  const raw = (consumers as Record<string, unknown>).equifaxUSConsumerCreditReport
  const report = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined
  if (!report || typeof report !== 'object') return null

  const models = asArray<{ score?: unknown }>(report.models)
  const rawScore = models[0]?.score
  const score = Number(rawScore)

  return {
    trades: asArray<EquifaxTrade>(report.trades),
    inquiries: asArray<EquifaxInquiry>(report.inquiries),
    bankruptcies: asArray<EquifaxBankruptcy>(report.bankruptcies),
    score: Number.isFinite(score) && score > 0 ? score : null,
  }
}

/**
 * Equifax's eight-digit MMDDYYYY dates, or null when the value cannot be read.
 *
 * Never guesses. An unreadable date has to stay unreadable so callers can decide what an
 * unknown means for their own check, rather than inheriting a fabricated one.
 */
export function parseEquifaxDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{8}$/.test(raw)) return null
  const month = Number(raw.slice(0, 2))
  const day = Number(raw.slice(2, 4))
  const year = Number(raw.slice(4, 8))
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  // Rejects a real-looking but impossible date such as 02302026, which JS would roll forward.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

function rateCode(trade: EquifaxTrade): number | null {
  const code = Number(trade?.rate?.code)
  return Number.isFinite(code) ? code : null
}

/** How many accounts carry a delinquency mark, under the chosen reading of "delinquent". */
export function countDelinquentTrades(report: EquifaxReport, mode: DelinquencyMode): number {
  return report.trades.filter((trade) => {
    const code = rateCode(trade)
    if (code == null) return false
    if (CURRENT_DELINQUENT_CODES.has(code)) return true
    return mode === 'ever' && HISTORICAL_DELINQUENT_CODES.has(code)
  }).length
}

/**
 * Inquiries within the last `days`. An inquiry whose date cannot be read is NOT counted:
 * rejecting a lead needs evidence, and an unreadable date is not evidence.
 */
export function countRecentInquiries(report: EquifaxReport, days: number, now: Date): number {
  const cutoff = now.getTime() - days * 86_400_000
  return report.inquiries.filter((inquiry) => {
    const date = parseEquifaxDate(inquiry?.inquiryDate)
    return date != null && date.getTime() >= cutoff
  }).length
}

/**
 * How many separate credit-shopping EPISODES the consumer had in the lookback period.
 *
 * Achieve's inquiry rule consolidates mortgage and auto inquiries before counting, because
 * several lenders pulled for ONE purchase should not count as several applications. Their
 * consolidation is described by lender type, but the industry code on a real report cannot
 * support that (see EquifaxInquiry.industryCode): auto spans dealerships and captive finance
 * arms across at least three codes that also contain personal lenders, and mortgage barely
 * appears. So this approximates the same intent the way the credit bureaus themselves do it,
 * by TIME: inquiries closer together than `windowDays` belong to one shopping episode.
 *
 * Measured on 525 live reports: of the 57 leads with more than 5 raw inquiries, the median has
 * only 3 episodes and 40% have just one or two, so counting raw inquiries rejects people who
 * made a single shopping trip. Only 4 of the 57 had five or more genuinely separate episodes.
 *
 * The gap is measured between CONSECUTIVE inquiries, not against the first one, so a steady run
 * of visits stays one continuing episode. Inquiries are sorted first, because report order is
 * not guaranteed and an unsorted read would split one burst into several.
 */
export function countInquiryEpisodes(
  report: EquifaxReport,
  windowDays: number,
  lookbackDays: number,
  now: Date
): number {
  const cutoff = now.getTime() - lookbackDays * 86_400_000
  const times = report.inquiries
    .map((inquiry) => parseEquifaxDate(inquiry?.inquiryDate))
    .filter((date): date is Date => date != null && date.getTime() >= cutoff)
    .map((date) => date.getTime())
    .sort((a, b) => a - b)

  if (times.length === 0) return 0

  const windowMs = windowDays * 86_400_000
  let episodes = 1
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > windowMs) episodes++
  }
  return episodes
}

/**
 * Total scheduled monthly payment across the accounts the consumer is actually servicing,
 * which is the numerator a debt-to-income ratio needs. Divide by monthly gross income for DTI.
 *
 * Counts an account only when it is still being paid: a charge-off is no longer a monthly
 * obligation, and a settled account keeps its old payment figure on the report, so including
 * either would inflate the total with money the person does not pay.
 *
 * Returns null when the file carries no accounts at all, which is NOT the same as zero. That
 * differs from the bankruptcy case on purpose: an undateable filing is evidence of a filing and
 * counts against the lead, whereas an empty account list is an absence of evidence of debt, and
 * a DTI ceiling exists to catch people paying too much rather than people with no accounts.
 *
 * One known understatement, worth knowing before the number is trusted as a lender's DTI: RENT
 * does not appear on a credit report, so a renter's true obligations are higher than this. A
 * mortgage does appear, as an ordinary account. Measured on 537 live leads the median came out
 * at 14% of income with a 90th percentile of 44.7%, so understatement pushes leads UNDER a
 * ceiling rather than over it, which sends leads the partner may decline rather than excluding
 * leads we should have sent.
 */
export function monthlyDebtPayments(report: EquifaxReport): number | null {
  if (report.trades.length === 0) return null

  let total = 0
  for (const trade of report.trades) {
    const code = rateCode(trade)
    if (code === 9) continue // charged off, not being paid

    const balance = Number(trade?.balance)
    if (!Number.isFinite(balance) || balance <= 0) continue // nothing left owing

    const payment = Number(trade?.scheduledPaymentAmount)
    if (!Number.isFinite(payment) || payment <= 0) continue

    total += payment
  }
  return total
}

/**
 * Whole months since the MOST RECENT bankruptcy filing.
 *
 * Returns null when the consumer has no bankruptcy on file, and BANKRUPTCY_DATE_UNKNOWN when
 * one is on file but undateable. Those are different facts: folding the second into null
 * would let a lead through as though it had never filed.
 */
export function monthsSinceLatestBankruptcy(report: EquifaxReport, now: Date): number | null {
  if (report.bankruptcies.length === 0) return null

  const filings = report.bankruptcies
    .map((bankruptcy) => parseEquifaxDate(bankruptcy?.dateFiled))
    .filter((date): date is Date => date != null)
  if (filings.length === 0) return BANKRUPTCY_DATE_UNKNOWN

  const latest = new Date(Math.max(...filings.map((date) => date.getTime())))
  const months =
    (now.getUTCFullYear() - latest.getUTCFullYear()) * 12 + (now.getUTCMonth() - latest.getUTCMonth())
  return Math.max(0, months)
}
