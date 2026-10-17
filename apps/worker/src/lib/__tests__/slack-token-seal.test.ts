/**
 * The Slack bot token read from its sealed home (#2331, phase 1 of #1689).
 *
 * service_connections.credential_enc holds the token locked with the Worker's
 * key ring. In this release config.bot_token still holds the plaintext beside
 * it (dual write), because the code before this release, the rollback target,
 * reads only that (L640). So every reader resolves a row the same way: the
 * ciphertext first, the plaintext only as a fallback that is SAID, never
 * silent (F128), and a row holding only a ciphertext (the shape after the
 * contract release, built here) must still alert.
 *
 * The rows below are built in the test; the token is a placeholder string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret, secretKeys } from '../secret-crypto'
import { parseSlackConnection, resolveSlackConnection } from '../slack-connection'
import { registerSlackKeyRing, slackKeyRingFor } from '../slack-key-ring'
import { getSlackConnection, lookupSlackConnection, readSlackConnectionForLead, sendFailureAlert } from '../slack'
import { readEverySlackConnection } from '../alert-fanout'
import { createSupabaseClient } from '../supabase'
import { registerScheduledSlack } from '../scheduled-slack'
import type { Env } from '../../env'
import { fakeClient, fakeTimers, kvWithCopy, OTHER_KEY, TEST_KEY } from './_scheduled-slack-doubles'

const ORG = 'org-sealed'
const SEALED_TOKEN = 'sealed-bot-token-2331'
const PLAIN_TOKEN = 'plain-bot-token-2331'
const RING = { encryptWith: TEST_KEY, decryptWith: [TEST_KEY] }

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const sealed = (token: string, key = TEST_KEY) => encryptSecret(token, key)

describe('resolveSlackConnection', () => {
  it('reads the token from credential_enc when the row holds only the ciphertext', async () => {
    const r = await resolveSlackConnection({ config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) }, RING)
    expect(r).toMatchObject({ kind: 'connection', source: 'sealed', connection: { bot_token: SEALED_TOKEN, default_channel: '#a' } })
    expect(r.kind === 'connection' && r.problem).toBeFalsy()
  })

  it('prefers the ciphertext over the plaintext copy beside it', async () => {
    const r = await resolveSlackConnection({ config: { bot_token: PLAIN_TOKEN, default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) }, RING)
    expect(r).toMatchObject({ kind: 'connection', source: 'sealed', connection: { bot_token: SEALED_TOKEN } })
  })

  it('reads a row that was never sealed exactly as before', async () => {
    const r = await resolveSlackConnection({ config: { bot_token: PLAIN_TOKEN, default_channel: '#a' }, credential_enc: null }, RING)
    expect(r).toMatchObject({ kind: 'connection', source: 'plaintext', connection: parseSlackConnection({ bot_token: PLAIN_TOKEN, default_channel: '#a' }) })
  })

  it('answers none, as before, for a row with no default channel', async () => {
    expect(await resolveSlackConnection({ config: {}, credential_enc: await sealed(SEALED_TOKEN) }, RING)).toEqual({ kind: 'none' })
    expect(await resolveSlackConnection({ config: null }, RING)).toEqual({ kind: 'none' })
  })

  it('falls back to the plaintext when the ciphertext will not open, and says so by name', async () => {
    const r = await resolveSlackConnection({ config: { bot_token: PLAIN_TOKEN, default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) }, RING)
    expect(r).toMatchObject({ kind: 'connection', source: 'plaintext', connection: { bot_token: PLAIN_TOKEN }, problem: { reason: 'slack_token_undecryptable' } })
  })

  it('is unreadable by name, never none, when the ciphertext will not open and there is no plaintext', async () => {
    const r = await resolveSlackConnection({ config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) }, RING)
    expect(r).toMatchObject({ kind: 'unreadable', reason: 'slack_token_undecryptable' })
  })

  it('is unreadable as slack_key_ring_missing when no ring was given for a sealed row', async () => {
    const r = await resolveSlackConnection({ config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) }, undefined)
    expect(r).toMatchObject({ kind: 'unreadable', reason: 'slack_key_ring_missing' })
    const withPlain = await resolveSlackConnection({ config: { bot_token: PLAIN_TOKEN, default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) }, undefined)
    expect(withPlain).toMatchObject({ kind: 'connection', source: 'plaintext', problem: { reason: 'slack_key_ring_missing' } })
  })

  it('never puts the token or the ciphertext in what it says about a problem', async () => {
    const enc = await sealed(SEALED_TOKEN, OTHER_KEY)
    const r = await resolveSlackConnection({ config: { bot_token: PLAIN_TOKEN, default_channel: '#a' }, credential_enc: enc }, RING)
    const said = JSON.stringify(r.kind === 'connection' ? r.problem : r)
    expect(said).not.toContain(PLAIN_TOKEN)
    expect(said).not.toContain(enc)
  })
})

describe('the key ring reaches every client createSupabaseClient builds', () => {
  it('registers secretKeys(env) against the client', () => {
    const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'k', SECRET_ENCRYPTION_KEY: TEST_KEY } as unknown as Env
    const client = createSupabaseClient(env)
    expect(slackKeyRingFor(client)).toEqual(secretKeys(env))
  })

  it('a client nobody registered has no ring', () => {
    expect(slackKeyRingFor({})).toBeUndefined()
  })
})

describe('the request path reads a sealed row', () => {
  it('sendFailureAlert on a request client posts from a row holding only credential_enc', async () => {
    const { client } = fakeClient([{ data: { config: { default_channel: '#alerts' }, credential_enc: await sealed(SEALED_TOKEN) } }])
    registerSlackKeyRing(client, RING)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await sendFailureAlert(client, ORG, null, {
      workflow_id: 'wf-1', workflow_name: 'Main Flow', execution_id: 'ex-1', error_message: 'boom', error_type: 'permanent', timestamp: '2026-10-17T00:00:00Z',
    }, 'https://app.example')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SEALED_TOKEN}`)
  })

  it('a client with no ring that meets a sealed row fails loudly by name, never as no Slack', async () => {
    const { client } = fakeClient([{ data: { config: { default_channel: '#alerts' }, credential_enc: await sealed(SEALED_TOKEN) } }])
    const found = await lookupSlackConnection(client, ORG, [])
    expect(found).toEqual({ kind: 'unreachable', reason: 'slack_key_ring_missing' })
    expect(logs.some((l) => l.includes('slack_key_ring_missing') && l.includes(ORG))).toBe(true)
  })

  it('an undecryptable row with no plaintext fails loudly by name and posts nothing', async () => {
    const { client } = fakeClient([{ data: { config: { default_channel: '#alerts' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) } }])
    registerSlackKeyRing(client, RING)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await lookupSlackConnection(client, ORG, [])).toEqual({ kind: 'unreachable', reason: 'slack_token_undecryptable' })
    expect(await getSlackConnection(client, ORG, [])).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('slack_token_undecryptable'))).toBe(true)
  })

  it('an undecryptable row with the plaintext beside it still alerts, and the fallback is logged by name', async () => {
    const { client } = fakeClient([{ data: { config: { bot_token: PLAIN_TOKEN, default_channel: '#alerts' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) } }])
    registerSlackKeyRing(client, RING)
    expect((await getSlackConnection(client, ORG, []))?.bot_token).toBe(PLAIN_TOKEN)
    expect(logs.some((l) => l.includes('slack_token_undecryptable') && l.includes('plaintext'))).toBe(true)
  })

  it('readSlackConnectionForLead reads a sealed row, and throws by name on one it cannot open', async () => {
    const good = fakeClient([{ data: { config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) } }]).client
    registerSlackKeyRing(good, RING)
    expect((await readSlackConnectionForLead(good, ORG))?.bot_token).toBe(SEALED_TOKEN)
    const bad = fakeClient([{ data: { config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) } }]).client
    registerSlackKeyRing(bad, RING)
    await expect(readSlackConnectionForLead(bad, ORG)).rejects.toThrow(/slack_token_undecryptable/)
  })

  it('readEverySlackConnection holds an org whose row has only credential_enc', async () => {
    const { client } = fakeClient([{ data: [
      { organization_id: ORG, config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) },
      { organization_id: 'org-plain', config: { bot_token: PLAIN_TOKEN, default_channel: '#b' }, credential_enc: null },
    ] }])
    registerSlackKeyRing(client, RING)
    const read = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(read.kind).toBe('live')
    if (read.kind !== 'live') return
    expect(read.connections.get(ORG)?.bot_token).toBe(SEALED_TOKEN)
    expect(read.connections.get('org-plain')?.bot_token).toBe(PLAIN_TOKEN)
  })
})

describe('the scheduled lookup and a sealed row it cannot open', () => {
  it('falls back to the saved copy where it does today, with the named reason in the log', async () => {
    const { client } = fakeClient([{ data: { config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN, OTHER_KEY) } }])
    registerSlackKeyRing(client, RING)
    const kv = await kvWithCopy({ [ORG]: { bot_token: 'copy-bot-token', default_channel: '#copy' } })
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    const found = await lookupSlackConnection(client, ORG)
    expect(found).toMatchObject({ kind: 'stored', connection: { bot_token: 'copy-bot-token' } })
    expect(logs.some((l) => l.includes('slack_token_undecryptable'))).toBe(true)
  })

  it('reads a sealed row live on the scheduled client', async () => {
    const { client } = fakeClient([{ data: { config: { default_channel: '#a' }, credential_enc: await sealed(SEALED_TOKEN) } }])
    registerSlackKeyRing(client, RING)
    registerScheduledSlack(client, { kv: await kvWithCopy({}), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    expect(await lookupSlackConnection(client, ORG)).toMatchObject({ kind: 'live', connection: { bot_token: SEALED_TOKEN } })
  })
})
