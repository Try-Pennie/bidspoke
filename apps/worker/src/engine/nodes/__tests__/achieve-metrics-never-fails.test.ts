import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The metrics derivation runs before the call and OUTSIDE the node's try block, so a throw
// there would fail a node whose whole contract is that it never fails the flow: it is a
// pass-through bolted to the tail of Main Flow, after the lead has already been answered.
// Nothing in the derivation throws on today's data, which is luck rather than design, and the
// cost of being wrong is a failed step on a live lead for the sake of a diagnostic.
const mocks = vi.hoisted(() => ({ deriveCreditMetrics: vi.fn() }))

vi.mock('../achieve-credit-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../achieve-credit-metrics')>()
  return { ...actual, deriveCreditMetrics: mocks.deriveCreditMetrics }
})

const { executeAchieveOffersNode } = await import('../achieve-offers')

const PROD_ENV = {
  ACHIEVE_USERNAME: 'user',
  ACHIEVE_PASSWORD: 'pass',
  ACHIEVE_API_URL: 'https://api.freedomfinancialnet.com',
}

const makeNode = () =>
  ({ id: 'node-1', namespace: 'achieve_offers', type: 'achieve_offers', config: {} }) as never

// Payload shape copied from the node's own suite: the node returns early on missing fields,
// BEFORE the derivation runs, so a thin fixture would make this test pass while proving
// nothing about the thing it exists to check.
const ctxWithReport = () =>
  ({
    env: PROD_ENV,
    trigger: {
      payload: {
        Submission__c: 'a04Ui00000I6lTKIAZ',
        personalInformation: {
          ssn: '113-52-2922',
          email: 'lead@example.com',
          primaryPhone: '(646) 770-6541',
          firstName: 'Joseph',
          lastName: 'Guerrera',
          dateOfBirth: '1959-12-29',
          address1: '190 Greenleaf Avenue',
          city: 'Staten Island',
          state: 'NY',
          zipcode: '10310',
        },
        loanInformation: { purpose: 'debt_consolidation', loanAmount: 7500 },
        financialInformation: { annualIncome: 122000, employmentStatus: 'employed_full_time' },
        creditInformation: { providedCreditRating: 'poor' },
      },
    },
    steps: {
      equifax_credit_report: {
        output: {
          data: {
            consumers: {
              equifaxUSConsumerCreditReport: [
                { models: [{ score: 700 }], trades: [], inquiries: [] },
              ],
            },
          },
        },
      },
    },
  }) as never

beforeEach(() => {
  vi.stubGlobal('btoa', (s: string) => `b64(${s})`)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 1, response: 'accepted', offers: [{ amount: 1 }] }),
      headers: { get: () => null },
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.deriveCreditMetrics.mockReset()
})

describe('a failing metrics derivation cannot fail the node', () => {
  it('still sends the lead and records null metrics when the derivation throws', async () => {
    mocks.deriveCreditMetrics.mockImplementation(() => {
      throw new Error('unexpected report shape')
    })

    const { output } = await executeAchieveOffersNode(makeNode(), ctxWithReport())
    const out = output as Record<string, unknown>

    // The call still happened and its outcome is intact: the diagnostic failing must not cost
    // the thing the node exists to do.
    expect(out.response_status).toBe('accepted')
    expect(out.offer_count).toBe(1)
    // Null rather than absent, so a derivation that blew up is not silently indistinguishable
    // from a lead that simply had no report.
    expect(out.credit_metrics).toBeNull()
  })

  it('carries the metrics through when the derivation succeeds', async () => {
    mocks.deriveCreditMetrics.mockReturnValue({ vantage_score: 700 })
    const { output } = await executeAchieveOffersNode(makeNode(), ctxWithReport())
    expect((output as Record<string, unknown>).credit_metrics).toEqual({ vantage_score: 700 })
  })
})
