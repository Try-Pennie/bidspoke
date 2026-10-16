/**
 * The saved Slack copy: kept current, dated, and edited per organization (#2060,
 * #1303 phase 2).
 *
 * The copy is what scheduled alerts post from while the database is down. Its
 * shape stays a flat map of organization id to connection, with its save time
 * under the reserved top level string key `__saved_at`, so a reader from before
 * the key still reads every organization (a mixed deploy or a rollback), and a
 * reader from after it still reads a copy written before it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret, type SecretKeyInput } from '../secret-crypto'
import { parseSlackConnection, type SlackConnection } from '../slack-connection'
import { lookupSlackConnection } from '../slack'
import { registerScheduledSlack } from '../scheduled-slack'
import { STORED_COPY_AGE_EXEMPTIONS, STORED_COPY_MAX_AGE_MS } from '../stored-copy-age'
import {
  editSlackCopyEntry,
  readLastGoodSlackConnections,
  readSlackCopy,
  rememberSlackConnections,
  SLACK_CONNS_LASTGOOD_KEY,
  SLACK_COPY_SAVED_AT_KEY,
} from '../slack-copy'
import { fakeClient, fakeTimers, OTHER_KEY, TEST_KEY } from './_scheduled-slack-doubles'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const SAVED_AT = Date.parse('2026-10-15T03:00:00Z')

const conn = (token: string, channel = '#alerts'): SlackConnection => parseSlackConnection({ bot_token: token, default_channel: channel })!

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    puts: 0,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      this.puts++
      store.set(key, value)
    },
  }
}

async function rawCopy(kv: { store: Map<string, string> }, key: SecretKeyInput = TEST_KEY): Promise<Record<string, unknown>> {
  return JSON.parse(await decryptSecret(kv.store.get(SLACK_CONNS_LASTGOOD_KEY)!, key)) as Record<string, unknown>
}

/**
 * The copy reader as it shipped before the save time existed, copied verbatim
 * from volume-cliff.ts on main at 2026-10-14 (before #1303). An older worker
 * still running during a deploy, or one rolled back to, reads the copy this way.
 */
async function preSavedAtReader(kv: { get(k: string): Promise<string | null> }, secretEncryptionKey: SecretKeyInput): Promise<Map<string, SlackConnection>> {
  const blob = await kv.get(SLACK_CONNS_LASTGOOD_KEY)
  if (!blob) return new Map()
  const parsed = JSON.parse(await decryptSecret(blob, secretEncryptionKey)) as Record<string, unknown>
  const out = new Map<string, SlackConnection>()
  for (const [orgId, cfg] of Object.entries(parsed)) {
    const c = parseSlackConnection(cfg)
    if (c) out.set(orgId, c)
  }
  return out
}

let errors: string[]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the writer dates the copy', () => {
  it('writes the save time under the reserved key, and the reader reads it back', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')]]), SAVED_AT)
    expect((await rawCopy(kv))[SLACK_COPY_SAVED_AT_KEY]).toBe('2026-10-15T03:00:00.000Z')
    const read = await readSlackCopy(kv, TEST_KEY)
    expect(read).toMatchObject({ kind: 'read', savedAtMs: SAVED_AT })
    if (read.kind === 'read') expect([...read.connections.keys()]).toEqual([ORG_A])
  })

  it('writes an empty copy, dated, when no organization has a connection', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map(), SAVED_AT)
    expect(await rawCopy(kv)).toEqual({ [SLACK_COPY_SAVED_AT_KEY]: '2026-10-15T03:00:00.000Z' })
    expect(await readSlackCopy(kv, TEST_KEY)).toMatchObject({ kind: 'read', savedAtMs: SAVED_AT })
  })

  it('reports the saved time as the stored answer age on the scheduled lookup', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')]]), SAVED_AT)
    const { client } = fakeClient([{ error: { message: 'connection refused' } }])
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep, now: () => SAVED_AT + 12 * 60_000 })
    expect(await lookupSlackConnection(client, ORG_A)).toMatchObject({ kind: 'stored', ageMs: 12 * 60_000 })
  })
})

