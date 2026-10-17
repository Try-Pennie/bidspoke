/**
 * The circuit breaker page while the database is down (#1849).
 *
 * alertIfTripped runs on partner_bid's error path while the lead waits. Its
 * Slack connection lookup read service_connections with no deadline and, on a
 * lead's client, no retries, so a database that hung held the lead for ever, and
 * one that refused dropped the page. The lookup now goes through leadRead (one
 * bounded attempt) and falls back to the encrypted last-good copy of the Slack
 * connections the database probe keeps (database-reachability.ts), and the
 * whole page is bounded.
 *
 * The real supabase-js client runs throughout; only the network beneath it is
 * replaced. Slack's own address is answered by a stubbed global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../../../index'
import { CIRCUIT_ALERT_DEADLINE_MS, alertIfTripped } from '../partner-bid'
import { createLeadSupabaseClient, LEAD_READ_DEADLINE_MS } from '../../../lib/lead-read-budget'
import { readLastGoodSlackConnections, SLACK_CONNS_LASTGOOD_KEY } from '../../../lib/slack-copy'
import { encryptSecret } from '../../../lib/secret-crypto'
import { slackPostOf } from '../../../__tests__/helpers/slack-fetch'

const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const KEY = btoa('1'.repeat(32))
const TRIPPED = { ok: true, state: 'open', tripped: true } as const

function kvWith(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries))
  return { get: vi.fn(async (k: string) => store.get(k) ?? null) } as unknown as KVNamespace
}

/** The database network: refuses, hangs until the read is aborted, or answers with the org's connection. */
function database(mode: 'refuse' | 'hang' | 'up') {
  const state = { calls: 0 }
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++
    if (mode === 'refuse') throw new TypeError('fetch failed')
    if (mode === 'hang') {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(new DOMException('The operation was aborted.', 'AbortError'))
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    // A read is answered with an array: the lookup asks for up to two alert rows (#2332).
    return new Response(JSON.stringify([{ config: { bot_token: 'xoxb-live', default_channel: 'C-LIVE' } }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { state, fetch }
}

let slackPosts: Array<{ auth: string | null; channel: string }>
beforeEach(() => {
  slackPosts = []
  vi.stubGlobal('fetch', vi.fn(async (...call: unknown[]) => {
    const post = await slackPostOf(call)
    expect(post.url).toBe('https://slack.com/api/chat.postMessage')
    slackPosts.push({ auth: post.token === null ? null : `Bearer ${post.token}`, channel: String(post.channel) })
    return new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function lastGoodCopy() {
  const blob = await encryptSecret(JSON.stringify({ 'org-1': { bot_token: 'xoxb-copy', default_channel: 'C-COPY' } }), KEY)
  const kv = kvWith({ [SLACK_CONNS_LASTGOOD_KEY]: blob })
  return () => readLastGoodSlackConnections(kv, KEY)
}

describe('the circuit breaker page while the database is down (#1849)', () => {
  it('a refused lookup asks the database once and pages from the last-good copy', async () => {
    const db = database('refuse')
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch })
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', TRIPPED, {}, { lastGoodSlack: await lastGoodCopy() })
    expect(alerted).toBe(true)
    expect(db.state.calls).toBe(1)
    expect(slackPosts).toEqual([{ auth: 'Bearer xoxb-copy', channel: 'C-COPY' }])
  })

  it('a lookup that hangs is ended by the lead read deadline, and the page still goes out from the copy', async () => {
    const db = database('hang')
    const asked: number[] = []
    // The deadline fires at once, standing in for the time passing.
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline: (ms) => { asked.push(ms); return AbortSignal.abort() } })
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', TRIPPED, {}, { lastGoodSlack: await lastGoodCopy() })
    expect(alerted).toBe(true)
    expect(asked).toEqual([LEAD_READ_DEADLINE_MS])
    expect(slackPosts).toEqual([{ auth: 'Bearer xoxb-copy', channel: 'C-COPY' }])
  })

  it('a healthy database pages from the live connection and never reads the copy', async () => {
    const db = database('up')
    const lastGoodSlack = vi.fn(await lastGoodCopy())
    const alerted = await alertIfTripped(createLeadSupabaseClient(env, { fetch: db.fetch }), 'org-1', 'sofi', TRIPPED, {}, { lastGoodSlack })
    expect(alerted).toBe(true)
    expect(lastGoodSlack).not.toHaveBeenCalled()
    expect(slackPosts).toEqual([{ auth: 'Bearer xoxb-live', channel: 'C-LIVE' }])
  })

  it('a Slack post that never answers is ended by the page deadline, so the lead is not held', async () => {
    const slackNeverAnswers = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', slackNeverAnswers)
    const pending: Array<{ fn: () => void; ms: number }> = []
    const timers: Timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length }, clearTimeout: () => undefined }
    const db = database('up')
    const p = alertIfTripped(createLeadSupabaseClient(env, { fetch: db.fetch }), 'org-1', 'sofi', TRIPPED, {}, { lastGoodSlack: await lastGoodCopy(), timers })
    expect(pending.map((t) => t.ms)).toEqual([CIRCUIT_ALERT_DEADLINE_MS])
    pending[0].fn()
    await expect(p).resolves.toBe(true)
    // The deadline ends the page before its lookup has answered, and the page
    // goes on to post once it does. Seen to post here, to the stub that never
    // answers: left to run past the test, it posted through the REAL fetch once
    // afterEach unstubbed it, reached slack.com and logged invalid_auth into a
    // closed worker (#2120).
    await vi.waitFor(() => expect(slackNeverAnswers).toHaveBeenCalledTimes(1))
  })
})
