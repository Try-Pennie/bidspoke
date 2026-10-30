/**
 * A buyer call that gets no complete answer, as the money gate replays it (#3086).
 *
 * The gate's stubs used to answer every request with a whole response, so the
 * buyer select live path after a call that THROWS (our 20 s timer, a dropped
 * connection, a body cut off or still trickling at the limit) was never replayed.
 * These are the endings a stub answer can now carry, played out by answerFetch
 * as the platform's fetch would, waiting only on the replay's own time.
 */
import { describe, expect, it } from 'vitest'
import { TRICKLE_EVERY_MS, answerFetch, codeBundleRefusal, isReplayedNoAnswerRejection, stubAnswer, toResponse, type StubAnswer, type StubRequest, type WaitOnReplayTime } from '../stub-rules'
import { liftEngineTimers, type TimerHost } from '../engine-timers'
import { noAnswerOf, postToPartner } from '../../../src/lib/post-to-partner'
import { BUYER_CALL_TIMEOUT_MS } from '../../../src/engine/nodes/buyer-select'
import type { Env } from '../../../src/index'

const create: StubRequest = { method: 'POST', url: new URL('https://tripoint-proxy.trypennie.dev/leads/create'), headers: {}, body: {} }
const ACCEPTED_TEXT = '{"ok":true,"data":{"createLead":{"id":"TP-GATE-0005","resultCode":1000}}}'

const answerOf = (scenario: string): StubAnswer => stubAnswer(create, { tripoint_create: scenario })!.answer

/** A wait that never expects to be asked: an ending that needs no time must not take any. */
const noWait: WaitOnReplayTime = () => { throw new Error('this ending waited on the replay time') }

/** A wait on the signal alone, answering each timed wait as elapsed at once, and recording what it was asked. */
function recordingWait(): { wait: WaitOnReplayTime; asked: Array<number | undefined> } {
  const asked: Array<number | undefined> = []
  const wait: WaitOnReplayTime = (signal, ms) => {
    asked.push(ms)
    if (ms !== undefined) return Promise.resolve(signal.aborted ? 'aborted' : 'elapsed')
    return new Promise((resolve) => {
      if (signal.aborted) return resolve('aborted')
      signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
  }
  return { wait, asked }
}

describe('tripoint_create endings with no complete answer (#3086)', () => {
  it('has a scenario for each way the live buyer call gets no answer, each an acceptance that never arrives whole', () => {
    expect(answerOf('no_answer_timeout').ending).toBe('no_headers')
    expect(answerOf('connection_failed').ending).toBe('connection_failed')
    expect(answerOf('body_cut_off')).toMatchObject({ ending: 'body_cut_off', status: 200 })
    expect(answerOf('body_trickle_timeout')).toMatchObject({ ending: 'body_trickles', status: 200 })
    expect(JSON.stringify(answerOf('body_cut_off').body)).toBe(ACCEPTED_TEXT)
  })

  it('a whole answer is never given an ending, so every existing fixture is answered as before', () => {
    expect(answerOf('accepted').ending).toBeUndefined()
    expect(answerOf('outage').ending).toBeUndefined()
  })

  it('toResponse refuses an answer that does not arrive whole, rather than sending it whole', () => {
    expect(() => toResponse(answerOf('connection_failed'))).toThrow('does not arrive whole')
  })
})

describe('answerFetch (#3086)', () => {
  it('a whole answer is the same Response toResponse gives, with no wait', async () => {
    const res = await answerFetch(answerOf('accepted'), new AbortController().signal, noWait)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true,"data":{"createLead":{"id":"TP-GATE-0001","resultCode":1000}}}')
  })

  it('connection_failed rejects before any header with nothing aborted, and waits for nothing', async () => {
    const controller = new AbortController()
    const err = await answerFetch(answerOf('connection_failed'), controller.signal, noWait).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(controller.signal.aborted).toBe(false)
  })

  it('no_headers waits on the replay time for the abort alone, then rejects with the signal\'s own reason', async () => {
    const controller = new AbortController()
    const { wait, asked } = recordingWait()
    const pending = answerFetch(answerOf('no_answer_timeout'), controller.signal, wait).catch((e: unknown) => e)
    await Promise.resolve()
    controller.abort()
    const err = await pending
    expect(err).toBe(controller.signal.reason)
    expect((err as DOMException).name).toBe('AbortError')
    expect(asked).toEqual([undefined])
  })

  it('refuses by name a held answer for a request with no signal, which nothing could ever end', async () => {
    await expect(answerFetch(answerOf('no_answer_timeout'), undefined, noWait)).rejects.toThrow('no signal')
    await expect(answerFetch(answerOf('body_trickle_timeout'), undefined, noWait)).rejects.toThrow('no signal')
  })

  it('body_cut_off gives the headers, then the body read fails after its first piece, with nothing aborted', async () => {
    const controller = new AbortController()
    const res = await answerFetch(answerOf('body_cut_off'), controller.signal, noWait)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(ACCEPTED_TEXT.slice(0, Math.ceil(ACCEPTED_TEXT.length / 8)))
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError)
    expect(controller.signal.aborted).toBe(false)
  })

  it('body_trickles sends a piece every TRICKLE_EVERY_MS of replay time, and the abort ends the body with the signal\'s reason', async () => {
    const controller = new AbortController()
    const { wait, asked } = recordingWait()
    const res = await answerFetch(answerOf('body_trickle_timeout'), controller.signal, wait)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const pieces: string[] = []
    for (let i = 0; i < 3; i++) pieces.push(new TextDecoder().decode((await reader.read()).value))
    expect(pieces.join('')).toBe(ACCEPTED_TEXT.slice(0, pieces.join('').length))
    expect(asked).toEqual([TRICKLE_EVERY_MS, TRICKLE_EVERY_MS])
    controller.abort()
    await expect(reader.read()).rejects.toBe(controller.signal.reason)
  })

  it('body_trickles would take its whole body past the buyer call\'s 20 s limit', () => {
    expect(TRICKLE_EVERY_MS * 7).toBeGreaterThan(BUYER_CALL_TIMEOUT_MS)
  })
})

