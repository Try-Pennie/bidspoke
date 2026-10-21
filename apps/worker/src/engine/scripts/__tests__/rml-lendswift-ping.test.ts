/**
 * The RML LendSwift ping ends a LendSwift failure as a no bid (#2582).
 *
 * On 2026-10-21, 10:22 to 10:37 UTC, LendSwift's decide service failed about two
 * pings in three. The ping_lendswift script answered each of those leads HTTP 500,
 * so the Applicant it had already created never got a bid result, and the error
 * LendSwift gave was only in a log line. Dan decided (2026-10-21):
 *  - a LendSwift failure (an error answer, a failed call, no decision, or no answer
 *    within 60 seconds) ends the lead as no bid, answered and patched with the
 *    reason partner_error while LS_Rejection_Reason__c says lendswift_error;
 *  - the lead is sent ONCE and waited for up to 60 seconds, never resent;
 *  - LendSwift's own reason is kept on the step output.
 *
 * The kept ping_lendswift.js is run here as the sandbox runs it, followed by the
 * kept build_response.js, which is what the canvas runs next: its answer is what
 * the source is sent and what patch_applicant_no_bid writes. The 60 second
 * deadline is driven through a stubbed timer, never waited for. No real person:
 * the lead is synthetic and the error bodies are copies of the 2026-10-21 shapes
 * with nine zeros where a provider URL carried an SSN.
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

// The script's only timer is its 60 second deadline, armed with the global
// setTimeout and cleared in a finally. Both are stubbed: a test fires the deadline
// itself, so nothing here waits for real (L524).
interface Timer { id: number; ms: number; fire: () => void }
let timers: Timer[] = []
let cleared: number[] = []
beforeEach(() => {
  timers = []
  cleared = []
  vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
    const id = timers.length + 1
    timers.push({ id, ms: ms ?? 0, fire: fn })
    return id
  })
  vi.stubGlobal('clearTimeout', (id: number) => { cleared.push(id) })
})
afterEach(() => { vi.unstubAllGlobals() })

type Answer = { status: number; body?: unknown } | Error | 'hang'

/**
 * A fetch answering each call in turn, recording how many calls were made. 'hang'
 * never answers on its own: it rejects only when the request's signal aborts, as
 * the platform's fetch does.
 */
