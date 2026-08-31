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

  // Pinned to production: off production the lead's identity is deliberately swapped for
  // Achieve's showroom profile (see the sandbox-profile suite below), so a real-lead
  // assertion is only meaningful against the prod endpoint.
  const PROD_ENV = {
    ACHIEVE_USERNAME: 'user',
    ACHIEVE_PASSWORD: 'pass',
    ACHIEVE_API_URL: 'https://api.freedomfinancialnet.com',
  }

  it('sends an accepted lead and returns marked output with offers', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(2))
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx({ env: PROD_ENV }))
    const out = output as Record<string, unknown>

    expect(out._achieve_evaluation).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.status).toBe(200)
    expect(out.response_status).toBe('accepted')
    expect(out.offer_count).toBe(2)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.freedomfinancialnet.com/evaluations')
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    const body = JSON.parse(init.body as string)
    expect(body.partner_config).toEqual({ wait_for_offers: true })
    expect(body.phone).toBe('+16467706541')
    expect(body.employment_status).toBe('full_time')
    expect(body.credit_rating).toBe('poor')
    expect(body.loan_purpose).toBe('debt_consolidation')
    expect(body.loan_amount).toBe(7500)
    expect(body.tracking.unique_identifier).toBe('a04Ui00000I6lTKIAZ')
    expect(body.partner_lead_id).toBe('a04Ui00000I6lTKIAZ')
  })

  it('defaults to the sandbox endpoint when ACHIEVE_API_URL is unset', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx())
    expect(fetchMock.mock.calls[0][0]).toBe('https://api-stg.freedomfinancialnet.com/evaluations')
  })

  it('respects wait_for_offers config', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(0))
    await executeAchieveOffersNode(makeNode({ wait_for_offers: false }), makeCtx())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.partner_config).toEqual({ wait_for_offers: false })
  })

  // The Pennie form emits `credit_card_refi`, but Achieve's API only accepts the full word
  // `credit_card_refinance` and 422s on the short form. ~20% of Main Flow leads carry the short
  // form, so without translation the field is silently dropped and Achieve never sees the purpose.
  it('translates credit_card_refi to Achieve\'s credit_card_refinance', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    const payload = fullPayload()
    payload.loanInformation.purpose = 'credit_card_refi'
    await executeAchieveOffersNode(makeNode(), makeCtx({ payload, env: PROD_ENV }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.loan_purpose).toBe('credit_card_refinance')
  })

  // Achieve drives product selection server-side ("We drive this for our side, and right now,
  // we evaluate your leads for APL" -- Olivier Pariselle, 2026-07-13) and told us to drop the
  // field. Sending it is at best ignored and at worst misleading: we ask for one product and
  // they evaluate for another. `fplus` in their responses is Personal Loan + Pagaya, which is
  // what Pennie actually wants; FDR (debt resolution) is explicitly NOT wanted.
  //
  // Never send it, even if a stale node config still carries it.
  it('never sends targeted_products, even when a stale config still sets it', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode({ targeted_products: ['fdr'] } as Record<string, unknown>),
      makeCtx()
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.partner_config).not.toHaveProperty('targeted_products')
    expect(JSON.stringify(body)).not.toContain('fdr')
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
    expect(out.response_reason).toMatch(/username\/password/i)
  })

  // The message must name WHICH environment's credentials are missing. A staging test with no
  // staging credential stored and a production run with none need different fixes, and one
  // shared wording sends whoever reads it to the wrong setting.
  it('names the environment whose credentials are missing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const staging = await executeAchieveOffersNode(makeNode(), makeCtx({ env: { ACHIEVE_ENV: 'staging' } }))
    expect((staging.output as Record<string, unknown>).response_reason).toMatch(/staging/i)

    const prod = await executeAchieveOffersNode(makeNode(), makeCtx({ env: { ACHIEVE_ENV: 'production' } }))
    expect((prod.output as Record<string, unknown>).response_reason).toMatch(/production/i)
  })

  // A misspelled environment must stop the send and say so. Quietly using staging would look
  // identical to Achieve declining every lead, and whoever read that would go looking at the
  // partner rather than at the one setting that is wrong.
  it('does not send at all when the environment setting is not recognised', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: { ...PROD_ENV, ACHIEVE_ENV: 'prod' } })
    )
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.response_status).toBe('error')
    expect(out.response_reason).toContain('prod')
    // Recorded as an evaluation, not a screening skip: the lead was eligible and a
    // misconfiguration stopped it, which is a different fact from a lead we chose not to send.
    expect(out._achieve_evaluation).toBe(true)
  })

  // The switch has to carry the credentials AND the host together, proven at the node rather than
  // only in the resolver's own unit tests: staging must not authenticate with the live password.
  it('sends staging requests to the staging host with the staging credentials', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        env: {
          ACHIEVE_ENV: 'staging',
          ACHIEVE_USERNAME: 'live_user',
          ACHIEVE_PASSWORD: 'live_pass',
          ACHIEVE_STAGING_USERNAME: 'stg_user',
          ACHIEVE_STAGING_PASSWORD: 'stg_pass',
        },
      })
    )
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api-stg.freedomfinancialnet.com/evaluations')
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic b64(stg_user:stg_pass)')
  })

  // Vantage floor screen (ACHIEVE_MIN_VANTAGE_SCORE). Ships OFF: 0/blank/unset send everyone,
  // exactly as before. A positive floor skips the call (no PII sent, no DB row) for leads whose
  // pulled Vantage is below it, or who have no score at all.
  const VANTAGE_ENV = { ...PROD_ENV, ACHIEVE_MIN_VANTAGE_SCORE: '700' }
  const withVantage = (score: unknown) => ({
    gen_vantage_score: { status: 'completed', output: score },
  })

  it('skips the call when Vantage is below the floor', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: VANTAGE_ENV, steps: withVantage(650) })
    )
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out._achieve_skipped).toBe(true)
    expect(out).not.toHaveProperty('_achieve_evaluation')
  })

  it('skips the call when there is no Vantage score and a floor is set', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: VANTAGE_ENV, steps: withVantage(null) })
    )
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out._achieve_skipped).toBe(true)
  })

  // The screening criteria are unit-tested in achieve-screen.test.ts. These two prove the NODE
  // is actually wired to them: that a criterion other than the score can stop the call, and
  // that the specific reason reaches the node's output. Without the second, every held-back
  // lead would be an unattributable "skipped", and a rejected lead never reaches Achieve, so
  // counting rejections by cause is the only measurement left.
  it('does not call Achieve when a non-score criterion rejects the lead', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: { ...PROD_ENV, ACHIEVE_ALLOWED_STATES: 'CA,TX' }, steps: withVantage(720) })
    )
    const out = output as Record<string, unknown>
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out._achieve_skipped).toBe(true)
    expect(out.reason).toBe('state_not_allowed')
    expect(out).not.toHaveProperty('_achieve_evaluation')
  })

  it('carries the rejecting criterion and its measured value onto the output', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: { ...PROD_ENV, ACHIEVE_MIN_LOAN_AMOUNT: '10000' }, steps: withVantage(720) })
    )
    const out = output as Record<string, unknown>
    expect(out.reason).toBe('loan_amount_below_min')
    // The default fixture asks for 7500, which is what the gate measured.
    expect((out.screen as Record<string, unknown>).loan_amount).toBe(7500)
  })

  it('sends when Vantage is at or above the floor', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: VANTAGE_ENV, steps: withVantage(720) })
    )
    expect(fetchMock).toHaveBeenCalled()
  })

  it('sends everyone when the floor is 0 (disabled), regardless of score', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: { ...PROD_ENV, ACHIEVE_MIN_VANTAGE_SCORE: '0' }, steps: withVantage(400) })
    )
    expect(fetchMock).toHaveBeenCalled()
  })

  it('sends when the floor env var is unset (feature off by default)', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: PROD_ENV, steps: withVantage(400) })
    )
    expect(fetchMock).toHaveBeenCalled()
  })

  // Production only: off production the showroom profile always supplies email, phone,
  // name and address, so an incomplete lead can no longer be missing them.
  it('skips the API call and lists missing required fields', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { output } = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ payload: { personalInformation: { firstName: 'Joe' } }, env: PROD_ENV })
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

  // Achieve's payload review (Tony, 2026-08-27, #1080) asked for three tracking fields the node
  // never sent: utm_campaign, utm_adgroup (traffic source, when the lead carries one), and a
  // per-lead trusted_form_cert. A TrustedForm cert is minted per form fill, so the payload is
  // the only place a real one can come from; the env var stays as a test-send fallback only.
  describe('tracking fields for Achieve (#1080)', () => {
    const trackingSent = async (payload: unknown, env: Record<string, string>, config: Record<string, unknown> = {}) => {
      const fetchMock = mockFetchOnce(200, acceptedResponse(1))
      await executeAchieveOffersNode(makeNode(config), makeCtx({ payload, env }))
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      return JSON.parse(init.body as string).tracking as Record<string, unknown>
    }

    it('sends utm_campaign, defaulting to _achieve_pl', async () => {
      const tracking = await trackingSent(fullPayload(), PROD_ENV)
      expect(tracking.utm_campaign).toBe('_achieve_pl')
    })

    it('lets config and env override utm_campaign, config winning', async () => {
      const viaEnv = await trackingSent(fullPayload(), { ...PROD_ENV, ACHIEVE_UTM_CAMPAIGN: 'env_campaign' })
      expect(viaEnv.utm_campaign).toBe('env_campaign')
      const viaConfig = await trackingSent(
        fullPayload(),
        { ...PROD_ENV, ACHIEVE_UTM_CAMPAIGN: 'env_campaign' },
        { utm_campaign: 'config_campaign' }
      )
      expect(viaConfig.utm_campaign).toBe('config_campaign')
    })

    it('sends utm_adgroup from the payload traffic source and omits it when absent', async () => {
      const withSource = await trackingSent({ ...fullPayload(), traffic_source: 'google' }, PROD_ENV)
      expect(withSource.utm_adgroup).toBe('google')
      const without = await trackingSent(fullPayload(), PROD_ENV)
      expect(without).not.toHaveProperty('utm_adgroup')
    })

    it('sends trusted_form_cert from the payload, beating the env fallback', async () => {
      const cert = 'https://cert.trustedform.com/abc123'
      const fromPayload = await trackingSent(
        { ...fullPayload(), trusted_form_cert: cert },
        { ...PROD_ENV, ACHIEVE_TRUSTED_FORM_CERT: 'placeholder' }
      )
      expect(fromPayload.trusted_form_cert).toBe(cert)
    })

    it('reads the cert from the TrustedForm hidden-field spelling too', async () => {
      const cert = 'https://cert.trustedform.com/def456'
      const tracking = await trackingSent({ ...fullPayload(), xxTrustedFormCertUrl: cert }, PROD_ENV)
      expect(tracking.trusted_form_cert).toBe(cert)
    })

    it('falls back to the env cert and omits the field when neither exists', async () => {
      const viaEnv = await trackingSent(fullPayload(), { ...PROD_ENV, ACHIEVE_TRUSTED_FORM_CERT: 'placeholder' })
      expect(viaEnv.trusted_form_cert).toBe('placeholder')
      const absent = await trackingSent(fullPayload(), PROD_ENV)
      expect(absent).not.toHaveProperty('trusted_form_cert')
    })
  })

  // Test runs bypass the screen (Dan, 2026-08-31): the screen's score floor doubles as the
  // pause switch for the live pipe, and with it set to an impossible value a canvas test lead
  // could never reach Achieve at all. A test run is a deliberate, person-initiated send of one
  // lead, so it goes out regardless of the gate; real webhook traffic stays fully screened.
  describe('screening on test runs', () => {
    it('sends a test-run lead even when the screen would hold it back', async () => {
      const fetchMock = mockFetchOnce(200, acceptedResponse(1))
      const ctx = makeCtx({ env: VANTAGE_ENV, steps: withVantage(650) })
      ctx.isTest = true
      const { output } = await executeAchieveOffersNode(makeNode(), ctx)
      const out = output as Record<string, unknown>
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(out._achieve_evaluation).toBe(true)
      expect(out).not.toHaveProperty('_achieve_skipped')
    })

    it('still screens a non-test lead (the bypass is test-only)', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { output } = await executeAchieveOffersNode(
        makeNode(),
        makeCtx({ env: VANTAGE_ENV, steps: withVantage(650) })
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect((output as Record<string, unknown>)._achieve_skipped).toBe(true)
    })
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

// Achieve's SANDBOX only returns offers for its own seeded showroom profiles; it declines
// every real lead regardless of debt (28/28 rejections on 2026-07-13, including two with
// ~$18k verified debt and poor credit). Achieve gave us exactly one seeded profile to use:
// a specific name and address.
//
// Off production we overlay ONLY those two fields Achieve handed us. Every other field
// (email, phone, SSN, DOB, financials) stays the real lead's, unchanged. Achieve gave us a
// profile to use, not a payload to reshape.
//
// Keyed off "is NOT production", so a blank or misconfigured ACHIEVE_API_URL still uses the
// seeded name rather than a real person's.
describe('executeAchieveOffersNode sandbox profile', () => {
  const PROD = 'https://api.freedomfinancialnet.com'
  const STG = 'https://api-stg.freedomfinancialnet.com'

  function sentBody(fetchMock: ReturnType<typeof mockFetchOnce>) {
    return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  }
  const envWith = (url?: string) => ({
    ACHIEVE_USERNAME: 'u',
    ACHIEVE_PASSWORD: 'p',
    ...(url ? { ACHIEVE_API_URL: url } : {}),
  })

  it('overlays only the seeded name and address in the sandbox', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(STG) }))
    const body = sentBody(fetchMock)

    expect(body.first_name).toBe('Mark')
    expect(body.last_name).toBe('Mayerberger')
    expect(body.mailing_address).toEqual({
      street: '19538 CREEKSIDE CT',
      city: 'Salinas',
      state: 'CA',
      zip: '93908',
    })
    // The real lead's name and address must not leak through.
    expect(JSON.stringify(body)).not.toContain('Guerrera')
    expect(JSON.stringify(body)).not.toContain('Staten Island')
  })

  it('overlays the seeded SSN in the sandbox', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(STG) }))
    const body = sentBody(fetchMock)

    // Achieve gave us the seeded profile's SSN; it must be sent in their NNN-NN-NNNN format,
    // and the real lead's SSN must not leak through.
    expect(body.social_security_number).toBe('666-16-4094')
    expect(JSON.stringify(body)).not.toContain('113-52-2922')
  })

  it('keeps every non-seeded field as the real lead in the sandbox', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(STG) }))
    const body = sentBody(fetchMock)

    // Only name, address and SSN are seeded; everything else stays the real lead's.
    expect(body.email).toBe('lead@example.com')
    expect(body.phone).toBe('+16467706541')
    expect(body.date_of_birth).toBe('1959-12-29')
    expect(body.loan_amount).toBe(7500)
    expect(body.annual_income).toBe(122000)
    expect(body.credit_rating).toBe('poor')
    expect(body.loan_purpose).toBe('debt_consolidation')
  })

  it('sends the real lead untouched when pointed at production', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(PROD) }))
    const body = sentBody(fetchMock)

    expect(body.first_name).toBe('Joseph')
    expect(body.last_name).toBe('Guerrera')
    expect(body.email).toBe('lead@example.com')
    expect(body.social_security_number).toBe('113-52-2922')
    expect(body.date_of_birth).toBe('1959-12-29')
    expect(body.mailing_address.city).toBe('Staten Island')
  })

  it('fails safe: overlays the seeded name when ACHIEVE_API_URL is unset', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(undefined) }))
    const body = sentBody(fetchMock)

    expect(body.last_name).toBe('Mayerberger')
    expect(body.mailing_address.city).toBe('Salinas')
  })

  // The output's `sandbox` flag is what the achieve-log hook persists as
  // achieve_evaluations.is_sandbox. Get it wrong and offers made to Achieve's seeded FAKE
  // identity are indistinguishable from real ones in the analysis and in Snowflake. It must
  // be set on EVERY exit path, not just the happy one.
  it('marks the output sandbox off production, on every exit path', async () => {
    const sandboxEnv = envWith(STG)

    mockFetchOnce(200, acceptedResponse(1))
    const ok = await executeAchieveOffersNode(makeNode(), makeCtx({ env: sandboxEnv }))
    expect((ok.output as Record<string, unknown>).sandbox).toBe(true)

    mockFetchOnce(401, { message: 'Invalid credentials' })
    const authFail = await executeAchieveOffersNode(makeNode(), makeCtx({ env: sandboxEnv }))
    expect((authFail.output as Record<string, unknown>).sandbox).toBe(true)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const netFail = await executeAchieveOffersNode(makeNode(), makeCtx({ env: sandboxEnv }))
    expect((netFail.output as Record<string, unknown>).sandbox).toBe(true)

    // Incomplete lead: skipped before the API call, still a sandbox-shaped row.
    const incomplete = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ payload: { personalInformation: {} }, env: sandboxEnv })
    )
    expect((incomplete.output as Record<string, unknown>).sandbox).toBe(true)

    // Missing credentials: skipped before the API call.
    const noCreds = await executeAchieveOffersNode(
      makeNode(),
      makeCtx({ env: { ACHIEVE_API_URL: STG } })
    )
    expect((noCreds.output as Record<string, unknown>).sandbox).toBe(true)
  })

  it('marks the output NOT sandbox on production', async () => {
    mockFetchOnce(200, acceptedResponse(1))
    const { output } = await executeAchieveOffersNode(makeNode(), makeCtx({ env: envWith(PROD) }))
    expect((output as Record<string, unknown>).sandbox).toBe(false)
  })
})

