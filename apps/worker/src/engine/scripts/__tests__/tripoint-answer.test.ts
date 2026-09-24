/**
 * tripoint_ping names what Tripoint answered on every path (#1540).
 *
 * Liberty1 may only be offered a lead Tripoint definitely declined, never one
 * whose outcome is unknown, because an unknown can be a sale Tripoint made and
 * never told us about (a double sale). So the kept script returns an explicit
 * `tripoint_answer`: accepted, declined, in_progress (1009), invalid_data (the
 * known 502 refusal), null_id_fault (the known 502 glitch), skipped, or unknown
 * for anything not positively recognised. An unknown answer no longer fails the
 * run: it is a no sale, so build_response_body rejects the lead with a normal
 * response, and the outage page counts it instead (lib/upstream-outage.ts).
 *
 * Every shape here is either a captured Tripoint fixture or a plainly synthetic
 * body labelled as such; the timeout is driven by fake timers, never a real wait.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import duplicate1002 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1002.json'
import duplicate1003 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import duplicate1005 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1005.json'
import inProgress1009 from '../../../../../../packages/buyer-profile/fixtures/tripoint/in-progress-1009.json'
import invalid502 from '../../../../../../packages/buyer-profile/fixtures/tripoint/invalid-502.json'
import fixtures from './fixtures/engine-lead.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { answerWith, runCanvasScript, type CanvasRun, type CanvasResponse } from './canvas-script'

const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const BUILD_RESPONSE_BODY = keptScript('build_response_body')

type Json = Record<string, unknown>
type Response = { isRejected: boolean; body: Json; reject_patch?: Json }

const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }
const sellOffSteps = (): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: fixtures.prospect_trades_sell_off } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})

/** A raw text answer, for the shapes that are not JSON (an HTML page, a truncated body). */
const rawAnswer = (status: number, text: string): CanvasRun['fetch'] => async () => ({ status, text: async () => text })

/** tripoint_ping then build_response_body, the order the canvas runs them. */
async function ping(fetch: CanvasRun['fetch'], steps: CanvasRun['steps'] = sellOffSteps()) {
  const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch })) as Json
  steps.tripoint_ping = { output: tp }
  const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Response
  return { tp, response }
}

const REJECTED = { lead_id: fixtures.payload.leadUuid, status: 'rejected', reason: 'unqualified_lead' }

describe('every known Tripoint answer is named', () => {
  it('a 1001 is accepted and the lead gets its offer', async () => {
    const { tp, response } = await ping(answerWith(success1001.httpStatus, success1001.body))
    expect(tp.tripoint_answer).toBe('accepted')
    expect(tp.unknown_reason).toBeNull()
    expect(tp.qualified).toBe(true)
    expect(response.isRejected).toBe(false)
  })

  for (const [name, fixture] of [['1002', duplicate1002], ['1003', duplicate1003], ['1005', duplicate1005]] as const) {
    it(`a ${name} is declined and the lead is rejected`, async () => {
      const { tp, response } = await ping(answerWith(fixture.httpStatus, fixture.body))
      expect(tp.tripoint_answer).toBe('declined')
      expect(tp.unknown_reason).toBeNull()
      expect(response.isRejected).toBe(true)
      expect(response.body).toEqual(REJECTED)
    })
  }

  it('a decline outside the duplicate set (2001, synthetic) is declined', async () => {
    const { tp } = await ping(answerWith(200, { ok: true, data: { createLead: { id: 'masked', resultCode: 2001 } } }))
    expect(tp.tripoint_answer).toBe('declined')
  })

  it('a 1009 is in_progress, never declined, and the lead is rejected', async () => {
    // 1009 is "Duplicate submission already in progress": Tripoint may still sell
    // it, so it is not a no a second buyer may act on (Dan, 2026-09-24).
    const { tp, response } = await ping(answerWith(inProgress1009.httpStatus, inProgress1009.body))
    expect(tp.tripoint_answer).toBe('in_progress')
    expect(tp.resultCode).toBe(1009)
    expect(response.isRejected).toBe(true)
    expect(response.body).toEqual(REJECTED)
  })

  it('the known 502 refusal of bad lead data is invalid_data', async () => {
    const { tp, response } = await ping(answerWith(invalid502.httpStatus, invalid502.body))
    expect(tp.tripoint_answer).toBe('invalid_data')
    expect(tp.tripointLeadRejected).toBe(true)
    expect(response.isRejected).toBe(true)
  })

  it('the known 502 null id glitch is null_id_fault', async () => {
    const { tp, response } = await ping(answerWith(502, fixtures.tripoint_null_id_502.body))
    expect(tp.tripoint_answer).toBe('null_id_fault')
    expect(tp.tripointTransientFault).toBe(true)
    expect(response.isRejected).toBe(true)
  })

  it('a lead that is not a sell off is skipped and nothing is sent', async () => {
    const steps = sellOffSteps()
    steps.prospect_trades = { output: { body: fixtures.prospect_trades_not_sell_off } }
    const { tp } = await ping(undefined, steps)
    expect(tp.tripoint_answer).toBe('skipped')
    expect(tp.unknown_reason).toBeNull()
  })
})