function decide(...answers: Answer[]): { fetch: CanvasRun['fetch']; calls: () => number; started: Promise<void> } {
  let n = 0
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const fetch = async (_input: string, init?: { signal?: AbortSignal }) => {
    const a = answers[Math.min(n, answers.length - 1)]
    n++
    markStarted()
    if (a === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    if (a instanceof Error) throw a
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fetch as unknown as CanvasRun['fetch'], calls: () => n, started }
}

function ping(fetch: CanvasRun['fetch']): Promise<Record<string, unknown>> {
  return runCanvasScript(PING_LENDSWIFT, {
    payload,
    env,
    steps: { create_applicant: { output: { body: { id: APPLICANT } } }, constants: { output: constants } },
    fetch,
  }) as Promise<Record<string, unknown>>
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
const PARTNER_ERROR_ANSWER = { lead_id: payload.leadUuid, status: 'rejected', reason: 'partner_error' }

describe('a LendSwift failure ends the lead as no bid with partner_error (#2582)', () => {
  it('answers the 2026-10-21 runtime error once, without a resend, keeping LendSwift\'s reason on the step output', async () => {
    const d = decide({ status: 500, body: RUNTIME_ERROR })
    const out = await ping(d.fetch)
    // No response marker: the engine would end the run with it, as it did on 2026-10-21.
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
    // Sent once: a 5xx is no longer resent, since the first send may have reached LendSwift.
    expect(d.calls()).toBe(1)
    // The deadline was armed and cleared, and never fired.
    expect(timers.map((t) => t.ms)).toEqual([60000])
    expect(cleared).toEqual([timers[0].id])
    // What LendSwift echoed of the applicant never reaches the step output.
    expect(JSON.stringify(out)).not.toContain('stands in for what LendSwift sent')
  })

  it('build_response answers it as partner_error and patches LS_Rejection_Reason__c lendswift_error', async () => {
    const built = await buildResponse(await ping(decide({ status: 500, body: RUNTIME_ERROR }).fetch))
    expect(built.body).toEqual(PARTNER_ERROR_ANSWER)
    // patch_applicant_no_bid writes these (RejectionReason__c is body.reason).
    expect(built.lsRejectionReason).toBe('lendswift_error')
    expect(built.externalPartnerBid).toBeNull()
    expect(built.minBidAmt).toBe(FLOOR)
    // No offer, so the Patch Applicant branch takes No Bid (its Bid arm needs offers[0].rate > 0).
    expect(built.body).not.toHaveProperty('offers')
  })

  it('ends the lead as a timeout when LendSwift has not answered at 60 seconds, without resending it', async () => {
    const d = decide('hang')
    const running = ping(d.fetch)
    await d.started
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(60000)
    // The clock reaches 60 seconds: the request is aborted and the lead ends.
    timers[0].fire()
    const out = await running
    expect(out.lendswift_error).toMatchObject({ kind: 'timeout', http_status: null, message: 'no answer from LendSwift within 60 seconds' })
    expect(d.calls()).toBe(1)
    expect((await buildResponse(out)).body).toEqual(PARTNER_ERROR_ANSWER)
  })

  it('an answer before the deadline is not cut off, and the deadline is cleared', async () => {
    const d = decide({ status: 200, body: ACCEPTED })
    const out = await ping(d.fetch)
    expect(out).toEqual({ error: false, statusCode: 200, data: ACCEPTED })
    expect(cleared).toEqual([timers[0].id])
  })

  it('masks the SSN a provider URL carries, and keeps the provider\'s error type', async () => {
    const d = decide({ status: 500, body: PROVIDER_TIMEOUT })
    const out = await ping(d.fetch)
    const err = out.lendswift_error as Record<string, unknown>
    expect(err.provider_error).toBe('provider_timeout')
    expect(err.message).toBe('We encountered an issue while retrieving the response from the provider. Timeout on downstream API: get https://ms.lendswift.com/leads/v1/ssn/[redacted]')
    expect(JSON.stringify(out)).not.toMatch(/\d{5,}/)
    expect(JSON.stringify(out)).not.toContain('<html>')
    expect(d.calls()).toBe(1)
  })

  it('ends a call that fails before any answer as a network error, sent once', async () => {
    const d = decide(new TypeError('Network connection lost.'))
    const out = await ping(d.fetch)
    expect(out.lendswift_error).toMatchObject({ kind: 'network_error', http_status: null, message: 'Network connection lost.' })
    expect(d.calls()).toBe(1)
    expect((await buildResponse(out)).body).toEqual(PARTNER_ERROR_ANSWER)
  })

  it('never stringifies an error body that is not text into its message', async () => {
    const out = await ping(decide({ status: 500, body: { message: { nested: 'not text' }, status: { code: 1 } } }).fetch)
    const err = out.lendswift_error as Record<string, unknown>
    expect(err.message).toBe('')
    expect(err.status).toBeNull()
    expect(JSON.stringify(out)).not.toContain('[object Object]')
  })

  it('ends a 4xx as no bid, sent once', async () => {
    const d = decide({ status: 422, body: { status: 'error', detail: { msg: 'validation failed' } } })
    const out = await ping(d.fetch)
    expect(d.calls()).toBe(1)
    expect(out.lendswift_error).toMatchObject({ kind: 'http_error', http_status: 422, message: 'validation failed' })
  })

  it('ends a 200 that carries no decision as no bid, where build_response used to throw', async () => {
    const out = await ping(decide({ status: 200, body: { status: 'error' } }).fetch)
    expect(out.lendswift_error).toMatchObject({ kind: 'unreadable_answer', http_status: 200 })
    const built = await buildResponse(out)
    expect(built.body).toEqual(PARTNER_ERROR_ANSWER)
    expect(built.lsRejectionReason).toBe('lendswift_error')
  })

  it('the failure answer still reads as a rejection to the build_response live today, so the two pastes can land in either order', async () => {
    const out = await ping(decide({ status: 500, body: RUNTIME_ERROR }).fetch)
    // What build_response reads when it does not know lendswift_error.
    const data = (out.data as { data: Record<string, unknown> }).data
    expect(data).toEqual({ status: 'ERROR', bid_amount: null, min_bid_value: null, redirect_url: null, rejection_reason: 'lendswift_error' })
  })
})

describe('answers LendSwift gives are passed on unchanged (#2582)', () => {
  it('an accepted bid is the step output it always was, and build_response offers it', async () => {
    const out = await ping(decide({ status: 200, body: ACCEPTED }).fetch)
    expect(out).toEqual({ error: false, statusCode: 200, data: ACCEPTED })
    const built = await buildResponse(out)
    expect((built.body as { offers: Array<{ rate: number }> }).offers[0].rate).toBe(40 * 0.65)
  })

  it('a rejection is the step output it always was, and build_response still answers unqualified_lead with LendSwift\'s reason', async () => {
    const out = await ping(decide({ status: 200, body: REJECTED }).fetch)
    expect(out).toEqual({ error: false, statusCode: 200, data: REJECTED })
    const built = await buildResponse(out)
    expect(built.body).toEqual({ lead_id: payload.leadUuid, status: 'rejected', reason: 'unqualified_lead' })
    expect(built.lsRejectionReason).toBe('credit_policy')
    expect(built.minBidAmt).toBe(2)
  })
})
