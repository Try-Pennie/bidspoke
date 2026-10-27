/**
 * The Slack settings routes and the sealed token (#2331, phase 1 of #1689).
 *
 * Who may call these: any signed in user of the organization (jwtAuth), and
 * each reads and writes only the caller's organization's Slack row.
 *
 * - POST /slack seals the token into credential_enc, its only home since the
 *   contract release, and sends save_slack_alert_token only the token save's
 *   own config keys (#2643), so config never carries the plaintext.
 * - PATCH sends save_slack_alert_settings only the settings changed (#2643),
 *   and rebuilds the saved copy from the row as written, with the token the
 *   row holds (opened from credential_enc), so a row in the contract
 *   release's shape stays in the copy.
 * - GET /slack/channels reads the token through the same resolver.
 * - DELETE goes through delete_service_connection_by_id with the alert row's
 *   id (#2332), so the store's audit row names the user; no route writes an audit row of its own any more, since the
 *   table's trigger records every change once (F119, #1409).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { decryptSecret, encryptSecret } from '../../../lib/secret-crypto'
import { parseSlackConnection } from '../../../lib/slack-connection'
import { readSlackCopy, rememberSlackConnections } from '../../../lib/slack-copy'
import { makeSupabase } from './_supabase-mock'
import { slackPostOf } from '../../../__tests__/helpers/slack-fetch'
import { answerSlackConfigSaves } from '../../../__tests__/helpers/sealed-slack-row'
import api from '../index'

const ORG = 'org-abc'
const USER = 'user-1'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const TOKEN = 'saved-bot-token-2331'
const validPayload = { sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const testUser = { id: USER, organization_id: ORG, email: 'dan@pennie.com' }

/**
 * The shared route double (makeSupabase), serving `row` to the Slack row read
 * and recording what the routes write and which rpcs they call.
 */
function recordingSupabase(opts: { row?: Record<string, unknown> | null; rpcResult?: { data: unknown; error: unknown } } = {}) {
  const rpcs: { name: string; args: unknown }[] = []
  const client = makeSupabase(
    {
      users: { single: testUser },
      service_connections: {
        // The alert row read ends in .limit(2), awaited as a list (#2332).
        list: opts.row ? [opts.row] : [],
        upsertResult: { id: 'sc-1', created_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:01Z' },
        writeRows: [{ id: 'sc-1' }],
      },
    },
    {
      rpc: async (name, args) => {
        rpcs.push({ name, args })
        if (opts.rpcResult) return opts.rpcResult
        // The two config saves (#2643) return the row as written; the delete answers the row it removed.
        return answerSlackConfigSaves({ id: 'sc-1', ...opts.row }, { delete_service_connection_by_id: [{ id: 'sc-1' }] })(name, args)
      },
    },
  )
  const written = (method: string) => (client.calls.service_connections ?? []).filter(([m]) => m === method).map(([, args]) => args[0] as Record<string, unknown>)
  /** The arguments of each call of one database function. */
  const calls = (name: string) => rpcs.filter((r) => r.name === name).map((r) => r.args as Record<string, unknown>)
  return { client, rec: { get upserts() { return written('upsert') }, get updates() { return written('update') }, get tokenSaves() { return calls('save_slack_alert_token') }, get settingsSaves() { return calls('save_slack_alert_settings') }, rpcs } }
}

let store: Map<string, string>
const env = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  SECRET_ENCRYPTION_KEY: KEY,
  IDEMPOTENCY: {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
  },
} as unknown as Env

async function call(method: string, path: string, body?: unknown) {
  return api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env, recordingContext())
}

async function copyEntry(orgId: string) {
  const read = await readSlackCopy(env.IDEMPOTENCY as never, KEY)
  return read.kind === 'read' ? read.connections.get(orgId) : undefined
}

