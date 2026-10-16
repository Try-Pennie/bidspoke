/**
 * Integrations routes — Slack OAuth connect, list connections, delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { makeSupabase } from './_supabase-mock'
import { readSlackCopy, rememberSlackConnections, SLACK_CONNS_LASTGOOD_KEY } from '../../../lib/slack-copy'
import { parseSlackConnection } from '../../../lib/slack-connection'
import { COPY_NOT_CLEARED_MESSAGE } from '../../../lib/stored-copy'

// ── Supabase mock ─────────────────────────────────────────────────────────────

// ── Fetch mock helpers ─────────────────────────────────────────────────────────

function jsonFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: { forEach: vi.fn() },
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

// No saved Slack copy by default, so a route editing it finds nothing to edit (#2060).
const NO_COPY_KV = { get: async () => null, put: async () => {} }
const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  IDEMPOTENCY: NO_COPY_KV,
  SECRET_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
} as unknown as Env

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(app: { request: Function }, method: string, path: string, opts: { body?: unknown } = {}) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }, testEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /integrations/slack/resolve', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    app = await makeApp()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 400 when bot_token is missing', async () => {
    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: {} })
    expect(res.status).toBe(400)
  })

  it('returns 400 when Slack auth.test rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonFetchResponse({ ok: false, error: 'invalid_auth' })
    ))
    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: { bot_token: 'bad-token' } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/invalid_auth/)
  })

  it('returns 200 with workspace_name and channels on success', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonFetchResponse({ ok: true, team: 'Pennie HQ' }))
      .mockResolvedValueOnce(jsonFetchResponse({
        ok: true,
        channels: [
          { id: 'C2', name: 'general' },
          { id: 'C1', name: 'alerts' },
        ],
      }))
    vi.stubGlobal('fetch', mockFetch)

    const res = await request(app, 'POST', '/integrations/slack/resolve', { body: { bot_token: 'xoxb-valid' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { workspace_name: string; channels: Array<{ id: string; name: string }> }
    expect(body.workspace_name).toBe('Pennie HQ')
    expect(body.channels).toHaveLength(2)
    // channels are sorted by name
    expect(body.channels[0].name).toBe('alerts')
    expect(body.channels[1].name).toBe('general')
  })
})

describe('POST /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 400 when bot_token is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    const res = await request(app, 'POST', '/integrations/slack', { body: { default_channel: '#alerts' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when default_channel is missing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser } }) as never)
    const res = await request(app, 'POST', '/integrations/slack', { body: { bot_token: 'xoxb-123' } })
    expect(res.status).toBe(400)
  })

  it('returns 200 and upserts the connection', async () => {
    const upserted = { id: 'sc-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { upsertResult: upserted },
      }) as never
    )
    const res = await request(app, 'POST', '/integrations/slack', {
      body: { bot_token: 'xoxb-123', default_channel: '#alerts', workspace_name: 'Pennie HQ' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

describe('GET /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns { connected: false } when no Slack connection exists', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { maybeSingle: null } }) as never
    )
    const res = await request(app, 'GET', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { connected: boolean }
    expect(body.connected).toBe(false)
  })

  it('returns connection details when connected', async () => {
    const connection = {
      config: { bot_token: 'xoxb-secret', default_channel: '#alerts', workspace_name: 'Pennie HQ' },
      updated_at: '2026-01-02T00:00:00Z',
      updated_by_email: 'dan@pennie.com',
    }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { maybeSingle: connection } }) as never
    )
    const res = await request(app, 'GET', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { connected: boolean; workspace_name: string; default_channel: string; config_alerts_enabled: boolean; backup_alerts_enabled: boolean }
    expect(body.connected).toBe(true)
    expect(body.workspace_name).toBe('Pennie HQ')
    expect(body.default_channel).toBe('#alerts')
    // Alert flags default on when absent from config (opt-out semantics).
    expect(body.config_alerts_enabled).toBe(true)
    // #223: backup alerts have their own flag, also defaulting on.
    expect(body.backup_alerts_enabled).toBe(true)
  })
})

describe('DELETE /integrations/slack', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 200 and deletes the connection', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { maybeSingle: { id: 'sc-1' } },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('still returns 200 when no connection existed', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { maybeSingle: null },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
  })

  it('still returns 200 but writes no audit log when the delete matches zero rows (#588)', async () => {
    // Disconnecting a Slack that was never connected is a legitimate no-op, so
    // this stays 200. But the audit line is gated on the row the delete actually
    // removed, so a zero-row delete must not log a disconnect that never happened.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { writeRows: [] },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 and audits the removed row id when the delete matches a row (#588)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { writeRows: [{ id: 'sc-9' }] },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(), USER_ORG, 'service_connection', 'sc-9', 'deleted', 'user-1', { service_type: 'slack' }
    )
  })

  it('returns 500 (not a false 404) when the delete hits a real DB error', async () => {
    // A transient write failure must surface as a retryable 500, never be
    // swallowed into the no-op 200 path (#588).
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { deleteError: { code: '42P01', message: 'relation missing' } },
      }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// ── The saved Slack copy (#2060) ─────────────────────────────────────────────
//
// Alerts post from an encrypted copy of every org's Slack connection while the
// database is down. A route that disconnects an org or changes its settings
// edits that org's entry in the copy in the same request, so an outage does not
// post to a connection that was just removed or a category just switched off.
// A copy that cannot be edited is reported beside the success, the way every
// other stored copy is (stored_copy_warning, lib/stored-copy.ts).
describe('the saved Slack copy follows the Slack settings routes (#2060)', () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  const OTHER_ORG = 'org-other'
  const SAVED_AT = Date.parse('2026-10-15T03:00:00Z')
  let app: Awaited<ReturnType<typeof makeApp>>
  let store: Map<string, string>
  let putFails: boolean
  const env = testEnv as unknown as Record<string, unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    store = new Map()
    putFails = false
    env.SECRET_ENCRYPTION_KEY = KEY
    env.IDEMPOTENCY = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (putFails) throw new Error('KV put failed: 503')
        store.set(k, v)
      },
    }
    await rememberSlackConnections(env.IDEMPOTENCY as never, KEY, new Map([
      [USER_ORG, parseSlackConnection({ bot_token: 'xoxb-mine', default_channel: '#mine' })!],
      [OTHER_ORG, parseSlackConnection({ bot_token: 'xoxb-other', default_channel: '#other' })!],
    ]), SAVED_AT)
    app = await makeApp()
  })
  afterEach(() => {
    env.IDEMPOTENCY = NO_COPY_KV
    vi.restoreAllMocks()
  })

  async function copy() {
    const read = await readSlackCopy(env.IDEMPOTENCY as never, KEY)
    if (read.kind !== 'read') throw new Error(`expected a copy, found ${read.kind}`)
    return read
  }

  it('disconnecting removes the org from the copy in the same request, keeping the others and the save time', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { writeRows: [{ id: 'sc-9' }] } }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const after = await copy()
    expect([...after.connections.keys()]).toEqual([OTHER_ORG])
    expect(after.savedAtMs).toBe(SAVED_AT)
  })

  it('a disconnect the database refused leaves the copy as it was', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { deleteError: { code: '08006', message: 'connection refused' } } }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(500)
    expect([...(await copy()).connections.keys()].sort()).toEqual([OTHER_ORG, USER_ORG].sort())
  })

  it('switching a category off updates the org entry in the copy', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: {
          maybeSingle: { id: 'sc-1', config: { bot_token: 'xoxb-mine', default_channel: '#mine' } },
          writeRows: [{ id: 'sc-1' }],
        },
      }) as never
    )
    const res = await request(app, 'PATCH', '/integrations/slack/settings', { body: { volume_alerts_enabled: false } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const after = await copy()
    expect(after.connections.get(USER_ORG)).toMatchObject({ bot_token: 'xoxb-mine', volume_alerts_enabled: false })
    expect(after.connections.get(OTHER_ORG)?.volume_alerts_enabled).toBe(true)
  })

  it('saving a new connection replaces the org entry in the copy', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: { upsertResult: { id: 'sc-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z' } },
      }) as never
    )
    const res = await request(app, 'POST', '/integrations/slack', { body: { bot_token: 'xoxb-new', default_channel: '#new' } })
    expect(res.status).toBe(200)
    expect((await copy()).connections.get(USER_ORG)).toMatchObject({ bot_token: 'xoxb-new', default_channel: '#new' })
  })

  it('still answers 200 when the copy cannot be edited, saying so beside the success and in the log', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
    putFails = true
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { writeRows: [{ id: 'sc-9' }] } }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored_copy_warning: COPY_NOT_CLEARED_MESSAGE })
    expect(errors.some((l) => l.includes('saved Slack copy') && l.includes('KV put failed'))).toBe(true)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalled()
  })

  it('a missing encryption key cannot fail the request: the copy, which no reader with that key can open either, is left alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const key = env.SECRET_ENCRYPTION_KEY
    const before = store.get(SLACK_CONNS_LASTGOOD_KEY)
    delete env.SECRET_ENCRYPTION_KEY
    try {
      vi.mocked(createSupabaseClient).mockReturnValue(
        makeSupabase({ users: { single: testUser }, service_connections: { writeRows: [{ id: 'sc-9' }] } }) as never
      )
      const res = await request(app, 'DELETE', '/integrations/slack')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(vi.mocked(writeAuditLog)).toHaveBeenCalled()
      expect(store.get(SLACK_CONNS_LASTGOOD_KEY)).toBe(before)
    } finally {
      env.SECRET_ENCRYPTION_KEY = key
    }
  })

  it('a missing copy store cannot fail the request either: it answers 200 with the warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    delete env.IDEMPOTENCY
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, service_connections: { writeRows: [{ id: 'sc-9' }] } }) as never
    )
    const res = await request(app, 'DELETE', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored_copy_warning: COPY_NOT_CLEARED_MESSAGE })
  })

  // The audit row records the change that happened in the database, so it is
  // written before the copy is touched: a request cut off between the two then
  // loses at worst the copy edit, which the next healthy minute repairs, never
  // the record of who disconnected or changed Slack.
  it.each<[string, string, string, unknown]>([
    ['POST', '/integrations/slack', 'saving a connection', { bot_token: 'xoxb-new', default_channel: '#new' }],
    ['PATCH', '/integrations/slack/settings', 'changing a setting', { volume_alerts_enabled: false }],
    ['DELETE', '/integrations/slack', 'disconnecting', undefined],
  ])('%s %s (%s) writes the audit row before editing the copy', async (method, path, _what, body) => {
    const order: string[] = []
    vi.mocked(writeAuditLog).mockImplementation(async () => { order.push('audit') })
    const kv = env.IDEMPOTENCY as { put: (k: string, v: string) => Promise<void> }
    const put = kv.put
    kv.put = async (k: string, v: string) => { order.push('copy'); await put(k, v) }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        service_connections: {
          maybeSingle: { id: 'sc-1', config: { bot_token: 'xoxb-mine', default_channel: '#mine' } },
          upsertResult: { id: 'sc-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z' },
          writeRows: [{ id: 'sc-1' }],
        },
      }) as never
    )
    const res = await request(app, method, path, { body })
    expect(res.status).toBe(200)
    expect(order).toEqual(['audit', 'copy'])
  })
})
