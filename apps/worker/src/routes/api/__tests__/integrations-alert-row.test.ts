/**
 * The Slack settings routes act on the alert row and only the alert row
 * (#2332, phase 2 of #1689, PR (b)).
 *
 * Who may call these: any signed in user of the organization (jwtAuth). Whose
 * data: the caller's organization's Slack ALERT row (service_type 'slack', name
 * 'slack', sealed_for 'bidding_ring' or the legacy unsealed form), never an ops
 * Slack connection of the same organization, which release 2 allows beside it.
 *
 * Run against the REAL supabase-js client and an in memory PostgREST that
 * evaluates the query the route sends (helpers/postgrest-fake.ts), so a route
 * whose filter is wrong reads or changes the ops row here as it would in
 * production. More than one candidate is the named refusal
 * slack_alert_connection_ambiguous (409), never "not connected", and nothing is
 * read from, written to or deleted from either row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { registerSlackKeyRing } from '../../../lib/slack-key-ring'
import { parseSlackConnection } from '../../../lib/slack-connection'
import { readSlackCopy, rememberSlackConnections } from '../../../lib/slack-copy'
import { fakePostgrest, type Row } from '../../../__tests__/helpers/postgrest-fake'

const ORG = 'org-2332'
const USER = 'user-2332'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const validPayload = { sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const alertRow = (): Row => ({
  id: 'alert-row', organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: null, credential_enc: null,
  config: { bot_token: 'alert-bot-token', default_channel: '#alerts', workspace_name: 'Pennie' },
  updated_at: '2026-10-17T00:00:00Z', updated_by_email: 'dan@pennie.com',
})
const opsRow = (): Row => ({
  id: 'ops-row', organization_id: ORG, service_type: 'slack', name: 'ops-bot', sealed_for: 'ops_key', credential_enc: null,
  config: { bot_token: 'OPS-bot-token', default_channel: '#ops', workspace_name: 'Ops' },
  updated_at: '2026-10-16T00:00:00Z', updated_by_email: 'ops@pennie.com',
})
const secondCandidate = (): Row => ({
  id: 'second-row', organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring', credential_enc: null,
  config: { bot_token: 'second-bot-token', default_channel: '#second' },
})

const otherSlackRow = (): Row => ({
  id: 'other-slack-row', organization_id: ORG, service_type: 'slack', name: 'second workspace', sealed_for: null, credential_enc: null,
  config: { bot_token: 'other-bot-token', default_channel: '#other' },
})

/**
 * The database as the routes see it. Each delete function follows its
 * migration: delete_service_connection (20261017150000) removes the org's rows
 * of the type that are not ops_key rows; delete_service_connection_by_id
 * (20261018150000) removes the one row named, in the org named, never an
 * ops_key row.
 */
function database(rows: Row[]) {
  const fake = fakePostgrest({ service_connections: rows }, {
    auth_user_with_allowlist: () => ({ data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', allowed: true }] }),
    delete_service_connection: (args, tables) => {
      const gone = tables.service_connections.filter((r) => r.organization_id === args.p_organization_id && r.service_type === args.p_service_type && r.sealed_for !== 'ops_key')
      tables.service_connections = tables.service_connections.filter((r) => !gone.includes(r))
      return { data: gone.map((r) => ({ id: r.id })) }
    },
    delete_service_connection_by_id: (args, tables) => {
      const gone = tables.service_connections.filter((r) => r.id === args.p_connection_id && r.organization_id === args.p_organization_id && r.sealed_for !== 'ops_key')
      tables.service_connections = tables.service_connections.filter((r) => !gone.includes(r))
      return { data: gone.map((r) => ({ id: r.id })) }
    },
  })
  registerSlackKeyRing(fake.client, { encryptWith: KEY, decryptWith: [KEY] })
  vi.mocked(createSupabaseClient).mockReturnValue(fake.client as never)
  return fake
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

async function copyEntry() {
  const read = await readSlackCopy(env.IDEMPOTENCY as never, KEY)
  return read.kind === 'read' ? read.connections.get(ORG) : undefined
}

const opsUnchanged = (rows: Row[]) => expect(rows.find((r) => r.id === 'ops-row')).toEqual(opsRow())

let slackFetch: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  store = new Map()
  await rememberSlackConnections(env.IDEMPOTENCY as never, KEY, new Map([
    [ORG, parseSlackConnection({ bot_token: 'copy-bot-token', default_channel: '#copy' })!],
  ]), Date.parse('2026-10-17T00:00:00Z'))
  slackFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'alerts-main' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', slackFetch)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function slackTokenOf(callArgs: unknown[]): string | null {
  const [input, init] = callArgs as [unknown, RequestInit | undefined]
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
  return headers.get('Authorization')?.replace(/^Bearer /, '') ?? null
}

describe('GET /integrations/slack', () => {
  it('reports not connected when the only Slack row is an ops connection', async () => {
    database([opsRow()])
    const res = await call('GET', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: false })
  })

  it('reports the alert row beside an ops row', async () => {
    database([opsRow(), alertRow()])
    const body = await (await call('GET', '/integrations/slack')).json() as Record<string, unknown>
    expect(body).toMatchObject({ connected: true, workspace_name: 'Pennie', default_channel: '#alerts', updated_by_email: 'dan@pennie.com' })
  })

  it('refuses two candidates by name, not as not connected', async () => {
    database([alertRow(), secondCandidate()])
    const res = await call('GET', '/integrations/slack')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'slack_alert_connection_ambiguous' })
  })
})

