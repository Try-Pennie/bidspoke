import { describe, it, expect } from 'vitest'
import {
  findEquifaxReport,
  parseEquifaxDate,
  countDelinquentTrades,
  countRecentInquiries,
  monthsSinceLatestBankruptcy,
  monthlyDebtPayments,
  countInquiryEpisodes,
} from '../achieve-credit-report'
import type { ExecutionContext } from '../../../types'

// Every fixture below is shaped from a REAL report observed in production on 2026-08-17
// (measured across 500 live Equifax pulls), not invented: the account rating is an object
// holding a numeric code, dates are eight digits in MMDDYYYY order, and Main Flow nests
// the report one level deeper than the Engine workflow does. Each of those three returns
// nothing at all when read wrong, so each has its own test.

function ctxWithStep(output: unknown, namespace = 'equifax_credit_report'): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'w', trace_id: 't', org_id: 'o' },
    steps: { [namespace]: { status: 'completed', output } },
    env: {},
  } as unknown as ExecutionContext
}

function report(parts: Record<string, unknown> = {}) {
  return { models: [{ score: '612' }], trades: [], inquiries: [], ...parts }
}

/** Engine workflow shape: consumers at the top level of the step output. */
function engineShape(rep: unknown) {
  return { consumers: { equifaxUSConsumerCreditReport: rep }, status: 'ok' }
}

/** Main Flow shape: the same report wrapped one level deeper under `data`. */
function mainFlowShape(rep: unknown) {
  return { data: { consumers: { equifaxUSConsumerCreditReport: rep }, status: 'ok' }, error: null, statusCode: 200 }
}

function trade(rateCode: number | null) {
  return rateCode == null ? { balance: 100 } : { balance: 100, rate: { code: rateCode } }
}

describe('findEquifaxReport', () => {
  it('finds the report in the Main Flow shape, nested under data', () => {
    const found = findEquifaxReport(ctxWithStep(mainFlowShape(report({ trades: [trade(1)] }))))
    expect(found?.trades).toHaveLength(1)
  })

  it('finds the report in the Engine shape, at the top level', () => {
    const found = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(1)] }))))
    expect(found?.trades).toHaveLength(1)
  })

  // Equifax returns the report as a single object on some pulls and a one-element array on
  // others. A reader written for one silently returns nothing for the other.
  it('accepts the report as a bare object or as an array', () => {
    const asArray = findEquifaxReport(ctxWithStep(engineShape([report({ trades: [trade(2)] })])))
    expect(asArray?.trades).toHaveLength(1)
  })

  it('returns null when the credit-pull step never ran', () => {
    expect(findEquifaxReport(ctxWithStep(undefined, 'some_other_step'))).toBeNull()
  })

  // An Equifax failure comes back as a populated envelope with no report inside. That must
  // read as "no report", never as an empty-but-valid report, because an empty report would
  // silently pass every credit-based check.
  it('returns null when the call failed and carries no report', () => {
    const failed = { data: null, error: 'ACRO_GATEWAY timeout', statusCode: 502 }
    expect(findEquifaxReport(ctxWithStep(failed))).toBeNull()
  })

  it('reads sections that are absent as empty rather than throwing', () => {
    const found = findEquifaxReport(ctxWithStep(engineShape({ models: [{ score: '600' }] })))
    expect(found).not.toBeNull()
    expect(found?.trades).toEqual([])
    expect(found?.bankruptcies).toEqual([])
  })
})

describe('parseEquifaxDate', () => {
  it('parses eight digits as month, day, year', () => {
    const d = parseEquifaxDate('07092026')
    expect(d?.toISOString().slice(0, 10)).toBe('2026-07-09')
  })

  // Read as YYYYMMDD this would be a year 707 date and every recency test would pass.
  it('does not read the value as year-first', () => {
    const d = parseEquifaxDate('07092026')
    expect(d?.getUTCFullYear()).toBe(2026)
  })

  it('rejects an ISO date, which is a different field format', () => {
    expect(parseEquifaxDate('2026-07-09')).toBeNull()
  })

  it('rejects impossible and malformed values instead of inventing a date', () => {
    expect(parseEquifaxDate('99999999')).toBeNull()
    expect(parseEquifaxDate('0709202')).toBeNull()
    expect(parseEquifaxDate('')).toBeNull()
    expect(parseEquifaxDate(undefined)).toBeNull()
    expect(parseEquifaxDate(20260709)).toBeNull()
  })
})

