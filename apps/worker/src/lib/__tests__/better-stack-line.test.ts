import { describe, expect, it } from 'vitest'
import { betterStackTarget, sendBetterStackLine } from '../better-stack-line'

/**
 * The one request that sends a fixed line to the Better Stack HTTP log source
 * (#2364). The nobody can be told page, its drill, the row cap report and the
 * Slack refusal page all send through it, so a drill proves the very request a
 * real page makes, and there is one copy of the token handling to get right.
 */
const URL_ = 'https://s1.us-east-9.betterstackdata.com'
const TOKEN = 'source-token-for-tests'
const neverExpires = () => new Promise<void>(() => {})

function recordingFetch(answer: number | 'throw' | 'stall') {
  const sent: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = ((url: string, init: RequestInit) => {
    sent.push({ url, init })
    if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'))
    if (answer === 'stall') return new Promise(() => {})
    return Promise.resolve(new Response(null, { status: answer }))
  }) as unknown as typeof fetch
  return { sent, fetchFn }
}

describe('sendBetterStackLine', () => {
  it('posts the event as JSON with the bearer token, and answers sent with the status', async () => {
    const f = recordingFetch(202)
    const out = await sendBetterStackLine({ token: ` ${TOKEN} `, url: ` ${URL_} `, fetch: f.fetchFn, delay: neverExpires }, { message: 'm', dt: 'x' }, 5_000)
    expect(out).toEqual({ outcome: 'sent', status: 202 })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].url).toBe(URL_)
    expect(f.sent[0].init.method).toBe('POST')
    expect(new Headers(f.sent[0].init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(f.sent[0].init.body))).toEqual({ message: 'm', dt: 'x' })
  })

  it('answers refused with a status that is not 2xx', async () => {
    const f = recordingFetch(401)
    expect(await sendBetterStackLine({ token: TOKEN, url: URL_, fetch: f.fetchFn, delay: neverExpires }, {}, 5_000)).toEqual({ outcome: 'refused', status: 401 })
  })

  it('answers threw when the request fails', async () => {
    const f = recordingFetch('throw')
    expect(await sendBetterStackLine({ token: TOKEN, url: URL_, fetch: f.fetchFn, delay: neverExpires }, {}, 5_000)).toEqual({ outcome: 'threw', error: 'fetch failed' })
  })

  it('answers no_answer once the deadline passes, through the injected timer', async () => {
    const f = recordingFetch('stall')
    expect(await sendBetterStackLine({ token: TOKEN, url: URL_, fetch: f.fetchFn, delay: () => Promise.resolve() }, {}, 5_000)).toEqual({ outcome: 'no_answer', deadline_ms: 5_000 })
  })

  it('answers not_configured, naming each unset secret, and sends nothing', async () => {
    const f = recordingFetch(202)
    expect(await sendBetterStackLine({ token: '  ', url: undefined, fetch: f.fetchFn, delay: neverExpires }, {}, 5_000)).toEqual({ outcome: 'not_configured', missing: ['BETTERSTACK_OUTAGE_TOKEN', 'BETTERSTACK_OUTAGE_URL'] })
    expect(f.sent).toEqual([])
  })

  it('betterStackTarget trims both secrets and names the missing ones', () => {
    expect(betterStackTarget(` ${TOKEN}`, undefined)).toEqual({ token: TOKEN, url: '', missing: ['BETTERSTACK_OUTAGE_URL'] })
  })
})