describe('PATCH /integrations/slack/settings', () => {
  it('changes the alert row and leaves the ops row exactly as it was', async () => {
    const fake = database([opsRow(), alertRow()])
    const res = await call('PATCH', '/integrations/slack/settings', { default_channel: '#new-alerts' })
    expect(res.status).toBe(200)
    expect((fake.tables.service_connections.find((r) => r.id === 'alert-row')!.config as Record<string, unknown>).default_channel).toBe('#new-alerts')
    opsUnchanged(fake.tables.service_connections)
    expect((await copyEntry())?.bot_token).toBe('alert-bot-token')
  })

  it('answers not connected, and changes nothing, when the only Slack row is an ops connection', async () => {
    const fake = database([opsRow()])
    const res = await call('PATCH', '/integrations/slack/settings', { default_channel: '#new-alerts' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Slack is not connected' })
    opsUnchanged(fake.tables.service_connections)
    expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('refuses two candidates by name and writes nothing', async () => {
    const fake = database([alertRow(), secondCandidate()])
    const res = await call('PATCH', '/integrations/slack/settings', { default_channel: '#new-alerts' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'slack_alert_connection_ambiguous' })
    expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect((await copyEntry())?.bot_token).toBe('copy-bot-token')
  })
})

describe('GET /integrations/slack/channels', () => {
  it('searches with the alert row token, never the ops bot', async () => {
    database([opsRow(), alertRow()])
    const res = await call('GET', '/integrations/slack/channels?q=alerts')
    expect(res.status).toBe(200)
    expect(slackFetch.mock.calls.length).toBeGreaterThan(0)
    expect(slackFetch.mock.calls.map((c) => slackTokenOf(c))).toEqual(slackFetch.mock.calls.map(() => 'alert-bot-token'))
  })

  it('answers not connected when the only Slack row is an ops connection, and calls no Slack', async () => {
    database([opsRow()])
    const res = await call('GET', '/integrations/slack/channels?q=alerts')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Slack is not connected' })
    expect(slackFetch).not.toHaveBeenCalled()
  })

  it('refuses two candidates by name and calls no Slack', async () => {
    database([alertRow(), secondCandidate()])
    const res = await call('GET', '/integrations/slack/channels?q=alerts')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'slack_alert_connection_ambiguous' })
    expect(slackFetch).not.toHaveBeenCalled()
  })
})

describe('DELETE /integrations/slack (Disconnect)', () => {
  it('removes the alert row and leaves the ops row in place', async () => {
    const fake = database([opsRow(), alertRow()])
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(fake.tables.service_connections.map((r) => r.id)).toEqual(['ops-row'])
    opsUnchanged(fake.tables.service_connections)
    expect(await copyEntry()).toBeUndefined()
  })

  it('refuses two candidates by name, deletes nothing and leaves the saved copy', async () => {
    const fake = database([alertRow(), secondCandidate(), opsRow()])
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'slack_alert_connection_ambiguous' })
    expect(fake.tables.service_connections).toHaveLength(3)
    expect(fake.requests.some((r) => r.path.startsWith('rpc/delete_service_connection'))).toBe(false)
    expect((await copyEntry())?.bot_token).toBe('copy-bot-token')
  })

  // Release 2 lets an organization hold a second Slack row that is not an ops
  // row and not an alert candidate (another name). Deleting by service type
  // removed it with the alert row; the Disconnect now deletes only the alert
  // row it read, by id (#2332).
  it('removes only the alert row it read, so a second non ops Slack row of the organization survives', async () => {
    const fake = database([alertRow(), otherSlackRow(), opsRow()])
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(fake.tables.service_connections.map((r) => r.id).sort()).toEqual(['ops-row', 'other-slack-row'])
    expect(fake.requests.some((r) => r.path === 'rpc/delete_service_connection')).toBe(false)
    opsUnchanged(fake.tables.service_connections)
  })

  it('is still a 200 no-op when there is no alert row, and the saved copy entry goes', async () => {
    const fake = database([opsRow()])
    const res = await call('DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    opsUnchanged(fake.tables.service_connections)
    expect(await copyEntry()).toBeUndefined()
  })
})
