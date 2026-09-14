/**
 * The credit figures behind Achieve's decline reasons, derived from the report we already
 * pull, so a lead's outcome can be compared against what their underwriting reacts to.
 *
 * Achieve return no reason on a decline: every one of their "didn't qualify" responses is the
 * same five fields, while their duplicate responses do carry a response_details array. The
 * reason statements they sent by hand on 2026-09-14 are all credit file factors (inquiries,
 * balance to limit, derogatory records, time since newest account, installment paydown), and
 * every one is computable from the report in hand. Recording them per send is what makes the
 * accept and decline populations comparable later.
 *
 * Field shapes measured against 200 live trades and 300 live reports on 2026-09-14:
 *
 *   1. `portfolioTypeCode` is an OBJECT carrying a `code`, like `rate` and unlike
 *      `industryCode`. Read as a plain string it is undefined, which classifies every account
 *      as not revolving and reports a null utilisation on every file, silently.
 *   2. Revolving accounts (R) all carried a `creditLimit`, 62 of 62. Installment accounts (I)
 *      carried none, 0 of 123, which is correct rather than missing: a loan has no limit. So
 *      utilisation needs no fallback denominator, and installment accounts must be excluded
 *      rather than folded in at a zero limit.
 *   3. There is no public records section. `collections` appears on 74 of 300 reports and
 *      `bankruptcies` on 28, and together they are the whole of "derogatory public record or
 *      collection filed".
 *   4. An absent section means the consumer has none, verified across 400 reports, so counts
 *      are zero rather than null. Only a value that could not be READ stays null.
 */

import { parseEquifaxDate, type EquifaxReport, type EquifaxTrade } from './achieve-credit-report'

/** Portfolio codes that carry a credit limit and revolve. C is a line of credit. */
const REVOLVING_CODES = new Set(['R', 'C'])
const INSTALLMENT_CODES = new Set(['I'])

export interface CreditMetrics {
  vantage_score: number | null
  revolving_balance: number
  revolving_limit: number
  revolving_utilisation: number | null
  total_accounts: number
  open_accounts: number
  /** Closed revolving accounts, excluded from utilisation. Recorded so the exclusion is
   *  auditable rather than invisible in the ratio. */
  closed_revolving_accounts: number
  months_since_newest_account: number | null
  months_since_oldest_account: number | null
  inquiries_6mo: number
  inquiries_12mo: number
  days_since_last_inquiry: number | null
  collections: number
  bankruptcies: number
  months_since_major_delinquency: number | null
  installment_original: number
  installment_balance: number
  installment_paydown_ratio: number | null
  /** Balances and limits that were absent or could not be read as numbers. They are summed as
   *  zero, which is indistinguishable from a real zero and skews utilisation, so a row
   *  computed from less than the whole file has to say so rather than read as clean (L50). */
  unreadable_amounts: number
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function portfolioCode(trade: EquifaxTrade): string | null {
  const code = trade.portfolioTypeCode?.code
  return typeof code === 'string' ? code.toUpperCase() : null
}

function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  )
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

/** Dates that parsed, newest first. Unreadable ones are dropped rather than guessed at. */
function readableDates(values: unknown[]): Date[] {
  return values
    .map(parseEquifaxDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())
}

export function deriveCreditMetrics(report: EquifaxReport, now: Date): CreditMetrics {
  const trades = report.trades ?? []

  let revolvingBalance = 0
  let revolvingLimit = 0
  let installmentOriginal = 0
  let installmentBalance = 0
  let openAccounts = 0
  let closedRevolving = 0
  let unreadable = 0

  /**
   * Zero for the sum, and counted, so the shortfall is visible rather than silent.
   *
   * Absent counts as well as unparseable: a revolving account with no creditLimit is
   * anomalous (all 62 measured carried one) and it skews utilisation exactly as much as a
   * value that could not be read. Both leave the ratio computed from less than the file.
   */
  const amount = (value: unknown): number => {
    const n = num(value)
    if (n === null) {
      unreadable += 1
      return 0
    }
    return n
  }

  for (const trade of trades) {
    const code = portfolioCode(trade)
    const balance = amount(trade.balance)

    const open = trade.closedDate === undefined

    // Open accounts only, for both ratios. A closed card keeps its limit and carries no
    // balance, so counting it inflates the denominator and understates utilisation: measured
    // across 174 live revolving accounts, 51 of them closed, including them gives 0.43
    // against 0.66. A settled loan likewise reads as 100% paid down and would drag the
    // paydown ratio up. Both errors run in the flattering direction, and their own reason
    // code says "recently active installment loans".
    if (code && REVOLVING_CODES.has(code)) {
      if (open) {
        revolvingBalance += balance
        revolvingLimit += amount(trade.creditLimit)
      } else {
        closedRevolving += 1
      }
    }
    if (code && INSTALLMENT_CODES.has(code) && open) {
      installmentBalance += balance
      installmentOriginal += amount(trade.highCredit)
    }
    if (open) openAccounts += 1
  }

  const openedDates = readableDates(trades.map((t) => t.dateOpened))
  const inquiryDates = readableDates((report.inquiries ?? []).map((i) => i.inquiryDate))
  const delinquencyDates = readableDates(trades.map((t) => t.dateMajorDelinquencyFirstReported))

  return {
    vantage_score: report.score,

    revolving_balance: revolvingBalance,
    revolving_limit: revolvingLimit,
    // Null rather than zero where there is no revolving credit at all: somebody with no cards
    // and somebody with cards they never use are different people, and a zero would merge them.
    revolving_utilisation: revolvingLimit > 0 ? revolvingBalance / revolvingLimit : null,

    total_accounts: trades.length,
    open_accounts: openAccounts,
    closed_revolving_accounts: closedRevolving,
    months_since_newest_account: openedDates.length ? monthsBetween(openedDates[0], now) : null,
    months_since_oldest_account: openedDates.length
      ? monthsBetween(openedDates[openedDates.length - 1], now)
      : null,

    inquiries_6mo: inquiryDates.filter((d) => monthsBetween(d, now) < 6).length,
    inquiries_12mo: inquiryDates.filter((d) => monthsBetween(d, now) < 12).length,
    days_since_last_inquiry: inquiryDates.length ? daysBetween(inquiryDates[0], now) : null,

    collections: (report.collections ?? []).length,
    bankruptcies: (report.bankruptcies ?? []).length,
    months_since_major_delinquency: delinquencyDates.length
      ? monthsBetween(delinquencyDates[0], now)
      : null,

    installment_original: installmentOriginal,
    installment_balance: installmentBalance,
    installment_paydown_ratio:
      installmentOriginal > 0 ? (installmentOriginal - installmentBalance) / installmentOriginal : null,

    unreadable_amounts: unreadable,
  }
}
