import { describe, it, expect } from 'vitest'
import { screenLead, ACHIEVE_SCREEN_REASONS } from '../achieve-screen'
import type { ExecutionContext } from '../../../types'

const NOW = new Date('2026-08-17T00:00:00Z')

// Achieve's own state list (Evan Raciti, 2026-07-15). Deliberately spelled out here rather
// than imported, so a change to the shipped list has to be made twice on purpose.
const ACHIEVE_STATES =
  'AK,AL,AR,AZ,CA,DE,DC,FL,GA,IL,IN,ID,KS,KY,LA,MA,MD,MI,MN,MO,MS,MT,ND,NC,NE,NH,NJ,NM,NV,NY,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VA'

/** Every threshold switched on, at the values Achieve asked for. */
const ALL_FILTERS_ON = {
  ACHIEVE_MIN_LOAN_AMOUNT: '10000',
  ACHIEVE_MAX_LOAN_AMOUNT: '50000',
  ACHIEVE_ALLOWED_STATES: ACHIEVE_STATES,
  ACHIEVE_MAX_LOAN_TO_INCOME: '0.35',
  ACHIEVE_MIN_VANTAGE_SCORE: '560',
  ACHIEVE_MAX_CURRENT_DELINQUENCIES: '0',
  ACHIEVE_MIN_MONTHS_SINCE_BANKRUPTCY: '48',
  ACHIEVE_MAX_INQUIRY_EPISODES_6MO: '5',
  ACHIEVE_MIN_AGE: '18',
  ACHIEVE_MAX_DTI: '0.60',
}

function payload(over: Record<string, unknown> = {}) {
  return {
    personalInformation: { state: 'NY', dateOfBirth: '1985-04-02', ...(over.personalInformation ?? {}) },
    loanInformation: { loanAmount: 20000, ...(over.loanInformation ?? {}) },
    financialInformation: { annualIncome: 120000, ...(over.financialInformation ?? {}) },
  }
}

/** A report that passes every credit-based check. */
function cleanReport(over: Record<string, unknown> = {}) {
  return {
    data: {
      consumers: {
        equifaxUSConsumerCreditReport: {
          models: [{ score: '640' }],
          trades: [{ rate: { code: 1 } }],
          inquiries: [{ inquiryDate: '01052024' }],
          ...over,
        },
      },
    },
    statusCode: 200,
  }
}

function ctx(over: {
  payload?: Record<string, unknown>
  env?: Record<string, string>
  report?: unknown
  score?: unknown
  noReportStep?: boolean
} = {}): ExecutionContext {
  // `'score' in over` rather than `??`, so an explicitly null score is honoured. Written as
  // `over.score ?? 640` this helper silently gave a scoreless lead a passing score of 640, and
  // the test asserting that a scoreless lead is refused passed for the wrong reason.
  const steps: Record<string, { status: string; output: unknown }> = {
    gen_vantage_score: { status: 'completed', output: 'score' in over ? over.score : 640 },
  }
  if (!over.noReportStep) {
    steps.equifax_credit_report = { status: 'completed', output: over.report ?? cleanReport() }
  }
  return {
    trigger: { payload: over.payload ?? payload(), source: 'test', workflow_id: 'w', trace_id: 't', org_id: 'o' },
    steps,
    env: over.env ?? ALL_FILTERS_ON,
  } as unknown as ExecutionContext
}

