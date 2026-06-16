import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeAchieveOffersNode } from '../achieve-offers'
import type { NodeDefinition, ExecutionContext } from '../../../types'

function makeNode(config: Record<string, unknown> = {}): NodeDefinition {
  return {
    id: 'node-1',
    namespace: 'achieve_offers',
    type: 'achieve_offers',
    config,
  } as NodeDefinition
}

function makeCtx(overrides: {
  payload?: unknown
  env?: Record<string, string>
  steps?: Record<string, { status: string; output: unknown }>
} = {}): ExecutionContext {
  return {
    trigger: {
      payload: overrides.payload ?? fullPayload(),
      source: 'test',
      workflow_id: 'wf-1',
      trace_id: 'trace-1',
      org_id: 'org-1',
    },
    steps: (overrides.steps ?? {}) as ExecutionContext['steps'],
    env: overrides.env ?? {
      ACHIEVE_USERNAME: 'user',
      ACHIEVE_PASSWORD: 'pass',
    },
  } as ExecutionContext
}

function fullPayload() {
  return {
    Submission__c: 'a04Ui00000I6lTKIAZ',
    personalInformation: {
      ssn: '113-52-2922',
      email: 'lead@example.com',
      primaryPhone: '(646) 770-6541',
      firstName: 'Joseph',
      lastName: 'Guerrera',
      dateOfBirth: '1959-12-29',
      address1: '190 Greenleaf Avenue',
      address2: '14A',
      city: 'Staten Island',
      state: 'NY',
      zipcode: '10310',
    },
    loanInformation: { purpose: 'debt_consolidation', loanAmount: 7500 },
    financialInformation: { annualIncome: 122000, employmentStatus: 'employed_full_time' },
    creditInformation: { providedCreditRating: 'poor' },
    sessionInformation: { ipAddress: '207.29.44.2', userAgent: 'Mozilla/5.0' },
  }
}

function acceptedResponse(offerCount = 2) {
  return {
    id: 749606,
    response: 'accepted',
    offers: Array.from({ length: offerCount }, (_, i) => ({
      provider: 'fdr',
      amount: 30000 + i,
    })),
  }
}

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  // btoa exists in Workers runtime but not in the Node test env
  vi.stubGlobal('btoa', (s: string) => `b64(${s})`)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('executeAchieveOffersNode', () => {
  // #66: a step-level timeout must cancel the Achieve POST. A pre-aborted parent
  // signal makes the fetch's signal aborted via linkAbort.
  it('cancels the fetch when the step-level signal aborts (#66)', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    const parent = new AbortController()
    parent.abort()
    await executeAchieveOffersNode(makeNode(), makeCtx(), parent.signal)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.signal as AbortSignal).aborted).toBe(true)
  })

  it('sends an accepted lead and returns marked output with offers', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(2))
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx())
    const out = output as Record<string, unknown>

    expect(out._achieve_evaluation).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.status).toBe(200)
    expect(out.response_status).toBe('accepted')
    expect(out.offer_count).toBe(2)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api-stg.freedomfinancialnet.com/evaluations')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    const body = JSON.parse(init.body as string)
    expect(body.partner_config).toEqual({ wait_for_offers: true, targeted_products: ['fdr'] })
    expect(body.phone).toBe('+16467706541')
    expect(body.employment_status).toBe('full_time')
    expect(body.credit_rating).toBe('poor')
    expect(body.loan_purpose).toBe('debt_consolidation')
    expect(body.loan_amount).toBe(7500)
    expect(body.tracking.unique_identifier).toBe('a04Ui00000I6lTKIAZ')
    expect(body.partner_lead_id).toBe('a04Ui00000I6lTKIAZ')
  })

  it('respects targeted_products and wait_for_offers config', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(0))
    await executeAchieveOffersNode(
      makeNode({ targeted_products: ['fdr', 'fplus', 'bogus'], wait_for_offers: false }),
      makeCtx()
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.partner_config).toEqual({
      wait_for_offers: false,
      targeted_products: ['fdr', 'fplus'],
    })
  })

  it('uses verified debt from pennie_or_eligibility when present', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        steps: {
          pennie_or_eligibility: {
            status: 'completed',
            output: { eligibilityData: { estimated_total_debt: 31250.6 }, final: 28000 },
          },
        },
      })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.unsecured_debt).toBe(31251)
  })

  it('falls back to .final, then loan_amount only', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        steps: {
          pennie_or_eligibility: { status: 'completed', output: { final: 28000 } },
        },
      })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.unsecured_debt).toBe(28000)
  })

  it('classifies a rejected lead without failing', async () => {
    mockFetchOnce(200, { response: 'rejected', response_reason: 'DuplicateLead' })
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx())
    const out = output as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.response_status).toBe('rejected')
    expect(out.response_reason).toBe('DuplicateLead')
    expect(out.offer_count).toBe(0)
  })

  it('returns error output on non-2xx without throwing', async () => {
    mockFetchOnce(401, { message: 'Invalid credentials' })
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx())
    const out = output as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.status).toBe(401)
    expect(out.response_status).toBe('error')
    expect(out.response_reason).toBe('Invalid credentials')
  })

  it('returns error output when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx())
    const out = output as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.response_status).toBe('error')
    expect(out.response_reason).toBe('network down')
  })

  it('skips the API call when credentials are missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx({ env: {} }))
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.response_status).toBe('error')
    expect(out.response_reason).toContain('ACHIEVE_USERNAME')
  })

  it('skips the API call and lists missing required fields', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ payload: { personalInformation: { firstName: 'Joe' } } })
    )
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.response_status).toBe('error')
    expect(out.response_reason).toContain('email')
    expect(out.response_reason).toContain('phone')
    expect(out.response_reason).toContain('unsecured_debt/loan_amount')
  })

  it('uses ACHIEVE_API_URL and utm_source overrides', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode({ utm_source: 'pennie_main' }),
      makeCtx({
        env: {
          ACHIEVE_USERNAME: 'u',
          ACHIEVE_PASSWORD: 'p',
          ACHIEVE_API_URL: 'https://api.freedomfinancialnet.com',
        },
      })
    )
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.freedomfinancialnet.com/evaluations')
    const body = JSON.parse(init.body as string)
    expect(body.tracking.utm_source).toBe('pennie_main')
  })

  it('omits annual_income when 0 and unmapped employment status', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    const payload = fullPayload()
    payload.financialInformation = { annualIncome: 0, employmentStatus: 'gig_worker' }
    await executeAchieveOffersNode(makeNode(), makeCtx({ payload }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).not.toHaveProperty('annual_income')
    expect(body).not.toHaveProperty('employment_status')
  })
})
