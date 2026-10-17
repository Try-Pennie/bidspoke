/**
 * A scheduled check whose finding needs no database still speaks while the
 * database stalls (#1303 phase 1). The required secrets check reads only the
 * worker's env, and before this went silent in an outage only because its Slack
 * lookups could not be read. Driven end to end: the real supabase-js client the
 * scheduled handler builds, a network under it that never answers, and the real
 * sender posting to a stubbed Slack. Each outage case is first proven to post
 * with the database up in the same fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../env'
import { runRequiredSecretsCheck } from '../required-secrets'
import { createScheduledSupabaseClient } from '../scheduled-slack'
import { fakeTimers, kvWith, kvWithCopy, TEST_KEY, type CountingKv } from './_scheduled-slack-doubles'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

const ORG = 'org-1'
const CONN = { bot_token: 'xoxb-live', default_channel: '#ops', config_alerts_enabled: true }
const STORED = { ...CONN, bot_token: 'xoxb-stored' }

// Every required secret is unset, so the check has something to say.
const env = (kv: CountingKv) => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  SECRET_ENCRYPTION_KEY: TEST_KEY,
  IDEMPOTENCY: kv,
}) as unknown as Env

/** The database: answers the org list and the org's connection, or never answers. */
function database(mode: 'up' | 'stalled') {
  const requests: string[] = []
  const network: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    if (mode === 'stalled') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
    // PostgREST answers a read with an array (the connection read asks for up to two alert rows, #2332).
    const body = url.includes('select=config') ? [{ config: CONN }] : [{ organization_id: ORG }]
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof globalThis.fetch
  return { fetch: network, requests }
}

let posts: Array<{ token: string; channel: string }>
let logs: string[]
beforeEach(() => {
  posts = []
  logs = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...call) => {
    const post = await slackPostOf(call)
    posts.push({ token: `Bearer ${post.token}`, channel: String(post.channel) })
    return new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 })
  })
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('the required secrets alert during a database stall', () => {
  it('posts once with the live connection while the database answers (the positive control)', async () => {
    const db = database('up')
    const client = createScheduledSupabaseClient(env(await kvWithCopy({ [ORG]: STORED })), () => {}, { fetch: db.fetch, sleep: fakeTimers('never').sleep })
    const r = await runRequiredSecretsCheck(client, env(kvWith()))
    expect(r.alerted).toBe(true)
    expect(posts).toEqual([{ token: 'Bearer xoxb-live', channel: '#ops' }])
  })

  it('posts once from the saved copy when the database never answers, asking it only once', async () => {
    const db = database('stalled')
    const kv = await kvWithCopy({ [ORG]: STORED })
    const client = createScheduledSupabaseClient(env(kv), () => {}, { fetch: db.fetch, sleep: fakeTimers('now').sleep })
    const r = await runRequiredSecretsCheck(client, env(kvWith()))
    expect(r.alerted).toBe(true)
    expect(posts).toEqual([{ token: 'Bearer xoxb-stored', channel: '#ops' }])
    // The org list stalled; the org's own lookup then went straight to the copy.
    expect(db.requests).toHaveLength(1)
    expect(kv.gets).toHaveLength(1)
  })

  it('posts nothing and says why when the database never answers and there is no copy', async () => {
    const db = database('stalled')
    const client = createScheduledSupabaseClient(env(kvWith()), () => {}, { fetch: db.fetch, sleep: fakeTimers('now').sleep })
    const r = await runRequiredSecretsCheck(client, env(kvWith()))
    expect(r.alerted).toBe(false)
    expect(posts).toEqual([])
    expect(logs.some((l) => l.includes('nobody can be told') && l.includes('there is no saved copy'))).toBe(true)
  })
})
