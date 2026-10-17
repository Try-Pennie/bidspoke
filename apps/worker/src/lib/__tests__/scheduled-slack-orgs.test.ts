/**
 * The org lists on the scheduled handler's client (#1303 phase 1): slackOrgIds,
 * forEachSlackOrg, rateLimitedOrgAlert and readEverySlackConnection take the
 * same bounded read as the single lookup, fall back to the saved copy, and say
 * "no organizations" and "could not read" differently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forEachSlackOrg, rateLimitedOrgAlert, readEverySlackConnection, slackOrgIds } from '../alert-fanout'
import { getSlackConnection } from '../slack'
import { registerScheduledSlack } from '../scheduled-slack'
import { fakeClient, fakeTimers, kvWith, kvWithCopy, LIVE_CONN, STORED_CONN, TEST_KEY, type Answer } from './_scheduled-slack-doubles'

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

async function scheduled(answers: Answer[], copy: Record<string, unknown> | null, timers: 'never' | 'now' = 'never') {
  const { client, calls } = fakeClient(answers)
  const kv = copy ? await kvWithCopy(copy) : kvWith()
  registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers(timers).sleep })
  return { client, calls, kv }
}

const COPY = { 'org-1': STORED_CONN, 'org-2': { ...STORED_CONN, bot_token: 'xoxb-stored-2' } }

describe('slackOrgIds on the scheduled client', () => {
  it('reads live, deduped, without reading the copy', async () => {
    const { client, kv, calls } = await scheduled([{ data: [{ organization_id: 'org-1' }, { organization_id: 'org-1' }] }], COPY)
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'live', orgIds: ['org-1'] })
    expect(kv.gets).toEqual([])
    expect(calls[0].retry).toBe(false)
  })

  it('answers the copy\'s organizations when the read never answers', async () => {
    const { client } = await scheduled(['stall'], COPY, 'now')
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'stored', orgIds: ['org-1', 'org-2'], ageMs: null })
  })

  it('refuses the copy\'s list to a caller that measures its finding from the database, without reading the copy', async () => {
    const { client, kv } = await scheduled([{ error: { message: 'boom' } }], COPY)
    expect(await slackOrgIds(client, 'test', 'measure-from-database')).toEqual({ kind: 'unreachable', reason: 'database_not_answering' })
    expect(kv.gets).toEqual([])
    expect(logs.some((l) => l.includes('judges nothing this run'))).toBe(true)
  })

  it('answers unreachable no_copy when the read fails and there is no copy', async () => {
    const { client } = await scheduled([{ error: { message: 'boom' } }], null)
    expect(await slackOrgIds(client, 'test', 'tell-only')).toEqual({ kind: 'unreachable', reason: 'no_copy' })
    expect(logs.some((l) => l.includes('there is no saved copy'))).toBe(true)
  })

  it('sets the tick\'s flag, so the lookups after a failed org list go to the copy without asking', async () => {
    const { client, calls } = await scheduled([{ error: { message: 'boom' } }, { data: [{ config: LIVE_CONN }] }], COPY)
    await slackOrgIds(client, 'test', 'tell-only')
    expect((await getSlackConnection(client, 'org-2'))?.bot_token).toBe('xoxb-stored-2')
    expect(calls).toHaveLength(1)
  })
})

describe('forEachSlackOrg and rateLimitedOrgAlert on the scheduled client', () => {
  it('posts to every organization in the copy through the copy when the database is down', async () => {
    const { client } = await scheduled([{ error: { message: 'boom' } }], COPY)
    const tokens: string[] = []
    const ran = await forEachSlackOrg(client, 'test', 'tell-only', async (orgId) => {
      const conn = await getSlackConnection(client, orgId)
      if (conn) tokens.push(conn.bot_token)
      return conn !== null
    })
    expect(ran).toEqual({ kind: 'ran', source: 'stored', results: [true, true] })
    expect(tokens).toEqual(['xoxb-stored', 'xoxb-stored-2'])
  })

  it('does not set the cooldown when nobody could be told', async () => {
    const { client } = await scheduled([{ error: { message: 'boom' } }], null)
    const store = new Map<string, string>()
    const perOrg = vi.fn(async () => true)
    const alerted = await rateLimitedOrgAlert({
      kv: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) },
      cooldownKey: 'k',
      ttlSeconds: 60,
      supabase: client,
      logLabel: 'test',
      use: 'tell-only',
      perOrg,
    })
    expect(alerted).toBe(false)
    expect(perOrg).not.toHaveBeenCalled()
    expect(store.has('k')).toBe(false)
  })
})

describe('readEverySlackConnection', () => {
  it('reads every connection live in one read on the scheduled client', async () => {
    const { client, calls } = await scheduled([{ data: [{ organization_id: 'org-1', config: LIVE_CONN }, { organization_id: 'org-3', config: { nope: true } }] }], COPY)
    const read = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(read.kind).toBe('live')
    expect(read.kind === 'live' && [...read.connections.keys()]).toEqual(['org-1'])
    expect(calls).toHaveLength(1)
  })

  it('answers an empty live map, not the copy, when the database has no connections', async () => {
    const { client, kv } = await scheduled([{ data: [] }], COPY)
    const read = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(read).toEqual({ kind: 'live', connections: new Map() })
    expect(kv.gets).toEqual([])
  })

  it('answers the copy when the database does not answer, and unreachable when there is no copy', async () => {
    const down = await scheduled(['throw'], COPY)
    const stored = await readEverySlackConnection(down.client, 'test', 'tell-only')
    expect(stored.kind).toBe('stored')
    expect(stored.kind === 'stored' && stored.connections.get('org-2')?.bot_token).toBe('xoxb-stored-2')

    const none = await scheduled(['throw'], null)
    expect(await readEverySlackConnection(none.client, 'test', 'tell-only')).toEqual({ kind: 'unreachable', reason: 'no_copy' })
  })

  it('on a client nobody registered, reads once and says read_failed on an error, never reading a copy', async () => {
    const { client, calls } = fakeClient([{ error: { message: 'boom' } }])
    expect(await readEverySlackConnection(client, 'test', 'tell-only')).toEqual({ kind: 'unreachable', reason: 'read_failed' })
    expect(calls).toHaveLength(1)
    expect(calls[0].retry).toBeUndefined()
  })
})
