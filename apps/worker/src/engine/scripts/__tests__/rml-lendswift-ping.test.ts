/**
 * The RML LendSwift ping ends a LendSwift failure as a no bid (#2582).
 *
 * On 2026-10-21, 10:22 to 10:37 UTC, LendSwift's decide service failed about two
 * pings in three. The ping_lendswift script answered each of those leads HTTP 500,
 * so the Applicant it had already created never got a bid result, and the error
 * LendSwift gave was only in a log line. Dan decided (2026-10-21) that a LendSwift
 * failure ends the lead as no bid: patched the way patch_applicant_no_bid patches
 * it, answered with the workflow's normal no bid answer, and LendSwift's own reason
 * kept on the step output.
 *
 * The kept ping_lendswift.js is run here as the sandbox runs it, followed by the
 * kept build_response.js, which is what the canvas runs next: its answer is what
 * the source is sent and what patch_applicant_no_bid writes. No real person: the
 * lead is synthetic and the error bodies are copies of the 2026-10-21 shapes with
 * nine zeros where a provider URL carried an SSN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PING_LENDSWIFT from '../rml-lendswift/ping_lendswift.js'
import BUILD_RESPONSE from '../rml-lendswift/build_response.js'
import { runCanvasScript, type CanvasRun } from './canvas-script'

const payload = {
  leadUuid: '00000000-0000-4000-8000-000000002582',
  subAccountUuid: '00000000-0000-4000-8000-00000000c0de',
  personalInformation: { state: 'TX', firstName: 'Synthia', lastName: 'Gatekeeper', ssn: '000-00-0000', primaryPhone: '0000000000' },
  loanInformation: { loanAmount: 1000, purpose: 'debt_consolidation' },
  financialInformation: { annualIncome: 50000, employmentStatus: 'employed_full_time' },
}
const env = { LENDSWIFT_API_KEY: 'key', LENDSWIFT_TX_USERNAME: 'user', LENDSWIFT_TX_PASSWORD: 'pass', LINK_TOKEN_SECRET: 'secret' }
const FLOOR = 6.15
const constants = {
  LendswiftSubAccountMinBids: { [payload.subAccountUuid]: FLOOR },
  multiplier: 0.65,
  pennieClickUrl: 'https://reservemyloan.com/portal/ls',
  offerName: 'Reserve My Loan',
  productType: 'installment_loan',
  logoSrc: 'https://example.com/logo.png',
  offerTitle: 't',
  offerDetails: 'd',
}
const APPLICANT = 'a0G000000000000AAA'

// The script waits 250 ms before its one retry with the global setTimeout. The wait
// is recorded and skipped, so no test waits for real (L524).
let waits: number[] = []
beforeEach(() => {
  waits = []
  vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => { waits.push(ms ?? 0); fn(); return 0 })
})
afterEach(() => { vi.unstubAllGlobals() })

type Answer = { status: number; body?: unknown } | Error

/** A fetch answering each call in turn, recording how many calls were made. */
function decide(...answers: Answer[]): { fetch: CanvasRun['fetch']; calls: () => number } {
  let n = 0
  const fetch = async () => {
    const a = answers[Math.min(n, answers.length - 1)]
    n++
    if (a instanceof Error) throw a
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetch as unknown as CanvasRun['fetch'], calls: () => n }
}

async function ping(fetch: CanvasRun['fetch']): Promise<Record<string, unknown>> {
  return await runCanvasScript(PING_LENDSWIFT, {
    payload,
    env,
    steps: { create_applicant: { output: { body: { id: APPLICANT } } }, constants: { output: constants } },
    fetch,
  }) as Record<string, unknown>
}

async function buildResponse(pingOutput: unknown): Promise<Record<string, unknown>> {
  return await runCanvasScript(BUILD_RESPONSE, {
    payload,
    env,
    execution: { trace_id: 'trace' },
    steps: { ping_lendswift: { output: pingOutput }, create_applicant: { output: { body: { id: APPLICANT } } }, constants: { output: constants } },
  }) as Record<string, unknown>
}

/** What 2026-10-21 looked like: a runtime error inside LendSwift's decide flow. */
const RUNTIME_ERROR = {
  status: 'error',
  detail: { msg: 'AttributeError: Attribute: `data` not found', node_id: '00000000-0000-4000-8000-00000000d0de', exc_type: 'runtime' },
  metadata: { decision_id: 'decision-1', flow_slug: 'training' },
  raw_provider_requests: [{ body: 'stands in for what LendSwift sent its providers' }],
  raw_provider_responses: [],
}
/** A provider timeout: the message embeds a provider URL, which for one provider ends in the SSN. */
const PROVIDER_TIMEOUT = {
  ...RUNTIME_ERROR,
  detail: {
    msg: `We encountered an issue while retrieving the response from the provider. Details: ${JSON.stringify({
      detail: [{ msg: 'Timeout on downstream API: get https://ms.lendswift.com/leads/v1/ssn/000000000', type: 'provider_timeout', ctx: { provider_raw_response: '<html>504</html>' } }],
    })}`,
    exc_type: 'provider',
  },
}
const ACCEPTED = { data: { status: 'ACCEPTED', bid_amount: 40, min_bid_value: null, redirect_url: 'https://example.com/accepted', rejection_reason: null } }
const REJECTED = { data: { status: 'REJECTED', bid_amount: 0, min_bid_value: 2, redirect_url: null, rejection_reason: 'credit_policy' } }

