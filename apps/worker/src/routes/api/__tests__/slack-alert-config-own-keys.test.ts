/**
 * A Slack alert Reconnect and an alert settings save never put back each
 * other's old values (#2643).
 *
 * The Slack alert login's settings live in one service_connections.config
 * object with two writers: the token save (saveSlackAlertConnection, which the
 * Connections page's Reconnect and POST /api/integrations/slack both call) and
 * the alert settings save (PATCH /api/integrations/slack/settings: the channel
 * and the four switches). Each used to read the whole object, change its own
 * keys and write the whole object back. When the two ran at once, the later
 * write put back the other's old values, with both answering success: a switch
 * just turned off came back on, or a workspace name just learned reverted.
 *
 * Now each writer sends ONLY the keys it owns, and the database merges them
 * into the row's config in one statement (save_slack_alert_token and
 * save_slack_alert_settings, migration 20261027170000). The double below holds
 * one row the way the database does, and merges the way those functions do;
 * supabase/tests/slack_alert_config_own_keys.test.sql proves the real
 * functions, two sessions racing included.
 *
 * Who may call either route: any signed in user of the organization (jwtAuth).
 * Whose data: the caller's organization's alert row only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { rpcStub } from '../../../test-setup/rpc-stub'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { decryptSecret, encryptSecret } from '../../../lib/secret-crypto'
import { SLACK_ALERT_SETTINGS_KEYS, SLACK_ALERT_TOKEN_SAVE_KEYS } from '../../../lib/slack-connection'
import { slackPostOf } from '../../../__tests__/helpers/slack-fetch'
import api from '../index'
// Read through Vite's raw import rather than node:fs, because the worker tsconfig targets the
// Workers runtime and carries no Node types.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no ambient declaration for it here.
import OWN_KEYS_MIGRATION from '../../../../../../supabase/migrations/20261027170000_slack_alert_config_own_keys_2643.sql?raw'
// @ts-expect-error As above: the five argument settings save the route calls (#2870).
import CHANGED_BY_MIGRATION from '../../../../../../supabase/migrations/20261027230000_slack_alert_settings_changed_by_2870.sql?raw'

const ORG = '0a000000-0000-4000-8000-000000002643'
const OTHER_ORG = '0b000000-0000-4000-8000-000000002643'
const USER = 'aa000000-0000-4000-8000-000000002643'
const SECOND_USER = 'ab000000-0000-4000-8000-000000002870'
/** The email the users row of each signed in person carries, as auth_user_with_allowlist answers it. */
const EMAIL_OF: Record<string, string> = { [USER]: 'dan@pennie.com', [SECOND_USER]: 'second@pennie.com' }
const ALERT_ROW = 'c0000000-0000-4000-8000-000000002643'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const OLD_TOKEN = 'canary-old-alert-token-2643'
const NEW_TOKEN = 'canary-new-alert-token-2643'

type Row = Record<string, unknown>
type Config = Record<string, unknown>

/** A merge of a patch into a stored config, as `config || patch` does in the database (a config that is not an object counts as empty). */
function mergeConfig(stored: unknown, patch: Config): Config {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Config) : {}
  return { ...base, ...patch }
}

/**
 * The organization's alert row, held as the database holds it, with every
 * write either writer has ever sent: the old whole object upsert and update,
 * and the two merging functions. A read can be held after it is taken
 * (holdNextAlertRead), which is how a test puts one writer's read before the
 * other's write.
 */
