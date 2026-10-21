/**
 * The LendSwift error answers the money gate replays (#2582).
 *
 * On 2026-10-21 LendSwift's decide service failed about two pings in three for a
 * quarter of an hour, in two shapes: a runtime error in their own flow
 * (`AttributeError: Attribute: data not found`) and a provider failure whose
 * message embeds a provider URL, which for one provider carries the applicant's
 * SSN. These stubs are synthetic copies of those shapes, plus a 200 that carries
 * no decision, so the RML LendSwift fixtures replay each one through the engine.
 * A fetch that rejects is not modelled: an outbound service that throws reaches a
 * code bundle in the nested workerd as an HTTP 500, not as a rejection.
 */
import { describe, expect, it } from 'vitest'
import { stubAnswer, toResponse, type StubRequest } from '../stub-rules'

const decide: StubRequest = {
  method: 'POST',
  url: new URL('https://risk.bf9baa41.decide.taktile.com/run/api/v1/flows/training/decide'),
  headers: {},
  body: {},
}

describe('taktile_decide error scenarios (#2582)', () => {
  it('answers the runtime error shape of 2026-10-21 as a 500 whose detail names the error', async () => {
    const hit = stubAnswer(decide, { taktile_decide: 'decide_error' })
    expect(hit?.rule).toBe('taktile_decide')
    const res = toResponse(hit!.answer)
    expect(res.status).toBe(500)
    const body = await res.json() as { status: string; detail: { msg: string; exc_type: string }; metadata: { decision_id: string } }
    expect(body.status).toBe('error')
    expect(body.detail.msg).toBe('AttributeError: Attribute: `data` not found')
    expect(body.detail.exc_type).toBe('runtime')
    expect(typeof body.metadata.decision_id).toBe('string')
  })

  it('answers a provider timeout whose message embeds a provider URL ending in nine digits', async () => {
    const res = toResponse(stubAnswer(decide, { taktile_decide: 'provider_timeout' })!.answer)
    expect(res.status).toBe(500)
    const body = await res.json() as { detail: { msg: string } }
    expect(body.detail.msg).toContain(' Details: ')
    const inner = JSON.parse(body.detail.msg.slice(body.detail.msg.indexOf(' Details: ') + ' Details: '.length)) as { detail: { msg: string; type: string }[] }
    expect(inner.detail[0].type).toBe('provider_timeout')
    expect(inner.detail[0].msg).toMatch(/\/ssn\/\d{9}$/)
  })

  it('answers no_decision as a 200 that carries no data object', async () => {
    const res = toResponse(stubAnswer(decide, { taktile_decide: 'no_decision' })!.answer)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('error')
    expect(body.data).toBeUndefined()
  })

  it('keeps the existing scenarios answering as before', () => {
    expect(toResponse(stubAnswer(decide, { taktile_decide: 'outage' })!.answer).status).toBe(503)
    expect(toResponse(stubAnswer(decide, {})!.answer).status).toBe(200)
  })
})