describe('a LendSwift failure ends the lead as no bid (#2582)', () => {
  it('answers the 2026-10-21 runtime error as no bid, keeping LendSwift\'s reason on the step output', async () => {
    const d = decide({ status: 500, body: RUNTIME_ERROR })
    const out = await ping(d.fetch)
    // No response sentinel: the engine would end the run with it, as it did on 2026-10-21.
    expect(out).not.toHaveProperty('response')
    expect(out.lendswift_error).toEqual({
      kind: 'http_error',
      http_status: 500,
      status: 'error',
      exc_type: 'runtime',
      provider_error: null,
      message: 'AttributeError: Attribute: `data` not found',
      decision_id: 'decision-1',
    })
    // A 5xx is still retried once, 250 ms later, as before.
    expect(d.calls()).toBe(2)
    expect(waits).toEqual([250])
    // What LendSwift echoed of the applicant never reaches the step output.
    expect(JSON.stringify(out)).not.toContain('stands in for what LendSwift sent')
  })

  it('build_response turns it into the normal no bid answer and the no bid patch values', async () => {
    const built = await buildResponse(await ping(decide({ status: 500, body: RUNTIME_ERROR }).fetch))
    expect(built.body).toEqual({ lead_id: payload.leadUuid, status: 'rejected', reason: 'unqualified_lead' })
    // patch_applicant_no_bid writes these (RejectionReason__c is body.reason).
    expect(built.lsRejectionReason).toBe('lendswift_error')
    expect(built.externalPartnerBid).toBeNull()
    expect(built.minBidAmt).toBe(FLOOR)
    // No offer, so the Patch Applicant branch takes No Bid (its Bid arm needs offers[0].rate > 0).
    expect(built.body).not.toHaveProperty('offers')
  })

  it('masks the SSN a provider URL carries, and keeps the provider\'s error type', async () => {
    const d = decide({ status: 500, body: PROVIDER_TIMEOUT })
    const out = await ping(d.fetch)
    const err = out.lendswift_error as Record<string, unknown>
    expect(err.provider_error).toBe('provider_timeout')
    expect(err.message).toBe('We encountered an issue while retrieving the response from the provider. Timeout on downstream API: get https://ms.lendswift.com/leads/v1/ssn/[redacted]')
    expect(JSON.stringify(out)).not.toMatch(/\d{5,}/)
    expect(JSON.stringify(out)).not.toContain('<html>')
    expect(d.calls()).toBe(2)
  })

  it('ends a fetch that rejects (a network failure or a client timeout) as no bid, after one retry', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const d = decide(timeout)
    const out = await ping(d.fetch)
    expect(out.lendswift_error).toMatchObject({ kind: 'network_error', http_status: null, message: 'The operation was aborted due to timeout' })
    expect(d.calls()).toBe(2)
    expect((await buildResponse(out)).body).toEqual({ lead_id: payload.leadUuid, status: 'rejected', reason: 'unqualified_lead' })
  })

  it('does not retry a 4xx, and still ends it as no bid', async () => {
    const d = decide({ status: 422, body: { status: 'error', detail: { msg: 'validation failed' } } })
    const out = await ping(d.fetch)
    expect(d.calls()).toBe(1)
    expect(out.lendswift_error).toMatchObject({ kind: 'http_error', http_status: 422, message: 'validation failed' })
  })

  it('ends a 200 that carries no decision as no bid, where build_response used to throw', async () => {
    const out = await ping(decide({ status: 200, body: { status: 'error' } }).fetch)
    expect(out.lendswift_error).toMatchObject({ kind: 'unreadable_answer', http_status: 200 })
    expect((await buildResponse(out)).lsRejectionReason).toBe('lendswift_error')
  })

  it('a retry that succeeds is the bid, as before', async () => {
    const d = decide({ status: 503, body: RUNTIME_ERROR }, { status: 200, body: ACCEPTED })
    const out = await ping(d.fetch)
    expect(d.calls()).toBe(2)
    expect(out).toEqual({ error: false, statusCode: 200, data: ACCEPTED })
  })
})

describe('answers LendSwift gives are passed on unchanged (#2582)', () => {
  it('an accepted bid is the step output it always was, and build_response offers it', async () => {
    const out = await ping(decide({ status: 200, body: ACCEPTED }).fetch)
    expect(out).toEqual({ error: false, statusCode: 200, data: ACCEPTED })
    const built = await buildResponse(out)
    expect((built.body as { offers: Array<{ rate: number }> }).offers[0].rate).toBe(40 * 0.65)
  })

  it('a rejection is the step output it always was, and build_response rejects with LendSwift\'s reason', async () => {
    const out = await ping(decide({ status: 200, body: REJECTED }).fetch)
    expect(out).toEqual({ error: false, statusCode: 200, data: REJECTED })
    const built = await buildResponse(out)
    expect(built.body).toEqual({ lead_id: payload.leadUuid, status: 'rejected', reason: 'unqualified_lead' })
    expect(built.lsRejectionReason).toBe('credit_policy')
    expect(built.minBidAmt).toBe(2)
  })
})