describe('compatibility both ways across a mixed deploy or a rollback', () => {
  it('an older reader that predates the save time reads every organization from a new copy, and no phantom one', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')], [ORG_B, conn('xoxb-b')]]), SAVED_AT)
    const old = await preSavedAtReader(kv, TEST_KEY)
    expect([...old.keys()].sort()).toEqual([ORG_A, ORG_B])
    expect(old.get(ORG_A)?.bot_token).toBe('xoxb-a')
    expect(old.has(SLACK_COPY_SAVED_AT_KEY)).toBe(false)
  })

  it('the new readers read an old copy with no save time: every organization, age unknown', async () => {
    const kv = memoryKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG_A]: conn('xoxb-a'), [ORG_B]: conn('xoxb-b') }), TEST_KEY) })
    const read = await readSlackCopy(kv, TEST_KEY)
    expect(read).toMatchObject({ kind: 'read', savedAtMs: null })
    if (read.kind === 'read') expect([...read.connections.keys()].sort()).toEqual([ORG_A, ORG_B])
    expect([...(await readLastGoodSlackConnections(kv, TEST_KEY)).keys()].sort()).toEqual([ORG_A, ORG_B])
  })
})

describe('the copy is used at any age (Dan, 2026-10-14, #1874)', () => {
  it('is recorded beside the thirty minute limit as the one exemption, under the key the copy is kept at, with its reason', () => {
    expect(Object.keys(STORED_COPY_AGE_EXEMPTIONS)).toEqual([SLACK_CONNS_LASTGOOD_KEY])
    expect(STORED_COPY_AGE_EXEMPTIONS[SLACK_CONNS_LASTGOOD_KEY]).toMatch(/#1874/)
  })

  it('a copy far past the thirty minute stored copy limit still answers the scheduled lookup, naming its age', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')]]), SAVED_AT)
    const ageMs = STORED_COPY_MAX_AGE_MS * 100
    const { client } = fakeClient([{ error: { message: 'connection refused' } }])
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep, now: () => SAVED_AT + ageMs })
    expect(await lookupSlackConnection(client, ORG_A)).toMatchObject({ kind: 'stored', ageMs, connection: { bot_token: 'xoxb-a' } })
  })

  it('and still answers the request path readers, which take the copy as it is', async () => {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')]]), SAVED_AT - STORED_COPY_MAX_AGE_MS * 100)
    expect((await readLastGoodSlackConnections(kv, TEST_KEY)).get(ORG_A)?.bot_token).toBe('xoxb-a')
  })
})

describe('editing one organization in the copy (the Slack settings routes)', () => {
  async function seeded() {
    const kv = memoryKv()
    await rememberSlackConnections(kv, TEST_KEY, new Map([[ORG_A, conn('xoxb-a')], [ORG_B, conn('xoxb-b')]]), SAVED_AT)
    kv.puts = 0
    return kv
  }

  it('removes the organization, keeping every other one and the save time', async () => {
    const kv = await seeded()
    expect(await editSlackCopyEntry(kv, TEST_KEY, ORG_A, null)).toBe('written')
    const raw = await rawCopy(kv)
    expect(Object.keys(raw).sort()).toEqual([ORG_B, SLACK_COPY_SAVED_AT_KEY].sort())
    expect(raw[SLACK_COPY_SAVED_AT_KEY]).toBe('2026-10-15T03:00:00.000Z')
  })

  it('replaces the organization with its new connection', async () => {
    const kv = await seeded()
    const muted = parseSlackConnection({ bot_token: 'xoxb-a', default_channel: '#quiet', volume_alerts_enabled: false })!
    expect(await editSlackCopyEntry(kv, TEST_KEY, ORG_A, muted)).toBe('written')
    const read = await readSlackCopy(kv, TEST_KEY)
    if (read.kind !== 'read') throw new Error('expected a copy')
    expect(read.connections.get(ORG_A)).toMatchObject({ default_channel: '#quiet', volume_alerts_enabled: false })
    expect(read.connections.get(ORG_B)?.bot_token).toBe('xoxb-b')
    expect(read.savedAtMs).toBe(SAVED_AT)
  })

  it('writes nothing when there is no copy, or the organization is already absent from it', async () => {
    const none = memoryKv()
    expect(await editSlackCopyEntry(none, TEST_KEY, ORG_A, null)).toBe('no_copy')
    expect(none.puts).toBe(0)
    const kv = await seeded()
    expect(await editSlackCopyEntry(kv, TEST_KEY, 'org-not-there', null)).toBe('unchanged')
    expect(kv.puts).toBe(0)
  })

  it('leaves a copy it cannot read alone, since nobody can post from it either', async () => {
    const kv = memoryKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG_A]: conn('xoxb-a') }), OTHER_KEY) })
    expect(await editSlackCopyEntry(kv, TEST_KEY, ORG_A, null)).toBe('unreadable')
    expect(kv.puts).toBe(0)
  })

  it('throws when KV refuses the write, so the route can say the copy was not updated', async () => {
    const kv = await seeded()
    kv.put = async () => { throw new Error('KV put failed: 503') }
    await expect(editSlackCopyEntry(kv, TEST_KEY, ORG_A, null)).rejects.toThrow('KV put failed')
  })
})