describe('countDelinquentTrades', () => {
  // Measured on 500 live reports: files whose ONLY bad-looking code is 6 average a score of
  // 633, and fully clean files average 632. Code 6 therefore does NOT behave like
  // delinquency, and counting it would flag 54% of files as delinquent while those people
  // score as well as clean ones. Codes 2 to 5 average 580, a real 52-point drop.
  it('ignores code 6, which scores the same as a clean file', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(6), trade(6)] }))))!
    expect(countDelinquentTrades(rep, 'current')).toBe(0)
    expect(countDelinquentTrades(rep, 'ever')).toBe(0)
  })

  it('ignores clean and too-new ratings', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(0), trade(1), trade(null)] }))))!
    expect(countDelinquentTrades(rep, 'current')).toBe(0)
  })

  it('counts currently past-due accounts in current mode', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(2), trade(3), trade(1)] }))))!
    expect(countDelinquentTrades(rep, 'current')).toBe(2)
  })

  // A charge-off is a historical mark, not a current past-due, so the two modes must
  // genuinely differ. If they returned the same number the mode setting would be inert.
  it('excludes charge-offs and repossessions from current but counts them in ever', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(9), trade(8)] }))))!
    expect(countDelinquentTrades(rep, 'current')).toBe(0)
    expect(countDelinquentTrades(rep, 'ever')).toBe(2)
  })

  // Code 7 is a court-supervised repayment plan, concentrated on 8 of 500 live reports.
  it('ignores code 7 in both modes', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ trades: [trade(7)] }))))!
    expect(countDelinquentTrades(rep, 'current')).toBe(0)
    expect(countDelinquentTrades(rep, 'ever')).toBe(0)
  })
})

describe('inquiry industry code shape', () => {
  // Pins the REAL shape, because the two neighbouring fields disagree and nothing else catches
  // it: an inquiry's industryCode is a plain string ('AN'), while a trade's rate is an OBJECT
  // with a numeric code. Reading either as the other yields undefined rather than an error, so a
  // first attempt at grouping inquiries by industry silently matched nothing and produced a
  // confident but meaningless number. Codes here are real values observed in production.
  it('carries the industry code as a plain string, not an object', () => {
    const rep = findEquifaxReport(
      ctxWithStep(
        engineShape(
          report({
            inquiries: [
              { inquiryDate: '07092026', industryCode: 'AN' },
              { inquiryDate: '07092026', industryCode: 'FA' },
            ],
          })
        )
      )
    )!
    expect(rep.inquiries.map((i) => i.industryCode)).toEqual(['AN', 'FA'])
    // The nested read that looks plausible and is wrong. Asserted so the difference is explicit
    // rather than something the next reader has to rediscover.
    expect((rep.inquiries[0].industryCode as unknown as { code?: string }).code).toBeUndefined()
  })

  it('keeps a trade rate as an object, so the two shapes cannot be conflated', () => {
    const rep = findEquifaxReport(
      ctxWithStep(engineShape(report({ trades: [{ rate: { code: 2 }, balance: 100 }] })))
    )!
    expect(rep.trades[0].rate).toEqual({ code: 2 })
    expect(countDelinquentTrades(rep, 'current')).toBe(1)
  })
})

describe('countRecentInquiries', () => {
  const NOW = new Date('2026-08-17T00:00:00Z')

  it('counts only inquiries inside the window', () => {
    const rep = findEquifaxReport(
      ctxWithStep(
        engineShape(
          report({
            inquiries: [
              { inquiryDate: '08012026', industryCode: { code: 'BC' } },
              { inquiryDate: '07092026', industryCode: { code: 'BC' } },
              { inquiryDate: '01052025', industryCode: { code: 'BC' } },
            ],
          })
        )
      )
    )!
    expect(countRecentInquiries(rep, 180, NOW)).toBe(2)
  })

  // An unparseable date must not be counted as recent: that would reject a lead on
  // evidence we could not read.
  it('does not count an inquiry whose date cannot be read', () => {
    const rep = findEquifaxReport(
      ctxWithStep(engineShape(report({ inquiries: [{ inquiryDate: 'unknown' }, { inquiryDate: '' }] })))
    )!
    expect(countRecentInquiries(rep, 180, NOW)).toBe(0)
  })
})

describe('monthlyDebtPayments', () => {
  // Measured on 537 live leads: average total of $1,142 a month, median DTI 14%, 90th
  // percentile 44.7%. Achieve's 60% ceiling therefore sits out in the tail rather than
  // through the dense middle, and removes about 4.5% of leads.
  function tradeWith(over: Record<string, unknown>) {
    return { rate: { code: 1 }, balance: 5000, scheduledPaymentAmount: 100, ...over }
  }
  const build = (trades: unknown[]) =>
    findEquifaxReport(ctxWithStep(engineShape(report({ trades }))))!

  it('sums the scheduled monthly payment across accounts still being paid', () => {
    expect(monthlyDebtPayments(build([tradeWith({}), tradeWith({ scheduledPaymentAmount: 429 })]))).toBe(529)
  })

  // A charge-off is no longer a monthly obligation, so counting it would overstate what the
  // person actually pays each month and reject them for debt they are not servicing.
  it('excludes charged-off accounts', () => {
    expect(monthlyDebtPayments(build([tradeWith({ rate: { code: 9 } })]))).toBe(0)
  })

  // A settled account keeps its old payment figure on the report. Counting it would inflate
  // the total with a payment the person no longer makes.
  it('excludes accounts with no balance left', () => {
    expect(monthlyDebtPayments(build([tradeWith({ balance: 0 }), tradeWith({ balance: null })]))).toBe(0)
  })

  it('ignores missing or unreadable payment figures rather than counting them as zero-cost', () => {
    expect(monthlyDebtPayments(build([tradeWith({ scheduledPaymentAmount: undefined }), tradeWith({})]))).toBe(100)
  })

  it('returns zero when accounts exist but none are being paid', () => {
    expect(monthlyDebtPayments(build([tradeWith({ balance: 0 })]))).toBe(0)
  })

  // Distinct from the bankruptcy case, where an undateable filing is EVIDENCE of a filing and
  // so counts against the lead. Here there is no evidence of debt at all, and a DTI ceiling
  // exists to catch people paying too much, not people with no accounts.
  it('returns null when the file carries no accounts at all, which is not the same as zero', () => {
    expect(monthlyDebtPayments(build([]))).toBeNull()
  })
})