/** Slack accepting every token: POST /slack checks the token with auth.test before saving it (#2331). */
function slackAcceptsToken() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, team: 'Pennie HQ' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.stubGlobal('fetch', slackAcceptsToken())
  store = new Map()
  await rememberSlackConnections(env.IDEMPOTENCY as never, KEY, new Map([
    [ORG, parseSlackConnection({ bot_token: 'copy-bot-token', default_channel: '#copy' })!],
  ]), Date.parse('2026-10-17T00:00:00Z'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /integrations/slack seals the token', () => {
  it('writes credential_enc (opening to the token under the current key) and no plaintext in config', async () => {
    const { client, rec } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts', workspace_name: 'Pennie' })
    expect(res.status).toBe(200)
    expect(rec.tokenSaves).toHaveLength(1)
    const saved = rec.tokenSaves[0]
    expect(saved.p_organization_id).toBe(ORG)
    expect(saved.p_actor).toBe(USER)
    expect(typeof saved.p_credential_enc).toBe('string')
    expect(saved.p_credential_enc).not.toContain(TOKEN)
    expect(await decryptSecret(saved.p_credential_enc as string, KEY)).toBe(TOKEN)
    // #2331's contract release: the token lives only in credential_enc. #2643: config carries only the token save's own keys.
    expect(saved.p_config).toEqual({ default_channel: '#alerts', workspace_name: 'Pennie' })
    expect(JSON.stringify(saved.p_config)).not.toContain(TOKEN)
    expect((await copyEntry(ORG))?.bot_token).toBe(TOKEN)
  })

  // #2332 and #2643: the save goes through save_slack_alert_token, never a
  // direct write of the table. The function names the alert row slack (the name
  // migration 20261017150000 backfilled and reserves from ops rows), upserts on
  // UNIQUE (organization_id, service_type, name), stores it as a bot_token
  // (#2332 release 3, never the legacy oauth the narrowed auth_type CHECK
  // refuses) with no Cloudflare secret name, and seals it for the ring: proven
  // against Postgres in supabase/tests/slack_alert_config_own_keys.test.sql
  // case C.
  it('saves through save_slack_alert_token and writes the table no other way', async () => {
    const { client, rec } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts' })
    expect(res.status).toBe(200)
    expect(rec.rpcs.map((r) => r.name)).toEqual(['save_slack_alert_token'])
    expect(rec.upserts).toEqual([])
    expect(rec.updates).toEqual([])
  })

  it('answers 500, and leaves the copy, when the save function fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = recordingSupabase({ rpcResult: { data: null, error: { code: '22023', message: 'slack_alert_config_refused: the token save does not own volume_alerts_enabled' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts' })
    expect(res.status).toBe(500)
    expect((await copyEntry(ORG))?.bot_token).toBe('copy-bot-token')
  })

  it('writes no route audit row: the table trigger records the change once', async () => {
    const { client } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

describe('PATCH /integrations/slack/settings', () => {
  it('keeps an org whose row holds only credential_enc in the copy, with its token', async () => {
    const { client, rec } = recordingSupabase({ row: { id: 'sc-1', config: { default_channel: '#alerts' }, credential_enc: await encryptSecret(TOKEN, KEY) } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('PATCH', '/integrations/slack/settings', { volume_alerts_enabled: false })
    expect(res.status).toBe(200)
    expect(await copyEntry(ORG)).toMatchObject({ bot_token: TOKEN, volume_alerts_enabled: false })
    // Only the setting changed is sent (#2643), never the token, and never by a direct write of the table.
    expect(rec.settingsSaves).toEqual([{ p_organization_id: ORG, p_connection_id: 'sc-1', p_settings: { volume_alerts_enabled: false }, p_actor: USER }])
    expect(rec.updates).toEqual([])
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('leaves the copy entry alone when the row token cannot be opened, rather than deleting it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = recordingSupabase({ row: { id: 'sc-1', config: { default_channel: '#alerts' }, credential_enc: await encryptSecret(TOKEN, OTHER_KEY) } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('PATCH', '/integrations/slack/settings', { volume_alerts_enabled: false })
    expect(res.status).toBe(200)
    expect((await copyEntry(ORG))?.bot_token).toBe('copy-bot-token')
  })
})

describe('GET /integrations/slack/channels', () => {
  it('lists channels with the token opened from credential_enc', async () => {
    const { client } = recordingSupabase({ row: { config: { default_channel: '#alerts' }, credential_enc: await encryptSecret(TOKEN, KEY) } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    // A fresh Response per call: a body can be read only once.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'alerts' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await call('GET', '/integrations/slack/channels?q=ale')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ channels: [{ id: 'C1', name: 'alerts' }] })
    // The search posts through createSlackClient (#2331); read the token whichever shape the call took.
    expect((await slackPostOf(fetchMock.mock.calls[0])).token).toBe(TOKEN)
  })

  it('says the token cannot be read, by name, rather than that Slack is not connected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = recordingSupabase({ row: { config: { default_channel: '#alerts' }, credential_enc: await encryptSecret(TOKEN, OTHER_KEY) } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('GET', '/integrations/slack/channels?q=ale')
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('slack_token_undecryptable') })
  })
})

describe('DELETE /integrations/slack', () => {
  it('deletes the alert row it read, by id, with the caller as actor, and writes no route audit row', async () => {
    const { client, rec } = recordingSupabase({ row: { id: 'sc-1' } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(rec.rpcs).toEqual([{ name: 'delete_service_connection_by_id', args: { p_organization_id: ORG, p_connection_id: 'sc-1', p_actor: USER } }])
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(await copyEntry(ORG)).toBeUndefined()
  })

  it('answers 500 and leaves the copy when the delete function fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = recordingSupabase({ row: { id: 'sc-1' }, rpcResult: { data: null, error: { code: 'BP503', message: 'connection_audit_failed' } } })
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(500)
    expect((await copyEntry(ORG))?.bot_token).toBe('copy-bot-token')
  })
})