async function liveTable() {
  const row: Row = {
    id: ALERT_ROW, organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring',
    credential_enc: await encryptSecret(OLD_TOKEN, KEY),
    config: { default_channel: '#bidspoke-alerts', workspace_name: 'Pennie', volume_alerts_enabled: true, matrix_alerts_enabled: true },
    updated_at: '2026-10-27T12:00:00Z', updated_by: USER, updated_by_email: EMAIL_OF[USER],
  }
  const table: Row[] = [row]
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  let held: { taken: () => void; release: Promise<void> } | null = null

  const holdNextAlertRead = () => {
    let taken!: () => void
    let release!: () => void
    const tookIt = new Promise<void>((r) => { taken = r })
    held = { taken, release: new Promise<void>((r) => { release = r }) }
    return { taken: tookIt, release }
  }

  const from = (name: string) => {
    if (name !== 'service_connections') throw new Error(`the double holds service_connections only, not ${name}`)
    const filters: Array<(r: Row) => boolean> = []
    let alertRead = false
    let cap = Infinity
    // Rows as the read saw them, copied, so a later write cannot change what the reader already holds.
    const snapshot = () => table.filter((r) => filters.every((f) => f(r))).slice(0, cap).map((r) => structuredClone(r))
    const b = {
      select() { return b },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      or(filter: string) {
        if (filter !== 'sealed_for.eq.bidding_ring,sealed_for.is.null') throw new Error(`the double reads no filter ${filter}`)
        filters.push((r) => r.sealed_for === 'bidding_ring' || r.sealed_for === null)
        alertRead = true
        return b
      },
      limit(n: number) { cap = n; return b },
      async maybeSingle() { return { data: snapshot()[0] ?? null, error: null } },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        const seen = snapshot()
        const hold = alertRead ? held : null
        if (hold) held = null
        const answer = async () => {
          if (hold) { hold.taken(); await hold.release }
          return { data: seen, error: null as null }
        }
        return answer().then(resolve, reject)
      },
      // The token save as it was before #2643: the whole config, as the writer last read it.
      upsert(payload: Row) {
        const done = {
          select() { return done },
          async single() {
            const at = table.find((r) => r.organization_id === payload.organization_id && r.service_type === payload.service_type && r.name === payload.name)
            if (at) Object.assign(at, payload)
            return { data: { id: at?.id }, error: null }
          },
        }
        return done
      },
      // The settings save as it was before #2643: the whole config, as the writer last read it.
      update(patch: Row) {
        const where: Array<(r: Row) => boolean> = []
        const u = {
          eq(col: string, v: unknown) { where.push((r) => r[col] === v); return u },
          select() { return u },
          then(resolve: (v: { data: Row[]; error: null }) => unknown) {
            const hit = table.filter((r) => where.every((f) => f(r)))
            for (const r of hit) Object.assign(r, patch)
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve)
          },
        }
        return u
      },
    }
    return b
  }

  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'auth_user_with_allowlist') {
      const id = args.p_user_id as string
      return { data: [{ id, organization_id: ORG, email: EMAIL_OF[id], display_name: 'Dan Wright', allowed: true }], error: null }
    }
    rpcCalls.push({ fn, args })
    // The two functions of migration 20261027170000: each merges its own keys into the row's config.
    if (fn === 'save_slack_alert_token') {
      const at = table.find((r) => r.organization_id === args.p_organization_id && r.service_type === 'slack' && r.name === 'slack')
      if (!at) return { data: null, error: { code: '23503', message: 'the double inserts no new row' } }
      Object.assign(at, { config: mergeConfig(at.config, args.p_config as Config), credential_enc: args.p_credential_enc, sealed_for: 'bidding_ring', updated_by: args.p_actor, updated_by_email: args.p_actor_email })
      return { data: [{ id: at.id, config: at.config, credential_enc: at.credential_enc }], error: null }
    }
    if (fn === 'save_slack_alert_settings') {
      const at = table.find((r) => r.id === args.p_connection_id && r.organization_id === args.p_organization_id && r.sealed_for !== 'ops_key')
      if (!at) return { data: [], error: null }
      // The four argument form (20261027170000) leaves updated_by_email as the row holds it;
      // the five argument form (20261027230000, #2870) writes the email it is given.
      const email = 'p_actor_email' in args ? { updated_by_email: args.p_actor_email } : {}
      Object.assign(at, { config: mergeConfig(at.config, args.p_settings as Config), updated_by: args.p_actor, ...email })
      return { data: [{ id: at.id, config: at.config, credential_enc: at.credential_enc }], error: null }
    }
    return { data: null, error: { code: '42883', message: `no function ${fn}` } }
  }

  return { from, rpc, row, rpcCalls, holdNextAlertRead }
}

