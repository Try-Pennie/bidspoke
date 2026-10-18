/**
 * The Slack settings routes and the sealed token (#2331, phase 1 of #1689).
 *
 * Who may call these: any signed in user of the organization (jwtAuth), and
 * each reads and writes only the caller's organization's Slack row.
 *
 * - POST /slack seals the token into credential_enc AND keeps config.bot_token
 *   beside it in this release (dual write), because the code before this
 *   release, the rollback target, reads only config.bot_token (L640).
 * - PATCH merges the token the row holds (opened from credential_enc) into the
 *   saved copy, so a row in the contract release's shape stays in the copy.
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
        return opts.rpcResult ?? { data: [{ id: 'sc-1' }], error: null }
      },
    },
  )
  const written = (method: string) => (client.calls.service_connections ?? []).filter(([m]) => m === method).map(([, args]) => args[0] as Record<string, unknown>)
  const upsertOptions = () => (client.calls.service_connections ?? []).filter(([m]) => m === 'upsert').map(([, args]) => args[1])
  return { client, rec: { get upserts() { return written('upsert') }, get upsertOptions() { return upsertOptions() }, get updates() { return written('update') }, rpcs } }
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
  const { default: api } = await import('../index')
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
  it('writes credential_enc (opening to the token under the current key) and keeps config.bot_token beside it', async () => {
    const { client, rec } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts', workspace_name: 'Pennie' })
    expect(res.status).toBe(200)
    expect(rec.upserts).toHaveLength(1)
    const saved = rec.upserts[0]
    expect(saved.organization_id).toBe(ORG)
    expect(saved.sealed_for).toBe('bidding_ring')
    expect(saved.updated_by).toBe(USER)
    expect(typeof saved.credential_enc).toBe('string')
    expect(saved.credential_enc).not.toContain(TOKEN)
    expect(await decryptSecret(saved.credential_enc as string, KEY)).toBe(TOKEN)
    // The rollback target reads only this, so it must still read the saved row.
    expect(parseSlackConnection(saved.config)?.bot_token).toBe(TOKEN)
    // #2332: the credential is in credential_enc, so no Cloudflare secret name.
    expect(saved.cf_secret_key).toBeNull()
    expect((await copyEntry(ORG))?.bot_token).toBe(TOKEN)
  })

  // #2332 (phase 2 of #1689): the alert row is named 'slack', the name
  // migration 20261017150000 backfilled onto it and reserves from ops rows, and
  // the upsert names the new UNIQUE (organization_id, service_type, name). The
  // old UNIQUE still holds until release 2, so the name must be the backfilled
  // one or the save would error instead of updating. Proven against Postgres in
  // supabase/tests/service_connections_expand.test.sql case B.
  it('names the alert row slack and upserts on (organization_id, service_type, name)', async () => {
    const { client, rec } = recordingSupabase()
    vi.mocked(createSupabaseClient).mockReturnValue(client as never)
    const res = await call('POST', '/integrations/slack', { bot_token: TOKEN, default_channel: '#alerts' })
    expect(res.status).toBe(200)
    expect(rec.upserts[0].name).toBe('slack')
    expect(rec.upsertOptions).toEqual([{ onConflict: 'organization_id,service_type,name' }])
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
    // The update never writes the token back into config.
    expect(rec.updates[0].config).not.toHaveProperty('bot_token')
    expect(rec.updates[0].updated_by).toBe(USER)
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