// Achieve rejects every lead with `{"response":"rejected","response_reason":"Missing
// consents"}` unless the request carries a `consents` object. Their spec wants the
// VERBATIM legal text shown to the user, not booleans. The text is identical for every
// lead (it is whatever the Pennie form displays), so it lives in env vars; the payload
// only tells us WHICH consents this lead actually granted.
//
// The gating is the point: we send a consent's text only when that lead's boolean is
// true, so we never assert to a lender that a consumer agreed to something they did not.
describe('executeAchieveOffersNode consents', () => {
  const TCPA = 'By clicking "Next Step" above, you are agreeing to our TCPA consent...'
  const FCRA = 'I authorize Pennie Mgmt LLC to obtain my consumer report information...'
  const ESIGN = 'Electronic Consent Agreement text...'
  const POLICY = 'Privacy Policy text...'
  const TERM = 'Terms of Service text...'

  const consentEnv = {
    ACHIEVE_USERNAME: 'user',
    ACHIEVE_PASSWORD: 'pass',
    ACHIEVE_CONSENT_TCPA: TCPA,
    ACHIEVE_CONSENT_FCRA: FCRA,
    ACHIEVE_CONSENT_ESIGN: ESIGN,
    ACHIEVE_CONSENT_POLICY: POLICY,
    ACHIEVE_CONSENT_TERM: TERM,
  }

  function payloadWithConsents(legalInformation: unknown) {
    return { ...fullPayload(), legalInformation }
  }

  function sentBody(fetchMock: ReturnType<typeof mockFetchOnce>) {
    return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  }

  it('sends the verbatim consent text for every consent the lead granted', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        payload: payloadWithConsents({ consentsToFcra: true, consentsToTcpa: true }),
        env: consentEnv,
      })
    )
    // e_sign / policy / term ride on the same "Agree & View Offers" click that grants FCRA.
    expect(sentBody(fetchMock).consents).toEqual({
      tcpa: TCPA,
      fcra: FCRA,
      e_sign: ESIGN,
      policy: POLICY,
      term: TERM,
    })
  })

  it('omits TCPA when the lead did not grant it, keeping the FCRA-click consents', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        payload: payloadWithConsents({ consentsToFcra: true, consentsToTcpa: false }),
        env: consentEnv,
      })
    )
    const consents = sentBody(fetchMock).consents
    expect(consents).not.toHaveProperty('tcpa')
    expect(consents.fcra).toBe(FCRA)
  })

  it('omits the FCRA-click consents when the lead did not grant FCRA', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        payload: payloadWithConsents({ consentsToFcra: false, consentsToTcpa: true }),
        env: consentEnv,
      })
    )
    const consents = sentBody(fetchMock).consents
    expect(consents).toEqual({ tcpa: TCPA })
  })

  it('omits a consent whose text is not configured, even when granted', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        payload: payloadWithConsents({ consentsToFcra: true, consentsToTcpa: true }),
        env: { ACHIEVE_USERNAME: 'u', ACHIEVE_PASSWORD: 'p', ACHIEVE_CONSENT_FCRA: FCRA },
      })
    )
    expect(sentBody(fetchMock).consents).toEqual({ fcra: FCRA })
  })

  it('omits consents entirely when the lead granted none', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(
      makeNode(),
      makeCtx({
        payload: payloadWithConsents({ consentsToFcra: false, consentsToTcpa: false }),
        env: consentEnv,
      })
    )
    expect(sentBody(fetchMock)).not.toHaveProperty('consents')
  })

  it('omits consents entirely when the payload has no legalInformation', async () => {
    const fetchMock = mockFetchOnce(200, acceptedResponse(1))
    await executeAchieveOffersNode(makeNode(), makeCtx({ env: consentEnv }))
    expect(sentBody(fetchMock)).not.toHaveProperty('consents')
  })
})