function slackAcceptsEveryToken() {
  vi.stubGlobal('fetch', vi.fn(async (...call: unknown[]) => {
    const post = await slackPostOf(call)
    if (!post.url.endsWith('/auth.test')) throw new Error(`the double answers auth.test only, not ${post.url}`)
    return new Response(JSON.stringify({ ok: true, user: 'bidspoke', team: 'Pennie HQ' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

let kv: Map<string, string>

function makeEnv(): Env {
  const ops = { verify: vi.fn(), clearReauth: vi.fn(), revoke: vi.fn(), health: vi.fn(), lookup: vi.fn(), exchangeOAuthCode: vi.fn() }
  return {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    WORKFLOW_CACHE: {},
    SECRET_ENCRYPTION_KEY: KEY,
    OPS_CONNECTIONS: rpcStub(ops),
    IDEMPOTENCY: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v) } },
  } as unknown as Env
}

async function call(env: Env, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, recordingContext())
}

const reconnect = (env: Env) => call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
const turnVolumeOff = (env: Env) => call(env, 'PATCH', '/integrations/slack/settings', { volume_alerts_enabled: false })

beforeEach(() => {
  vi.clearAllMocks()
  kv = new Map()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  slackAcceptsEveryToken()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a Reconnect and a settings save at the same moment both keep their change (#2643)', () => {
  it('a switch turned off while a Reconnect is in flight stays off, and the new token and workspace are saved', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const env = makeEnv()

    // The Reconnect reads the row (volume alerts on), then waits.
    const held = db.holdNextAlertRead()
    const reconnecting = reconnect(env)
    await held.taken
    // Meanwhile the settings save turns volume alerts off, and finishes.
    const saved = await turnVolumeOff(env)
    expect(saved.status).toBe(200)
    expect(db.row.config).toMatchObject({ volume_alerts_enabled: false })
    // Now the Reconnect writes.
    held.release()
    const reconnected = await reconnecting
    expect(reconnected.status).toBe(200)

    expect(db.row.config).toMatchObject({ volume_alerts_enabled: false, workspace_name: 'Pennie HQ', default_channel: '#bidspoke-alerts', matrix_alerts_enabled: true })
    expect(await decryptSecret(db.row.credential_enc as string, KEY)).toBe(NEW_TOKEN)
  })

  it('a workspace name a Reconnect learned while a settings save is in flight is kept, and the switch is saved', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const env = makeEnv()

    // The settings save reads the row (workspace Pennie, the old token), then waits.
    const held = db.holdNextAlertRead()
    const saving = turnVolumeOff(env)
    await held.taken
    // Meanwhile a Reconnect saves the new token, which Slack names Pennie HQ, and finishes.
    expect((await reconnect(env)).status).toBe(200)
    expect(db.row.config).toMatchObject({ workspace_name: 'Pennie HQ' })
    // Now the settings save writes.
    held.release()
    expect((await saving).status).toBe(200)

    expect(db.row.config).toMatchObject({ volume_alerts_enabled: false, workspace_name: 'Pennie HQ', default_channel: '#bidspoke-alerts', matrix_alerts_enabled: true })
    expect(await decryptSecret(db.row.credential_enc as string, KEY)).toBe(NEW_TOKEN)
  })
})

describe('each writer sends only the keys it owns', () => {
  it('a Reconnect sends the sealed token and the workspace name, never the channel or a switch it read', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    expect((await reconnect(makeEnv())).status).toBe(200)
    const saves = db.rpcCalls.filter((c) => c.fn === 'save_slack_alert_token')
    expect(saves).toHaveLength(1)
    expect(saves[0].args).toMatchObject({ p_organization_id: ORG, p_actor: USER, p_actor_email: 'dan@pennie.com' })
    expect(saves[0].args.p_config).toEqual({ workspace_name: 'Pennie HQ' })
    expect(await decryptSecret(saves[0].args.p_credential_enc as string, KEY)).toBe(NEW_TOKEN)
  })

  it('a settings save sends only the settings in its body, for the row it read, under its user', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const res = await call(makeEnv(), 'PATCH', '/integrations/slack/settings', { volume_alerts_enabled: false, default_channel: '#new-alerts' })
    expect(res.status).toBe(200)
    const saves = db.rpcCalls.filter((c) => c.fn === 'save_slack_alert_settings')
    expect(saves).toEqual([{ fn: 'save_slack_alert_settings', args: { p_organization_id: ORG, p_connection_id: ALERT_ROW, p_settings: { volume_alerts_enabled: false, default_channel: '#new-alerts' }, p_actor: USER, p_actor_email: 'dan@pennie.com' } }])
  })

  it('a settings save by a second person changes who the alert settings answer as last changed by (#2870)', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const env = makeEnv()
    // The first person saved the token, so the row names them.
    expect(await (await call(env, 'GET', '/integrations/slack')).json()).toMatchObject({ updated_by_email: 'dan@pennie.com' })
    // A second person changes a setting.
    vi.mocked(verifyJwt).mockResolvedValue({ sub: SECOND_USER, email: 'second@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
    expect((await turnVolumeOff(env)).status).toBe(200)
    expect(await (await call(env, 'GET', '/integrations/slack')).json()).toMatchObject({ volume_alerts_enabled: false, updated_by_email: 'second@pennie.com' })
    expect(db.row).toMatchObject({ updated_by: SECOND_USER, updated_by_email: 'second@pennie.com' })
  })

  it('a settings save with a switch that is not true or false, or a body that is not an object, is refused before anything is read or written', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const env = makeEnv()
    const notSwitch = await call(env, 'PATCH', '/integrations/slack/settings', { volume_alerts_enabled: 'false' })
    expect(notSwitch.status).toBe(400)
    expect(await notSwitch.json()).toEqual({ error: 'volume_alerts_enabled must be true or false' })
    const notChannel = await call(env, 'PATCH', '/integrations/slack/settings', { default_channel: 7 })
    expect(notChannel.status).toBe(400)
    const notObject = await call(env, 'PATCH', '/integrations/slack/settings', [true])
    expect(notObject.status).toBe(400)
    expect(db.rpcCalls).toEqual([])
    expect(db.row.config).toMatchObject({ volume_alerts_enabled: true, default_channel: '#bidspoke-alerts' })
  })

  it('a settings save keeps leaving the channel alone when the body names it empty, as it always has', async () => {
    const db = await liveTable()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const res = await call(makeEnv(), 'PATCH', '/integrations/slack/settings', { default_channel: '', matrix_alerts_enabled: false })
    expect(res.status).toBe(200)
    expect(db.rpcCalls.map((c) => c.args.p_settings)).toEqual([{ matrix_alerts_enabled: false }])
    expect(db.row.config).toMatchObject({ default_channel: '#bidspoke-alerts', matrix_alerts_enabled: false })
  })

  it('a settings save of another organization\'s row writes nothing and answers not connected', async () => {
    const db = await liveTable()
    db.row.organization_id = OTHER_ORG
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const res = await turnVolumeOff(makeEnv())
    expect(res.status).toBe(404)
    expect(db.row.config).toMatchObject({ volume_alerts_enabled: true })
    expect(db.rpcCalls).toEqual([])
  })

  it('the keys each writer may send are the keys its database function accepts, so the two lists cannot drift', () => {
    const arrayAfter = (migration: string, marker: string) => {
      const at = migration.indexOf(marker)
      expect(at, marker).toBeGreaterThan(-1)
      const list = /ARRAY\[([^\]]*)\]/.exec(migration.slice(at))
      return (list?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    }
    // Both forms of the settings save, the four argument one (#2643) and the five argument one the route calls (#2870).
    expect(arrayAfter(OWN_KEYS_MIGRATION as string, '-- settings keys')).toEqual([...SLACK_ALERT_SETTINGS_KEYS].sort())
    expect(arrayAfter(CHANGED_BY_MIGRATION as string, '-- settings keys')).toEqual([...SLACK_ALERT_SETTINGS_KEYS].sort())
    expect(arrayAfter(OWN_KEYS_MIGRATION as string, '-- token save keys')).toEqual([...SLACK_ALERT_TOKEN_SAVE_KEYS].sort())
  })
})
