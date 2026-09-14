import { describe, it, expect } from 'vitest'
import { deriveCreditMetrics } from '../achieve-credit-metrics'
import type { EquifaxReport } from '../achieve-credit-report'

const NOW = new Date('2026-09-14T12:00:00Z')

// Dates are EIGHT DIGITS, MMDDYYYY. Read year first, '09142025' becomes the year 914, which
// makes every recency measure enormous rather than failing, so the fixtures use real values
// and the tests assert the month counts rather than mere presence.
const report = (over: Partial<EquifaxReport> = {}): EquifaxReport => ({
  trades: [],
  inquiries: [],
  bankruptcies: [],
  collections: [],
  score: 700,
  ...over,
})

// portfolioTypeCode is an OBJECT carrying a code, exactly like `rate` and unlike
// `industryCode`. Reading it as a plain string yields undefined, which silently classifies
// every account as not revolving and reports a utilisation of null on every file.
const revolving = (balance: number, creditLimit: number, dateOpened = '01152020') => ({
  portfolioTypeCode: { code: 'R' },
  balance,
  creditLimit,
  dateOpened,
})

const installment = (balance: number, highCredit: number, dateOpened = '01152020') => ({
  portfolioTypeCode: { code: 'I' },
  balance,
  highCredit,
  dateOpened,
})