describe('countInquiryEpisodes', () => {
  const NOW = new Date('2026-08-17T00:00:00Z')
  const on = (date: string) => ({ inquiryDate: date })
  const build = (inquiries: unknown[]) =>
    findEquifaxReport(ctxWithStep(engineShape(report({ inquiries }))))!

  // Rate shopping: several lenders pulled for ONE purchase. Achieve's rule consolidates these
  // before counting, and the credit bureaus themselves de-duplicate by TIME rather than by
  // lender type. Measured on 525 live reports: of the 57 leads with more than 5 raw inquiries,
  // the median has only 3 episodes and 40% have just one or two, so counting raw inquiries
  // rejects people who made a single shopping trip.
  it('counts a burst of inquiries inside the window as one episode', () => {
    expect(countInquiryEpisodes(build([on('07012026'), on('07032026'), on('07092026')]), 14, 180, NOW)).toBe(1)
  })

  it('counts inquiries further apart than the window as separate episodes', () => {
    expect(countInquiryEpisodes(build([on('05012026'), on('06152026'), on('08012026')]), 14, 180, NOW)).toBe(3)
  })

  // The gap is measured between CONSECUTIVE inquiries, so a long steady run of visits every ten
  // days is one continuing episode rather than many. Asserted because measuring each inquiry
  // against the first one instead would split it, and both readings look reasonable in prose.
  it('treats a continuous run of close inquiries as a single episode', () => {
    expect(countInquiryEpisodes(build([on('07012026'), on('07102026'), on('07192026'), on('07282026')]), 14, 180, NOW)).toBe(1)
  })

  it('ignores inquiries outside the lookback period', () => {
    expect(countInquiryEpisodes(build([on('01012025'), on('07012026')]), 14, 180, NOW)).toBe(1)
  })

  it('reports no episodes when there are no readable inquiries', () => {
    expect(countInquiryEpisodes(build([]), 14, 180, NOW)).toBe(0)
    expect(countInquiryEpisodes(build([{ inquiryDate: 'nonsense' }]), 14, 180, NOW)).toBe(0)
  })

  // Order is not guaranteed in the report. This fixture interleaves two distant bursts, which is
  // the shape that actually diverges: read in the given order it counts three episodes, and
  // sorted it counts the two that are really there. A first version of this test used three
  // dates within one window, where both readings agree, so it passed while proving nothing.
  it('does not depend on the order the inquiries arrive in', () => {
    const interleaved = build([on('03012026'), on('08012026'), on('03052026'), on('08052026')])
    expect(countInquiryEpisodes(interleaved, 14, 180, NOW)).toBe(2)
  })

  // A wider window merges more, so the window genuinely changes the answer. If it did not, the
  // parameter would be inert and its value would never matter.
  it('merges more when the window widens', () => {
    const spread = build([on('07012026'), on('07202026')])
    expect(countInquiryEpisodes(spread, 14, 180, NOW)).toBe(2)
    expect(countInquiryEpisodes(spread, 30, 180, NOW)).toBe(1)
  })
})

describe('monthsSinceLatestBankruptcy', () => {
  const NOW = new Date('2026-08-17T00:00:00Z')

  it('returns null when the report carries no bankruptcy section', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report())))!
    expect(monthsSinceLatestBankruptcy(rep, NOW)).toBeNull()
  })

  it('measures from the most recent filing when there are several', () => {
    const rep = findEquifaxReport(
      ctxWithStep(
        engineShape(
          report({
            bankruptcies: [{ dateFiled: '01152015' }, { dateFiled: '06012024' }],
          })
        )
      )
    )!
    // June 2024 to August 2026 is 26 months, not the 139 the older filing would give.
    expect(monthsSinceLatestBankruptcy(rep, NOW)).toBe(26)
  })

  // A filing we cannot date is not the same as no filing. Returning null here would let the
  // lead through as if it had never had a bankruptcy.
  it('reports an undateable filing as present but unknown, not as absent', () => {
    const rep = findEquifaxReport(ctxWithStep(engineShape(report({ bankruptcies: [{ dateFiled: 'garbage' }] }))))!
    expect(monthsSinceLatestBankruptcy(rep, NOW)).toBe(-1)
  })
})