describe('screenLead', () => {
  // The whole set ships INERT. A deploy with no values configured must change nothing about
  // which leads go to Achieve, or the filters arrive as an unannounced outage.
  it('passes everything when no thresholds are configured', () => {
    const verdict = screenLead(ctx({ env: {}, payload: payload({ loanInformation: { loanAmount: 500 } }) }), {}, NOW)
    expect(verdict.pass).toBe(true)
    expect(verdict.reason).toBeUndefined()
  })

  it('passes a lead that satisfies every configured filter', () => {
    const verdict = screenLead(ctx(), {}, NOW)
    expect(verdict.pass).toBe(true)
  })

  // Each criterion below must be SEEN to reject, and to reject with its OWN reason. A shared
  // reason would make the held-back volume unattributable, which is the only measurement
  // left once screening is a hard gate.
  it('rejects a loan amount under the floor', () => {
    const verdict = screenLead(ctx({ payload: payload({ loanInformation: { loanAmount: 9999 } }) }), {}, NOW)
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('loan_amount_below_min')
  })

  it('rejects a loan amount over the ceiling', () => {
    const verdict = screenLead(ctx({ payload: payload({ loanInformation: { loanAmount: 50001 } }) }), {}, NOW)
    expect(verdict.reason).toBe('loan_amount_above_max')
  })

  it('rejects a state Achieve does not lend in', () => {
    const verdict = screenLead(ctx({ payload: payload({ personalInformation: { state: 'WA' } }) }), {}, NOW)
    expect(verdict.reason).toBe('state_not_allowed')
  })

  // Minnesota and Oregon are the two states PENNIE excludes, and Achieve accepts both. The
  // lists genuinely disagree, so this asserts we screen on Achieve's list here, not ours.
  it('allows Minnesota and Oregon, which Achieve accepts and Pennie does not', () => {
    expect(screenLead(ctx({ payload: payload({ personalInformation: { state: 'MN' } }) }), {}, NOW).pass).toBe(true)
    expect(screenLead(ctx({ payload: payload({ personalInformation: { state: 'OR' } }) }), {}, NOW).pass).toBe(true)
  })

  it('rejects a loan too large against the income', () => {
    const verdict = screenLead(
      ctx({ payload: payload({ loanInformation: { loanAmount: 45000 }, financialInformation: { annualIncome: 60000 } }) }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('loan_to_income_too_high')
  })

  it('rejects a score below the floor', () => {
    const verdict = screenLead(ctx({ score: 559 }), {}, NOW)
    expect(verdict.reason).toBe('below_vantage_floor')
  })

  it('rejects a lead with no score at all when a floor is set', () => {
    const verdict = screenLead(ctx({ score: null }), {}, NOW)
    expect(verdict.reason).toBe('below_vantage_floor')
  })

  it('rejects a currently past-due account', () => {
    const verdict = screenLead(ctx({ report: cleanReport({ trades: [{ rate: { code: 3 } }] }) }), {}, NOW)
    expect(verdict.reason).toBe('has_current_delinquency')
  })

  // The default reading is "currently past due", so an old charge-off must NOT reject. This is
  // the setting whose interpretation swings the surviving volume roughly twofold, so both
  // readings need a test that distinguishes them.
  it('allows an old charge-off under the default reading', () => {
    const verdict = screenLead(ctx({ report: cleanReport({ trades: [{ rate: { code: 9 } }] }) }), {}, NOW)
    expect(verdict.pass).toBe(true)
  })

  it('rejects an old charge-off when the reading is set to ever', () => {
    const verdict = screenLead(
      ctx({
        report: cleanReport({ trades: [{ rate: { code: 9 } }] }),
        env: { ...ALL_FILTERS_ON, ACHIEVE_DELINQUENCY_MODE: 'ever' },
      }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('has_current_delinquency')
  })

  it('rejects a bankruptcy filed inside the window', () => {
    const verdict = screenLead(
      ctx({ report: cleanReport({ bankruptcies: [{ dateFiled: '06012024' }] }) }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('recent_bankruptcy')
  })

  it('allows a bankruptcy older than the window', () => {
    const verdict = screenLead(
      ctx({ report: cleanReport({ bankruptcies: [{ dateFiled: '01152015' }] }) }),
      {},
      NOW
    )
    expect(verdict.pass).toBe(true)
  })

  // A filing on record whose date we cannot read must not pass as though it never happened.
  it('rejects a bankruptcy on file whose date cannot be read', () => {
    const verdict = screenLead(
      ctx({ report: cleanReport({ bankruptcies: [{ dateFiled: 'unknown' }] }) }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('recent_bankruptcy')
  })

  // Dates all sit inside the 180-day lookback from NOW. An earlier version of this fixture put
  // the first one just outside it, which quietly left five episodes and passed.
  it('rejects too many separate shopping episodes', () => {
    const inquiries = ['03052026', '04102026', '05202026', '06252026', '07152026', '08052026'].map(
      (inquiryDate) => ({ inquiryDate })
    )
    const verdict = screenLead(ctx({ report: cleanReport({ inquiries }) }), {}, NOW)
    expect(verdict.reason).toBe('too_many_inquiries')
  })

  it('counts only inquiries inside the six-month window', () => {
    const inquiries = Array.from({ length: 6 }, () => ({ inquiryDate: '01052024' }))
    expect(screenLead(ctx({ report: cleanReport({ inquiries }) }), {}, NOW).pass).toBe(true)
  })

  // The point of counting episodes: somebody who pulled six lenders in one week made ONE
  // shopping trip, which is what Achieve's consolidation exists to allow through. Counting the
  // raw inquiries instead would reject them, and measured on live reports that is 40% of the
  // high-inquiry population.
  it('allows six inquiries made in a single week', () => {
    const inquiries = ['08012026', '08022026', '08032026', '08042026', '08052026', '08062026'].map(
      (inquiryDate) => ({ inquiryDate })
    )
    expect(screenLead(ctx({ report: cleanReport({ inquiries }) }), {}, NOW).pass).toBe(true)
  })

  it('rejects a lead who shopped on six separate occasions', () => {
    const inquiries = ['03012026', '04012026', '05012026', '06012026', '07012026', '08012026'].map(
      (inquiryDate) => ({ inquiryDate })
    )
    const verdict = screenLead(ctx({ report: cleanReport({ inquiries }) }), {}, NOW)
    expect(verdict.reason).toBe('too_many_inquiries')
    expect(verdict.detail?.inquiry_episodes).toBe(6)
  })

  // DTI, computed from the scheduled monthly payments on the credit report over the form's
  // annual income. The clean fixture earns $120,000, so $6,000 a month of payments is 60%.
  it('rejects a lead paying more of its income in debt than the ceiling allows', () => {
    const verdict = screenLead(
      ctx({
        report: cleanReport({
          trades: [{ rate: { code: 1 }, balance: 90000, scheduledPaymentAmount: 6500 }],
        }),
      }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('dti_too_high')
  })

  it('allows a lead comfortably under the ceiling', () => {
    const verdict = screenLead(
      ctx({
        report: cleanReport({
          trades: [{ rate: { code: 1 }, balance: 20000, scheduledPaymentAmount: 1142 }],
        }),
      }),
      {},
      NOW
    )
    expect(verdict.pass).toBe(true)
  })

  // A thin file has no accounts to measure, and a DTI ceiling exists to catch people paying too
  // much rather than people with no debt at all, so it must not reject here.
  it('allows a lead whose file carries no accounts to measure', () => {
    const verdict = screenLead(ctx({ report: cleanReport({ trades: [] }) }), {}, NOW)
    expect(verdict.pass).toBe(true)
  })

  it('rejects when the ceiling is set but the lead states no income', () => {
    const verdict = screenLead(
      ctx({
        payload: payload({ financialInformation: { annualIncome: 0 }, loanInformation: { loanAmount: 20000 } }),
        env: { ACHIEVE_MAX_DTI: '0.60' },
        report: cleanReport({ trades: [{ rate: { code: 1 }, balance: 5000, scheduledPaymentAmount: 200 }] }),
      }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('dti_too_high')
  })

  it('rejects a lead under the minimum age', () => {
    const verdict = screenLead(
      ctx({ payload: payload({ personalInformation: { state: 'NY', dateOfBirth: '2010-01-01' } }) }),
      {},
      NOW
    )
    expect(verdict.reason).toBe('under_min_age')
  })

  // A missing report is not a clean report. With credit-based filters switched on, a lead we
  // could not pull has to be refused rather than passed by default, or an Equifax outage
  // silently sends unscreened leads at exactly the moment we cannot screen them.
  it('rejects when a credit filter is on but no report was pulled', () => {
    const verdict = screenLead(ctx({ noReportStep: true }), {}, NOW)
    expect(verdict.reason).toBe('no_credit_report')
  })

  it('does not require a report when no credit-based filter is configured', () => {
    const verdict = screenLead(
      ctx({
        noReportStep: true,
        env: { ACHIEVE_MIN_LOAN_AMOUNT: '10000', ACHIEVE_ALLOWED_STATES: ACHIEVE_STATES },
      }),
      {},
      NOW
    )
    expect(verdict.pass).toBe(true)
  })

  // A per-node override exists for workflows whose payload is shaped differently, but the
  // thresholds themselves must stay central so nobody has to touch six nodes.
  it('lets a node override where the score is read from', () => {
    const context = ctx({ score: 400 })
    ;(context.steps as Record<string, unknown>).other_score = { status: 'completed', output: 700 }
    const verdict = screenLead(context, { vantage_score_ref: '{{steps.other_score.output}}' }, NOW)
    expect(verdict.pass).toBe(true)
  })

  it('exposes every reason it can return, so each is countable', () => {
    expect(ACHIEVE_SCREEN_REASONS).toContain('has_current_delinquency')
    expect(new Set(ACHIEVE_SCREEN_REASONS).size).toBe(ACHIEVE_SCREEN_REASONS.length)
  })
})
