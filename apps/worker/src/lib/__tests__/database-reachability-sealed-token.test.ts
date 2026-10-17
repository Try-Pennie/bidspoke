/**
 * The minute probe and a sealed Slack token it cannot open (#2331, L105).
 *
 * The probe rewrites the saved Slack copy from every org's row each healthy
 * minute. Before #2331 it kept the old copy only when EVERY row failed to
 * parse, so once tokens are sealed, one row that cannot be opened (a key
 * rotated away, a row never relocked) would be dropped from the next copy while
 * the other rows were written: that org's last good copy erased on a healthy
 * minute. Unreadable is not absent. So such a row carries its org's entry
 * forward from the current copy, and is paged by name
 * (slack-token-undecryptable) through the connection that can still post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../slack', () => ({
  sendDatabaseUnreachableAlert: vi.fn(),
  sendDatabaseRecoveredAlert: vi.fn(),
  sendSlackTokenUnreadableAlert: vi.fn(),
  sendSlackTokenReadableAlert: vi.fn(),
}))

import { runDatabaseReachabilityProbe } from '../database-reachability'
import { sendSlackTokenReadableAlert, sendSlackTokenUnreadableAlert } from '../slack'
import { encryptSecret } from '../secret-crypto'
import { readSlackCopy, SLACK_CONNS_LASTGOOD_KEY, SLACK_COPY_SAVED_AT_KEY } from '../slack-copy'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { fakeTimers, OTHER_KEY, tableClient, TEST_KEY } from './_scheduled-slack-doubles'

const GOOD = '11111111-1111-4111-8111-111111112331'
const BAD = '22222222-2222-4222-8222-222222222331'
const MIN = 60_000
const T0 = Date.parse('2026-10-17T15:00:00Z')

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
  }
}

async function kvWithCopy(conns: Record<string, unknown>) {
  const body = { ...conns, [SLACK_COPY_SAVED_AT_KEY]: new Date(T0 - 5 * MIN).toISOString() }
  return fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify(body), TEST_KEY) })
}

function probeDeps(kv: ReturnType<typeof fakeKv>, at: number, rows: unknown[]) {
  return {
    kv,
    secretKeys: TEST_KEY,
    appUrl: 'https://app.example',
    now: () => at,
    supabase: tableClient({ service_connections: { data: rows } }).client,
    sleep: fakeTimers('never').sleep,
    stamps: { started: vi.fn().mockResolvedValue(undefined), completed: vi.fn().mockResolvedValue(undefined) },
  }
}

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
  vi.mocked(sendSlackTokenUnreadableAlert).mockReset().mockResolvedValue(true)
  vi.mocked(sendSlackTokenReadableAlert).mockReset().mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

const goodRow = async () => ({ organization_id: GOOD, config: { default_channel: '#good' }, credential_enc: await encryptSecret('good-bot-token', TEST_KEY) })
const badRow = async (plaintext?: string) => ({
  organization_id: BAD,
  config: plaintext ? { bot_token: plaintext, default_channel: '#bad' } : { default_channel: '#bad' },
  credential_enc: await encryptSecret('bad-bot-token', OTHER_KEY),
})

describe('a row whose sealed token cannot be opened', () => {
  it('keeps that org in the copy from its existing entry, while the others are rewritten', async () => {
    const kv = await kvWithCopy({
      [GOOD]: { bot_token: 'old-good-token', default_channel: '#good' },
      [BAD]: { bot_token: 'copy-bad-token', default_channel: '#bad' },
    })
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await goodRow(), await badRow()]))
    const copy = await readSlackCopy(kv, TEST_KEY)
    expect(copy.kind).toBe('read')
    if (copy.kind !== 'read') return
    expect(copy.connections.get(GOOD)?.bot_token).toBe('good-bot-token')
    expect(copy.connections.get(BAD)?.bot_token).toBe('copy-bad-token')
    expect(copy.savedAtMs).toBe(T0)
  })

  it('pages that org by name through the carried entry, and the page names neither token', async () => {
    const kv = await kvWithCopy({ [BAD]: { bot_token: 'copy-bad-token', default_channel: '#bad' } })
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await goodRow(), await badRow()]))
    expect(sendSlackTokenUnreadableAlert).toHaveBeenCalledTimes(1)
    const [conn, channel, payload] = vi.mocked(sendSlackTokenUnreadableAlert).mock.calls[0]
    expect(conn.bot_token).toBe('copy-bad-token')
    expect(channel).toBe('#bad')
    expect(payload).toMatchObject({ reason: 'slack_token_undecryptable', fellBackToPlaintext: false })
    expect(JSON.stringify(payload)).not.toMatch(/bot-token/)
    expect(logs.some((l) => l.includes('slack_token_undecryptable') && l.includes(BAD))).toBe(true)
  })

  it('with the plaintext beside it, the org is written from the plaintext and still paged', async () => {
    const kv = await kvWithCopy({})
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await badRow('plain-bad-token')]))
    const copy = await readSlackCopy(kv, TEST_KEY)
    expect(copy.kind === 'read' && copy.connections.get(BAD)?.bot_token).toBe('plain-bad-token')
    expect(sendSlackTokenUnreadableAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSlackTokenUnreadableAlert).mock.calls[0][2]).toMatchObject({ fellBackToPlaintext: true })
  })

  it('pages once per cooldown, not every minute', async () => {
    const kv = await kvWithCopy({ [BAD]: { bot_token: 'copy-bad-token', default_channel: '#bad' } })
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await badRow()]))
    await runDatabaseReachabilityProbe(probeDeps(kv, T0 + MIN, [await badRow()]))
    expect(sendSlackTokenUnreadableAlert).toHaveBeenCalledTimes(1)
  })

  it('says the all-clear once the row reads again for the re-arm window', async () => {
    const kv = await kvWithCopy({ [BAD]: { bot_token: 'copy-bad-token', default_channel: '#bad' } })
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await badRow()]))
    const fixed = { organization_id: BAD, config: { default_channel: '#bad' }, credential_enc: await encryptSecret('bad-bot-token', TEST_KEY) }
    await runDatabaseReachabilityProbe(probeDeps(kv, T0 + MIN, [fixed]))
    expect(sendSlackTokenReadableAlert).not.toHaveBeenCalled()
    await runDatabaseReachabilityProbe(probeDeps(kv, T0 + (RECOVERY_REARM_MINUTES + 2) * MIN, [fixed]))
    expect(sendSlackTokenReadableAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendSlackTokenReadableAlert).mock.calls[0][0].bot_token).toBe('bad-bot-token')
  })

  it('with no copy entry and no plaintext, nobody can be told: it is logged by name and the rest are written', async () => {
    const kv = await kvWithCopy({})
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, [await goodRow(), await badRow()]))
    expect(sendSlackTokenUnreadableAlert).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('slack_token_undecryptable') && l.includes(BAD) && l.includes('nobody can be told'))).toBe(true)
    const copy = await readSlackCopy(kv, TEST_KEY)
    expect(copy.kind === 'read' && [...copy.connections.keys()]).toEqual([GOOD])
  })
})
