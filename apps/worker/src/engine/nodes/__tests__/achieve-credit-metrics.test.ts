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

  describe('installment paydown', () => {
    // "Amount paid down on recently active installment loans is low" is theirs. The figure is
    // how much of the original has been repaid, so it needs both sides.
    it('measures the share of installment original amounts repaid', () => {
      const m = deriveCreditMetrics(
        report({ trades: [installment(6000, 10000), installment(2000, 10000)] }),
        NOW
      )
      expect(m.installment_original).toBe(20000)
      expect(m.installment_balance).toBe(8000)
      expect(m.installment_paydown_ratio).toBeCloseTo(0.6, 4)
    })

    it('reports a null paydown ratio when there are no installment accounts', () => {
      const m = deriveCreditMetrics(report({ trades: [revolving(1, 2)] }), NOW)
      expect(m.installment_paydown_ratio).toBeNull()
    })
  })

  it('carries the score through', () => {
    expect(deriveCreditMetrics(report({ score: 645 }), NOW).vantage_score).toBe(645)
  })
})