/**
 * workerd reports a rejected fetch as unhandled even when its caller awaits it
 * (README, the outage drill's known quirk), and postToPartner does await these:
 * the replay records each as no answer. So the gate's config ignores exactly
 * these two rejections, matched on the error and its origin in the gate's files.
 */
describe('isReplayedNoAnswerRejection (#3086)', () => {
  it('recognises a dropped connection the stub played out, also once serialized', async () => {
    const err = (await answerFetch(answerOf('connection_failed'), new AbortController().signal, noWait).catch((e: unknown) => e)) as Error
    expect(isReplayedNoAnswerRejection(err)).toBe(true)
    expect(isReplayedNoAnswerRejection({ name: err.name, message: err.message, stack: err.stack })).toBe(true)
  })

  it('recognises an abort a held answer caused by moving the replay\'s time on', async () => {
    const lift = liftEngineTimers(globalThis as unknown as TimerHost)
    let err: unknown
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), BUYER_CALL_TIMEOUT_MS)
      err = await answerFetch(answerOf('no_answer_timeout'), controller.signal, (s, ms) => lift.waitFor(s, ms)).catch((e: unknown) => e)
    } finally {
      lift.restore()
    }
    expect((err as Error).name).toBe('AbortError')
    expect(isReplayedNoAnswerRejection(err)).toBe(true)
  })

  it.each([
    ['a dropped connection from anywhere else', Object.assign(new TypeError('money gate: network connection lost'), { stack: 'TypeError: money gate: network connection lost\n    at somewhere (src/engine/index.ts:1:1)' })],
    ['an abort no advance caused', Object.assign(new DOMException('The operation was aborted', 'AbortError'), { stack: 'AbortError: The operation was aborted\n    at abortAfter (src/engine/step-timeout.ts:193:16)' })],
    ['another error from the stub rules', Object.assign(new Error('boom'), { stack: 'Error: boom\n    at answerFetch (money-gate/lib/stub-rules.ts:491:42)' })],
    ['not an error at all', 'money gate: network connection lost'],
    ['nothing', undefined],
  ])('does not recognise %s', (_why, err) => {
    expect(isReplayedNoAnswerRejection(err)).toBe(false)
  })
})