describe('deriveCreditMetrics', () => {
  describe('revolving utilisation', () => {
    // Measured on 200 live trades: all 62 revolving accounts carried a creditLimit and none
    // of the 123 installment accounts did. So the denominator is the limit, with no fallback,
    // and installment accounts must be excluded rather than counted at zero limit.
    it('divides revolving balance by revolving limit', () => {
      const m = deriveCreditMetrics(
        report({ trades: [revolving(500, 1000), revolving(1500, 3000)] }),
        NOW
      )
      expect(m.revolving_balance).toBe(2000)
      expect(m.revolving_limit).toBe(4000)
      expect(m.revolving_utilisation).toBeCloseTo(0.5, 4)
    })

    // Closed cards keep their limit and carry no balance, so counting them inflates the
    // denominator and understates how much of their available credit somebody is using.
    // Measured on 174 live revolving accounts, 51 of them closed: including them gives 0.43
    // against 0.66 for open accounts only, so this is not a rounding difference. Utilisation
    // is the variable their reason codes name most, and the error runs in the flattering
    // direction, which is the one nothing else would have caught.
    it('counts only open revolving accounts, not closed ones', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [
            revolving(900, 1000),
            { ...revolving(0, 9000), closedDate: '06012024' },
          ],
        }),
        NOW
      )
      expect(m.revolving_limit).toBe(1000)
      expect(m.revolving_utilisation).toBeCloseTo(0.9, 4)
      expect(m.closed_revolving_accounts).toBe(1)
    })

    it('excludes installment accounts from utilisation', () => {
      const m = deriveCreditMetrics(
        report({ trades: [revolving(500, 1000), installment(9000, 20000)] }),
        NOW
      )
      expect(m.revolving_limit).toBe(1000)
      expect(m.revolving_utilisation).toBeCloseTo(0.5, 4)
    })

    // A line of credit is revolving for this purpose and carries a limit like one.
    it('counts a line of credit as revolving', () => {
      const m = deriveCreditMetrics(
        report({ trades: [{ portfolioTypeCode: { code: 'C' }, balance: 250, creditLimit: 1000, dateOpened: '01152020' }] }),
        NOW
      )
      expect(m.revolving_utilisation).toBeCloseTo(0.25, 4)
    })

    // Null rather than Infinity or zero: a file with no revolving credit has no utilisation,
    // and reporting 0 would put it alongside somebody who has credit and uses none of it.
    it('reports null utilisation when there is no revolving limit at all', () => {
      const m = deriveCreditMetrics(report({ trades: [installment(9000, 20000)] }), NOW)
      expect(m.revolving_limit).toBe(0)
      expect(m.revolving_utilisation).toBeNull()
    })
  })

  describe('account ages and counts', () => {
    it('counts open accounts as those with no closedDate', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [
            revolving(100, 1000),
            { ...installment(0, 5000), closedDate: '06012024' },
          ],
        }),
        NOW
      )
      expect(m.total_accounts).toBe(2)
      expect(m.open_accounts).toBe(1)
    })

    // "Time since most recent account opening is too short" is one of their reason codes, so
    // the newest account's age is the figure that matters, not the average.
    it('measures months since the newest and the oldest account opened', () => {
      const m = deriveCreditMetrics(
        report({ trades: [revolving(100, 1000, '09142016'), revolving(200, 2000, '03142026')] }),
        NOW
      )
      expect(m.months_since_newest_account).toBe(6)
      expect(m.months_since_oldest_account).toBe(120)
    })

    it('leaves account ages null when no date can be read', () => {
      const m = deriveCreditMetrics(
        report({ trades: [{ portfolioTypeCode: { code: 'R' }, balance: 1, creditLimit: 2, dateOpened: 'not a date' }] }),
        NOW
      )
      expect(m.months_since_newest_account).toBeNull()
      expect(m.months_since_oldest_account).toBeNull()
    })
  })

  describe('inquiries', () => {
    // They ask about both windows in separate reason codes, so both are recorded rather than
    // one being derived from the other.
    it('counts inquiries in the last 6 and 12 months and the days since the most recent', () => {
      const m = deriveCreditMetrics(
        report({
          inquiries: [
            { inquiryDate: '09042026' },
            { inquiryDate: '05142026' },
            { inquiryDate: '11142025' },
            { inquiryDate: '01142024' },
          ],
        }),
        NOW
      )
      expect(m.inquiries_6mo).toBe(2)
      expect(m.inquiries_12mo).toBe(3)
      expect(m.days_since_last_inquiry).toBe(10)
    })

    it('reports zero inquiries and a null recency when the section is absent', () => {
      const m = deriveCreditMetrics(report(), NOW)
      expect(m.inquiries_6mo).toBe(0)
      expect(m.inquiries_12mo).toBe(0)
      expect(m.days_since_last_inquiry).toBeNull()
    })
  })

  describe('derogatory marks', () => {
    // Their reason codes say "derogatory public record or collection filed". The report has
    // no public records section at all: collections appear on 74 of 300 files and
    // bankruptcies on 28, and those two are the whole of it.
    it('counts collections and bankruptcies separately', () => {
      const m = deriveCreditMetrics(
        report({ collections: [{}, {}], bankruptcies: [{ dateFiled: '01012020' }] }),
        NOW
      )
      expect(m.collections).toBe(2)
      expect(m.bankruptcies).toBe(1)
    })

    // An absent section is a real none, verified across 400 reports, not an unpurchased field.
    it('reports zero for absent sections rather than null', () => {
      const m = deriveCreditMetrics(report(), NOW)
      expect(m.collections).toBe(0)
      expect(m.bankruptcies).toBe(0)
    })

    it('measures months since the most recent major delinquency', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [
            { ...revolving(100, 1000), dateMajorDelinquencyFirstReported: '03142026' },
            { ...revolving(100, 1000), dateMajorDelinquencyFirstReported: '09142024' },
          ],
        }),
        NOW
      )
      expect(m.months_since_major_delinquency).toBe(6)
    })
  })

  describe('installment balances', () => {
    // There is deliberately NO paydown ratio. It assumed highCredit is the original advance,
    // and on live data it is not: across 63 open installment loans, 31 carried a balance
    // LARGER than their highCredit and the average sat at 0.98 of it, so the ratio was
    // negative for about half the population. The same comparison on revolving accounts
    // behaves correctly (1 of 110 above the limit, averaging 0.66), which is what shows the
    // field means something different on a loan. The raw sums stay because they are factual
    // whatever highCredit turns out to mean; the ratio asserted something they do not support.
    it('records the sums without deriving a paydown ratio from them', () => {
      const m = deriveCreditMetrics(
        report({ trades: [installment(6000, 10000), installment(2000, 10000)] }),
        NOW
      )
      expect(m.installment_original).toBe(20000)
      expect(m.installment_balance).toBe(8000)
      expect(m).not.toHaveProperty('installment_paydown_ratio')
    })

    it('counts only open installment loans, so a settled one is not summed in', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [installment(8000, 10000), { ...installment(0, 50000), closedDate: '06012024' }],
        }),
        NOW
      )
      expect(m.installment_original).toBe(10000)
      expect(m.installment_balance).toBe(8000)
    })
  })

  // These three were lost once already: the paydown removal in #1345 spliced between two text
  // anchors and took them with it, and the suite went 19 tests to 16 while reading as green.
  describe('amounts it could not read', () => {
    // An absent or unparseable amount is summed as zero, because a NaN would poison the whole
    // sum. That makes it indistinguishable from a real zero and skews the ratios in the
    // flattering direction (L50), so the row says how many it could not read.
    it('counts the amounts it could not read', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [
            { portfolioTypeCode: { code: 'R' }, balance: 'n/a', creditLimit: 1000, dateOpened: '01152020' },
            { portfolioTypeCode: { code: 'R' }, balance: 500, dateOpened: '01152020' },
            revolving(100, 1000),
          ],
        }),
        NOW
      )
      expect(m.unreadable_amounts).toBe(2)
    })

    it('reports zero unreadable amounts on a clean file', () => {
      expect(deriveCreditMetrics(report({ trades: [revolving(100, 1000)] }), NOW).unreadable_amounts).toBe(0)
    })

    // It must count only amounts that FEED a metric. A closed card and a mortgage contribute
    // to nothing, so a missing balance on either leaves every figure in the row complete.
    // Seen on a live lead on 2026-09-14: 28 accounts, 11 of them closed revolving, every ratio
    // correct, and the flag fired on 1. A flag that fires on healthy rows is one an analyst
    // learns to ignore, which is the outcome it exists to prevent.
    it('ignores amounts on accounts that feed no metric', () => {
      const m = deriveCreditMetrics(
        report({
          trades: [
            revolving(500, 1000),
            { portfolioTypeCode: { code: 'R' }, creditLimit: 9000, dateOpened: '01152020', closedDate: '06012024' },
            { portfolioTypeCode: { code: 'M' }, dateOpened: '01152020' },
          ],
        }),
        NOW
      )
      expect(m.revolving_utilisation).toBeCloseTo(0.5, 4)
      expect(m.unreadable_amounts).toBe(0)
    })
  })

  it('carries the score through', () => {
    expect(deriveCreditMetrics(report({ score: 645 }), NOW).vantage_score).toBe(645)
  })
})