describe('an answer that is not positively recognised is unknown, and is a normal reject rather than a failed run', () => {
  const cases: Array<[string, CanvasRun['fetch'], string]> = [
    ['a proxy 504 (synthetic body)', rawAnswer(504, '{"ok":false,"error":"upstream timeout"}'), 'http_504'],
    ['a 500 with an empty body (synthetic)', rawAnswer(500, ''), 'http_500'],
    ['a 502 that is neither known fault (synthetic)', answerWith(502, { ok: false, details: [{ message: 'Upstream exploded' }] }), 'http_502'],
    ['an HTML 403 firewall page (synthetic)', rawAnswer(403, '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>'), 'http_403'],
    ['a 400 JSON answer (synthetic)', answerWith(400, { ok: false, error: 'bad request' }), 'http_400'],
    ['a 200 that does not parse (synthetic)', rawAnswer(200, '{"ok":true,"data":{"createLe'), 'unparseable_body'],
    ['a 200 with an empty body (synthetic)', rawAnswer(200, ''), 'unparseable_body'],
    ['a 200 with no result code (synthetic)', answerWith(200, { ok: true, data: { createLead: { id: 'masked' } } }), 'no_result_code'],
    ['a 200 with no createLead at all (synthetic)', answerWith(200, { ok: true, data: {} }), 'no_result_code'],
    ['a 200 whose result code is not a number (synthetic)', answerWith(200, { ok: true, data: { createLead: { id: 'masked', resultCode: 'soon' } } }), 'no_result_code'],
    ['a 200 with ok false and a result code (synthetic)', answerWith(200, { ok: false, data: { createLead: { id: 'masked', resultCode: 1003 } } }), 'not_ok'],
    ['a 4xx carrying a success code (synthetic)', answerWith(409, { ok: true, data: { createLead: { id: 'masked', resultCode: 1001 } } }), 'http_409'],
    ['a fetch that throws (network error)', async () => { throw new TypeError('fetch failed') }, 'network_error'],
  ]

  for (const [name, fetch, reason] of cases) {
    it(`${name}: unknown (${reason}), no throw, a no sale, and the lead is rejected with no Tripoint class`, async () => {
      const { tp, response } = await ping(fetch)
      expect(tp.tripoint_answer).toBe('unknown')
      expect(tp.unknown_reason).toBe(reason)
      // The fields every older reader keys on still say "no sale".
      expect(tp.skipped).toBe(false)
      expect(tp.qualified).toBe(false)
      expect(tp.sale).toMatchObject({ skipped: false, accepted: false, response_class: null })
      expect(response.isRejected).toBe(true)
      expect(response.body).toEqual(REJECTED)
      // No class is written for an answer nobody could read: it is not a Fail.
      expect(response.reject_patch).toEqual({ BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead' })
    })
  }

  it('keeps every legacy field on an unknown answer, adding the two new ones last', async () => {
    const { tp } = await ping(rawAnswer(504, 'gateway timeout'))
    expect(Object.keys(tp)).toEqual(['skipped', 'qualified', 'createLead', 'resultCode', 'debug', 'sale', 'sent_body_sha256', 'tripoint_answer', 'unknown_reason'])
    expect(tp.debug).toMatchObject({ httpStatus: 504, rawText: 'gateway timeout' })
    expect(typeof tp.sent_body_sha256).toBe('string')
  })

  it('records the thrown message on a network error, so the run shows why', async () => {
    const { tp } = await ping(async () => { throw new TypeError('fetch failed') })
    expect(tp.debug).toMatchObject({ httpStatus: null, rawText: null, error: 'fetch failed' })
  })
})

describe('a Tripoint call that does not answer within 15 seconds is aborted and unknown', () => {
  afterEach(() => { vi.useRealTimers() })

  /** A fetch that never answers on its own: it settles only when its signal aborts, as the platform fetch does. */
  function hangingFetch() {
    let called!: () => void
    const wasCalled = new Promise<void>((r) => { called = r })
    let signal: AbortSignal | undefined
    const fetch: CanvasRun['fetch'] = (_url, init) => {
      signal = (init as { signal?: AbortSignal } | undefined)?.signal
      called()
      return new Promise<CanvasResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    return { fetch, wasCalled, signal: () => signal }
  }

  it('is still waiting at 14.999 s and is unknown (timeout) at 15 s, below the node timeout of 20 s', async () => {
    vi.useFakeTimers()
    const h = hangingFetch()
    const steps = sellOffSteps()
    let settled = false
    const run = runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: h.fetch }).then((v) => { settled = true; return v as Json })
    await h.wasCalled
    expect(h.signal()).toBeDefined()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    expect(h.signal()?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const tp = await run
    expect(h.signal()?.aborted).toBe(true)
    expect(tp.tripoint_answer).toBe('unknown')
    expect(tp.unknown_reason).toBe('timeout')
    expect(tp.qualified).toBe(false)
    steps.tripoint_ping = { output: tp }
    const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Response
    expect(response.isRejected).toBe(true)
    expect(response.body).toEqual(REJECTED)
  })

  it('clears its timer once Tripoint has answered, so a fast answer leaves nothing pending', async () => {
    vi.useFakeTimers()
    const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps: sellOffSteps(), fetch: answerWith(success1001.httpStatus, success1001.body) })) as Json
    expect(tp.tripoint_answer).toBe('accepted')
    expect(vi.getTimerCount()).toBe(0)
  })
})
