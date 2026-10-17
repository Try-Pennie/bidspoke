/**
 * The outage line's tick context in workerd (#2061, lib/outage-notice.ts).
 *
 * The line reaches a scheduled tick's alerts only because AsyncLocalStorage
 * carries the tick's context through every await of every job, which the worker
 * gets from the nodejs_compat flag in wrangler.toml. The Node suite proves the
 * logic on Node's own AsyncLocalStorage; this proves the platform guarantee it
 * rests on, in workerd with this repo's flags (L82): the context survives a
 * timer, a microtask chain and a promise left running on its own, and a call
 * outside the tick, made at the same time, sees none of it. It lives here
 * because this folder is what the Workers test project runs.
 */
import { describe, expect, it } from 'vitest'
import { openOutageForPost, runInScheduledTick, runWithOutageNotice } from '../../lib/outage-notice'
import { registerScheduledSlack } from '../../lib/scheduled-slack'
import { postMessage } from '../../lib/slack'
import { encryptSecret } from '../../lib/secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY, SLACK_COPY_SAVED_AT_KEY } from '../../lib/slack-copy'
import { slackPostJsonOf } from '../../__tests__/helpers/slack-fetch'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const ORG = '55555555-5555-4555-8555-555555555555'
const REPORTED = '2026-10-15T01:14:00.000Z'

async function source() {
  const store = new Map<string, string>([
    [SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify({ [ORG]: { bot_token: 'xoxb-t', default_channel: 'C1' }, [SLACK_COPY_SAVED_AT_KEY]: REPORTED }), KEY)],
    [`db-unreachable-recovery:${ORG}`, REPORTED],
  ])
  const kv = { get: async (k: string) => store.get(k) ?? null }
  return { kv, scheduled: registerScheduledSlack({}, { kv, secretKeys: KEY }) }
}

const afterTimer = () => new Promise<void>((resolve) => setTimeout(resolve, 1))

describe('the outage line context in workerd (#2061)', () => {
  it('reaches a post made after a timer, inside a promise the tick left running', async () => {
    const s = await source()
    let detached: Promise<unknown> = Promise.resolve()
    await runWithOutageNotice(s, async () => {
      // A job handed to waitUntil: started inside the tick, awaited by nobody here.
      detached = (async () => {
        await afterTimer()
        await Promise.resolve().then(() => undefined)
        return openOutageForPost()
      })()
    })
    const seen = (await detached) as Awaited<ReturnType<typeof openOutageForPost>>
    expect(seen?.reportedAtMs).toBe(Date.parse(REPORTED))
  })

  it('gives a call outside the tick, made while the tick runs, nothing', async () => {
    const s = await source()
    const inside = runWithOutageNotice(s, async () => {
      await afterTimer()
      return openOutageForPost()
    })
    const outside = (async () => {
      await afterTimer()
      return openOutageForPost()
    })()
    const [a, b] = await Promise.all([inside, outside])
    expect(a).not.toBeNull()
    expect(b).toBeNull()
  })

  // The whole path in workerd: slack.ts loads with the import (and with it the
  // Slack client library, #2331), and a post made after a timer inside the tick
  // carries the line.
  it('adds the line to a post made inside the tick, through slack.ts', async () => {
    const s = await source()
    const sent: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(await slackPostJsonOf([input, init]))
      return new Response(JSON.stringify({ ok: true, ts: '1.2' }))
    }) as typeof fetch
    try {
      await runWithOutageNotice(s, async () => {
        await afterTimer()
        await postMessage('xoxb-t', 'C1', [{ type: 'header', text: { type: 'plain_text', text: 'T' } }], 'T')
      })
      await postMessage('xoxb-t', 'C1', [{ type: 'header', text: { type: 'plain_text', text: 'T' } }], 'T')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('Sent during the database outage reported at')
    expect(sent[1]).not.toContain('database outage')
  })

  it('keeps two ticks apart', async () => {
    const s = await source()
    const unattached = runInScheduledTick(async () => {
      await afterTimer()
      return openOutageForPost()
    })
    const attached = runWithOutageNotice(s, async () => {
      await afterTimer()
      return openOutageForPost()
    })
    const [a, b] = await Promise.all([unattached, attached])
    expect(a).toBeNull()
    expect(b).not.toBeNull()
  })
})