describe('codeBundleRefusal (#3086)', () => {
  it('names the fixture, the rule and the scenario of an ending a code bundle cannot be given', () => {
    const hit = stubAnswer(create, { tripoint_create: 'no_answer_timeout' })!
    const text = codeBundleRefusal(hit, 'Engine Bidding Workflow/x')
    expect(text).toContain('Engine Bidding Workflow/x')
    expect(text).toContain('tripoint_create/no_answer_timeout')
  })

  it('says nothing of a whole answer', () => {
    expect(codeBundleRefusal(stubAnswer(create, {})!, 'x')).toBeNull()
  })
})

/**
 * The whole path as the replay runs it: postToPartner's own 20 s timer, under the
 * gate's lift, is the timer the replay's time moves on to, so the call ends as our
 * timer and nothing waits for real. A lift that stopped reaching abortAfter would
 * leave the held call waiting with no timer to end it, and this fails by name.
 */
describe('a held buyer call under the gate\'s timer lift (#3086)', () => {
  const env = { TRIPOINT_PROXY_SECRET: 'money-gate-secret' } as unknown as Env
  const target = { slug: 'tripoint', api_endpoint: 'https://tripoint-proxy.trypennie.dev/leads/create', cf_secret_key: 'TRIPOINT_PROXY_SECRET' }

  async function callUnderLift(scenario: string) {
    const lift = liftEngineTimers(globalThis as unknown as TimerHost)
    const fetchImpl = ((_url: string, init?: RequestInit) => answerFetch(answerOf(scenario), init?.signal ?? undefined, (s, ms) => lift.waitFor(s, ms))) as unknown as typeof fetch
    const started = performance.now()
    try {
      const err = await postToPartner(target, { leadUuid: 'gate-lead' }, env, { traceId: 'gate-trace', timeoutMs: BUYER_CALL_TIMEOUT_MS, fetchImpl }).catch((e: unknown) => e)
      return { err, realMs: performance.now() - started, fired: lift.fired(), advanced: lift.advanced() }
    } finally {
      lift.restore()
    }
  }

  it('no headers: our 20 s timer stops the call, advanced rather than waited for', async () => {
    const { err, realMs, fired, advanced } = await callUnderLift('no_answer_timeout')
    expect(noAnswerOf(err)).toEqual({ cause: 'our_timer', after_ms: BUYER_CALL_TIMEOUT_MS })
    expect(advanced.map((t) => t.requestedMs)).toEqual([BUYER_CALL_TIMEOUT_MS])
    expect(fired).toEqual([])
    expect(realMs).toBeLessThan(5_000)
  })

  it('a trickling body: our timer stops it at 20 s, after the pieces due before it', async () => {
    const { err, fired, advanced } = await callUnderLift('body_trickle_timeout')
    expect(noAnswerOf(err)).toEqual({ cause: 'our_timer', after_ms: BUYER_CALL_TIMEOUT_MS })
    expect(advanced.map((t) => t.requestedMs)).toEqual([TRICKLE_EVERY_MS, TRICKLE_EVERY_MS, TRICKLE_EVERY_MS, BUYER_CALL_TIMEOUT_MS])
    expect(fired).toEqual([])
  })

  it('a dropped connection and a body cut off are the connection, with no timer moved', async () => {
    for (const scenario of ['connection_failed', 'body_cut_off']) {
      const { err, advanced } = await callUnderLift(scenario)
      expect(noAnswerOf(err), scenario).toEqual({ cause: 'connection' })
      expect(advanced, scenario).toEqual([])
    }
  })
})
