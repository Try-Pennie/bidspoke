/**
 * The Slack lookup on the scheduled handler's client (#1303 phase 1).
 *
 * On 2026-10-08 the database stalled: reads hung rather than failing, and one
 * Slack lookup could take about 136 s (three attempts at the 45 s client
 * deadline) before anything else ran. On the one client the scheduled handler
 * registers, getSlackConnection now asks the database once under a 3 s
 * deadline, falls back to the encrypted last-good copy on every non-answer, and
 * after the first failure in a tick sends every later lookup straight to the
 * copy. Every other client (the request and engine paths) is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSlackConnection, lookupSlackConnection } from '../slack'
import { slackOrgIds } from '../alert-fanout'
import { createScheduledSupabaseClient, registerScheduledSlack, scheduledSlackFor, SCHEDULED_SLACK_READ_DEADLINE_MS } from '../scheduled-slack'
import type { Env } from '../../env'
import { encryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY } from '../slack-copy'
import { fakeClient, fakeTimers, kvWith, kvWithCopy, LIVE_CONN, OTHER_KEY, STORED_CONN, TEST_KEY, type Answer } from './_scheduled-slack-doubles'

const ORG = 'org-1'

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

async function scheduled(answers: Answer[], opts: { copy?: Record<string, unknown> | null; timers?: 'never' | 'now'; now?: () => number } = {}) {
  const { client, calls } = fakeClient(answers)
  const kv = opts.copy === null || opts.copy === undefined ? kvWith() : await kvWithCopy(opts.copy)
  const timers = fakeTimers(opts.timers ?? 'never')
  registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: timers.sleep, now: opts.now })
  return { client, calls, kv, timers }
}

describe('the lookup on the scheduled client', () => {
  it('answers live from the database, without reading the copy', async () => {
    const { client, calls, kv, timers } = await scheduled([{ data: { config: LIVE_CONN } }], { copy: { [ORG]: STORED_CONN } })
    const result = await lookupSlackConnection(client, ORG)
    expect(result.kind).toBe('live')
    // The deadline timer is stopped once the read answers, so none outlives it.
    expect(timers.signals.every((s) => s.aborted)).toBe(true)
    expect((await getSlackConnection(client, ORG))?.bot_token).toBe('xoxb-live')
    expect(kv.gets).toEqual([])
    expect(calls.every((c) => c.retry === false)).toBe(true)
  })

  it('answers none when the database answered with no usable connection, without reading the copy', async () => {
    const { client, kv } = await scheduled([{ data: null }], { copy: { [ORG]: STORED_CONN } })
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'none' })
    expect(await getSlackConnection(client, ORG)).toBeNull()
    expect(kv.gets).toEqual([])
  })

  it('gives up on a read that never answers after the 3 s deadline, aborts it, and answers from the copy', async () => {
    const { client, calls, timers } = await scheduled(['stall'], { copy: { [ORG]: STORED_CONN }, timers: 'now' })
    const result = await lookupSlackConnection(client, ORG)
    expect(result).toMatchObject({ kind: 'stored', connection: { bot_token: 'xoxb-stored' } })
    expect(timers.asked).toEqual([SCHEDULED_SLACK_READ_DEADLINE_MS])
    expect(SCHEDULED_SLACK_READ_DEADLINE_MS).toBe(3_000)
    expect(calls).toHaveLength(1)
    expect(calls[0].aborted).toBe(true)
  })

  it.each<[string, Answer]>([
    ['an error object', { error: { message: 'upstream connect error' } }],
    ['a permanent error', { error: { code: '42P01', message: 'relation does not exist' } }],
    ['a thrown fetch', 'throw'],
  ])('answers from the copy on %s, after one read and no retry', async (_label, answer) => {
    const { client, calls } = await scheduled([answer], { copy: { [ORG]: STORED_CONN } })
    const conn = await getSlackConnection(client, ORG)
    expect(conn?.bot_token).toBe('xoxb-stored')
    expect(calls).toHaveLength(1)
  })

  it('after the first failed read in the tick, sends the next lookup straight to the copy without asking', async () => {
    const { client, calls } = await scheduled([{ error: { message: 'boom' } }, { data: { config: LIVE_CONN } }], {
      copy: { [ORG]: STORED_CONN, 'org-2': { ...STORED_CONN, bot_token: 'xoxb-stored-2' } },
    })
    await lookupSlackConnection(client, ORG)
    const second = await lookupSlackConnection(client, 'org-2')
    expect(second).toMatchObject({ kind: 'stored', connection: { bot_token: 'xoxb-stored-2' } })
    expect(calls).toHaveLength(1)
  })

  it('decrypts the copy once per tick however many lookups use it', async () => {
    const { client, kv } = await scheduled([{ error: { message: 'boom' } }], {
      copy: { [ORG]: STORED_CONN, 'org-2': STORED_CONN },
    })
    await lookupSlackConnection(client, ORG)
    await lookupSlackConnection(client, 'org-2')
    await lookupSlackConnection(client, ORG)
    expect(kv.gets).toEqual([SLACK_CONNS_LASTGOOD_KEY])
  })

  it('reports the copy age from its save time, and says the age is unknown when it carries none', async () => {
    const savedAt = Date.parse('2026-10-14T12:00:00Z')
    const { client } = await scheduled([{ error: { message: 'boom' } }], {
      copy: { __saved_at: new Date(savedAt).toISOString(), [ORG]: STORED_CONN },
      now: () => savedAt + 7 * 60_000,
    })
    expect(await lookupSlackConnection(client, ORG)).toMatchObject({ kind: 'stored', ageMs: 7 * 60_000 })
    expect(logs.some((l) => l.includes('saved 7 minutes ago'))).toBe(true)

    logs.length = 0
    const old = await scheduled([{ error: { message: 'boom' } }], { copy: { [ORG]: STORED_CONN } })
    expect(await lookupSlackConnection(old.client, ORG)).toMatchObject({ kind: 'stored', ageMs: null })
    expect(logs.some((l) => l.includes('age unknown'))).toBe(true)
  })
})

describe('when nobody can be told', () => {
  it('answers unreachable no_copy when there is no copy, with its own log line', async () => {
    const { client } = await scheduled([{ error: { message: 'boom' } }], { copy: null })
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    expect(await getSlackConnection(client, ORG)).toBeNull()
    expect(logs.filter((l) => l.includes('there is no saved copy'))).not.toHaveLength(0)
  })

  it('answers unreachable org_not_in_copy when the copy does not hold the org, with its own log line', async () => {
    const { client } = await scheduled([{ error: { message: 'boom' } }], { copy: { 'org-2': STORED_CONN } })
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'org_not_in_copy' })
    expect(logs.filter((l) => l.includes('the saved copy holds no Slack connection for this organization'))).not.toHaveLength(0)
  })

  it('answers unreachable copy_unreadable when the copy was written under another key, with its own log line', async () => {
    const { client, calls } = fakeClient([{ error: { message: 'boom' } }])
    const kv = kvWith({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG]: STORED_CONN }), OTHER_KEY) })
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'copy_unreadable' })
    expect(calls).toHaveLength(1)
    expect(logs.filter((l) => l.includes('the saved copy could not be read'))).not.toHaveLength(0)
  })

  it('answers unreachable copy_unreadable when KV itself cannot be read, rather than throwing', async () => {
    const { client } = fakeClient([{ error: { message: 'boom' } }])
    const kv = { get: async () => { throw new Error('KV GET failed: 500') } }
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    expect(await lookupSlackConnection(client, ORG)).toEqual({ kind: 'unreachable', reason: 'copy_unreadable' })
    expect(logs.some((l) => l.includes('KV GET failed: 500'))).toBe(true)
  })

  it('writes a different log line for each of live, stored, none and unreachable', async () => {
    const lines = async (answers: Answer[], copy: Record<string, unknown> | null) => {
      logs.length = 0
      const { client } = await scheduled(answers, { copy })
      await lookupSlackConnection(client, ORG)
      return logs.filter((l) => l.includes('[scheduled-slack]'))
    }
    const live = await lines([{ data: { config: LIVE_CONN } }], null)
    const none = await lines([{ data: null }], null)
    const stored = await lines([{ error: { message: 'boom' } }], { [ORG]: STORED_CONN })
    const unreachable = await lines([{ error: { message: 'boom' } }], null)
    for (const set of [live, none, stored, unreachable]) expect(set.length).toBeGreaterThan(0)
    const all = [live.join('|'), none.join('|'), stored.join('|'), unreachable.join('|')]
    expect(new Set(all).size).toBe(4)
  })
})

describe('the scheduled handler\'s real client', () => {
  const env = (kv: { get(key: string): Promise<string | null> }) => ({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    SECRET_ENCRYPTION_KEY: TEST_KEY,
    IDEMPOTENCY: kv,
  }) as unknown as Env

  it('is registered, so a real supabase-js read that never answers is aborted at the deadline and the copy answers', async () => {
    const kv = await kvWithCopy({ [ORG]: STORED_CONN })
    const sent: Array<{ url: string; aborted: () => boolean }> = []
    // The network: a request that never answers until its signal fires, as on 2026-10-08.
    const stalled = ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      sent.push({ url: String(input), aborted: () => signal?.aborted ?? false })
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }) as typeof fetch
    const client = createScheduledSupabaseClient(env(kv), () => {}, { fetch: stalled, sleep: fakeTimers('now').sleep })
    expect(scheduledSlackFor(client)).toBeDefined()
    const conn = await getSlackConnection(client, ORG)
    expect(conn?.bot_token).toBe('xoxb-stored')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toContain('/rest/v1/service_connections')
    expect(sent[0].aborted()).toBe(true)
  })

  it('asks once, with the library\'s own retries off, when a real org list read answers 503, and the copy answers', async () => {
    const kv = await kvWithCopy({ [ORG]: STORED_CONN })
    const sent: string[] = []
    const unavailable = (async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return new Response(JSON.stringify({ message: 'upstream connect error' }), { status: 503, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const client = createScheduledSupabaseClient(env(kv), () => {}, { fetch: unavailable, sleep: fakeTimers('never').sleep })
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'stored', orgIds: [ORG], ageMs: null })
    expect(sent).toHaveLength(1)
  })
})

describe('every other client keeps today\'s behaviour', () => {
  it('a client nobody registered retries as before and never reads the copy, even while the scheduled client is down', async () => {
    const down = await scheduled([{ error: { message: 'boom' } }], { copy: { [ORG]: STORED_CONN } })
    await lookupSlackConnection(down.client, ORG)

    const request = fakeClient([{ error: { message: 'pool timeout' } }])
    const conn = await getSlackConnection(request.client, ORG, [0, 0])
    expect(conn).toBeNull()
    // Three attempts, the retry ladder of today, and no deadline or copy.
    expect(request.calls).toHaveLength(3)
    expect(request.calls.every((c) => c.retry === undefined)).toBe(true)
    expect(down.kv.gets).toEqual([SLACK_CONNS_LASTGOOD_KEY])
  })
})
