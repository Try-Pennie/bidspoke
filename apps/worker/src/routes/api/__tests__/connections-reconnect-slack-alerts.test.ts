/**
 * Reconnect on the Slack alerts login (#2338, build PR 14; Dan's decision 4 of
 * 2026-10-21): POST /api/connections/:id/reconnect takes the Slack alert row as
 * it takes every other login. A new bot token is checked with Slack's auth.test
 * (verifySlackToken) before anything is sealed or written, and is then saved by
 * the one function that saves that token (saveSlackAlertConnection in
 * routes/api/integrations.ts), keeping the channel and the four alert switches.
 * With no token, the stored one is checked with Slack again and nothing is
 * written, except that an alert row never sealed is then sealed with that same
 * token (#2331). Remove stays refused for this login.
 *
 * Who may call it: any signed in user of the organization (jwtAuth). Whose
 * data: the caller's organization's alert row only; another organization's is
 * no such connection.
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
import { readSlackCopy, rememberSlackConnections } from '../../../lib/slack-copy'
import { parseSlackConnection } from '../../../lib/slack-connection'
import { slackPostOf } from '../../../__tests__/helpers/slack-fetch'
import api from '../index'

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const ALERT_ROW = 'c0000000-0000-4000-8000-000000000003'
const THEIR_ALERT_ROW = 'c0000000-0000-4000-8000-000000000004'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

const OLD_TOKEN = 'canary-old-alert-token-2338-pr14'
const NEW_TOKEN = 'canary-new-alert-token-2338-pr14'
const REFUSED_TOKEN = 'canary-refused-token-2338-pr14'
const THEIR_TOKEN = 'canary-their-token-2338-pr14'

type Row = Record<string, unknown>

/** The alert row as production holds it on 2026-10-21: one switch written, the others never set, no matrix channel. */
async function rows(): Promise<Row[]> {
  return [
    {
      id: ALERT_ROW, organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring',
      credential_enc: await encryptSecret(OLD_TOKEN, KEY),
      config: { bot_token: OLD_TOKEN, default_channel: '#bidspoke-alerts', workspace_name: 'Pennie', volume_alerts_enabled: false, matrix_alerts_channel: null },
    },
    {
      id: THEIR_ALERT_ROW, organization_id: OTHER_ORG, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring',
      credential_enc: await encryptSecret(THEIR_TOKEN, KEY), config: { bot_token: THEIR_TOKEN, default_channel: '#theirs' },
    },
  ]
}

/**
 * service_connections with the filters the alert row read sends (eq, or, limit), the token save the
 * Reconnect sends (save_slack_alert_token, which merges its config into the row's, #2643) and any update.
 */
async function storeDouble(opts: { saveError?: { code: string; message: string }; updateError?: { code: string; message: string }; table?: Row[] } = {}) {
  const table = opts.table ?? await rows()
  const tokenSaves: Array<Record<string, unknown>> = []
  const updates: Row[] = []
  const from = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let cap = Infinity
    const found = () => (name === 'service_connections' ? table.filter((r) => filters.every((f) => f(r))).slice(0, cap) : [])
    const b = {
      select() { return b },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      or(filter: string) {
        // The one alert row filter (SLACK_ALERT_SEAL_FILTER): sealed for the ring, or the legacy unsealed form.
        if (filter !== 'sealed_for.eq.bidding_ring,sealed_for.is.null') throw new Error(`the double reads no filter ${filter}`)
        filters.push((r) => r.sealed_for === 'bidding_ring' || r.sealed_for === null || r.sealed_for === undefined)
        return b
      },
      limit(n: number) { cap = n; return b },
      async maybeSingle() { return { data: found()[0] ?? null, error: null } },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: found(), error: null }).then(resolve) },
      // Any UPDATE (eq and is filters, then select('id') answers the rows written), recorded so a test can assert that a check writes none.
      update(patch: Row) {
        const where: Array<(r: Row) => boolean> = []
        const u = {
          eq(col: string, v: unknown) { where.push((r) => r[col] === v); return u },
          is(col: string, v: unknown) { where.push((r) => (r[col] ?? null) === v); return u },
          select() { return u },
          then(resolve: (v: { data: Row[] | null; error: { code: string; message: string } | null }) => unknown) {
            if (opts.updateError) return Promise.resolve({ data: null, error: opts.updateError }).then(resolve)
            const hit = table.filter((r) => where.every((f) => f(r)))
            for (const r of hit) { Object.assign(r, patch); updates.push({ id: r.id, ...patch }) }
            return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve)
          },
        }
        return u
      },
    }
    return b
  }
  const rpc = (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'auth_user_with_allowlist') {
      return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
    }
    // save_slack_alert_token (migration 20261027170000, proven in supabase/tests/slack_alert_config_own_keys.test.sql):
    // the organization's alert row, its config merged with the keys sent, the sealed token replaced, the row sealed.
    if (fn === 'save_slack_alert_token') {
      tokenSaves.push(args)
      if (opts.saveError) return Promise.resolve({ data: null, error: opts.saveError })
      const at = table.find((r) => r.organization_id === args.p_organization_id && r.service_type === 'slack' && r.name === 'slack')
      if (!at) return Promise.resolve({ data: null, error: { code: '23503', message: 'the double creates no new row' } })
      const stored = at.config && typeof at.config === 'object' ? (at.config as Row) : {}
      Object.assign(at, { config: { ...stored, ...(args.p_config as Row) }, credential_enc: args.p_credential_enc, sealed_for: 'bidding_ring', updated_by: args.p_actor })
      return Promise.resolve({ data: [{ id: at.id, config: at.config, credential_enc: at.credential_enc }], error: null })
    }
    // remove_ops_connection's rule (supabase/tests/connections_page_bidding.test.sql): a row that is not an ops_key row is refused as BP422.
    if (fn === 'remove_ops_connection') {
      const row = table.find((r) => r.id === args.p_connection_id && r.organization_id === args.p_organization_id)
      if (!row) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'connection_not_found' } })
      return Promise.resolve({ data: null, error: { code: 'BP422', message: 'connection_not_ops_key' } })
    }
    return Promise.resolve({ data: null, error: { code: '42883', message: `no function ${fn}` } })
  }
  return { from, rpc, table, tokenSaves, updates }
}

/** The alert row as production holds it on 2026-10-22: never sealed (sealed_for null, no credential_enc), the token in config only. */
function unsealedRows(): Row[] {
  return [{
    id: ALERT_ROW, organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: null, credential_enc: null,
    config: { bot_token: OLD_TOKEN, default_channel: '#bidspoke-alerts', workspace_name: 'Pennie' },
  }]
}

/** Slack's auth.test: each token answered as Slack would, and every token asked recorded. */
function slackAuthTest(answer: (token: string) => Response | Promise<Response>) {
  const asked: string[] = []
  const fetch = vi.fn(async (...call: unknown[]) => {
    const post = await slackPostOf(call)
    if (!post.url.endsWith('/auth.test')) throw new Error(`the double answers auth.test only, not ${post.url}`)
    asked.push(post.token ?? '')
    return answer(post.token ?? '')
  })
  vi.stubGlobal('fetch', fetch)
  return asked
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const slackAccepts = (token: string) => json(token === REFUSED_TOKEN ? { ok: false, error: 'invalid_auth' } : { ok: true, user: 'bidspoke', team: 'Pennie HQ' })

let kv: Map<string, string>

function makeEnv(over: Partial<Record<string, unknown>> = {}) {
  const ops = {
    verify: vi.fn(), clearReauth: vi.fn(), revoke: vi.fn(), health: vi.fn(), lookup: vi.fn(), exchangeOAuthCode: vi.fn(),
    addDelegationSubject: vi.fn(), removeDelegationSubject: vi.fn(), listDelegationSubjects: vi.fn(),
  }
  const env = {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    WORKFLOW_CACHE: {},
    SECRET_ENCRYPTION_KEY: KEY,
    OPS_CONNECTIONS: rpcStub(ops),
    IDEMPOTENCY: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v) } },
    ...over,
  } as unknown as Env
  return { env, ops }
}

async function call(env: Env, method: string, path: string, body?: unknown) {
  return api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, recordingContext())
}

interface Answer { error?: string; message?: string; outcome?: string; connection?: { id: string; acts_as: string | null }; [k: string]: unknown }

beforeEach(() => {
  vi.clearAllMocks()
  kv = new Map()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Reconnect the Slack alerts login with a new bot token', () => {
  it('checks the token with Slack, then saves it sealed onto the alert row, keeping the channel and every switch', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env, ops } = makeEnv()
    // The copy as the database probe last wrote it, holding the old token (an edit changes an existing copy, never makes one).
    await rememberSlackConnections(env.IDEMPOTENCY as never, KEY, new Map([[ORG, parseSlackConnection({ bot_token: OLD_TOKEN, default_channel: '#bidspoke-alerts' })!]]), Date.parse('2026-10-21T00:00:00Z'))

    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    const body = (await res.json()) as Answer
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ outcome: 'reconnected', connection: { id: ALERT_ROW, acts_as: 'bidspoke in Pennie HQ' } })
    expect(asked).toEqual([NEW_TOKEN])

    // One write, onto the org's one alert row, through the same token save the Slack save uses.
    expect(db.tokenSaves).toHaveLength(1)
    const [sent] = db.tokenSaves
    expect(sent).toMatchObject({ p_organization_id: ORG, p_actor: USER })
    expect(await decryptSecret(sent.p_credential_enc as string, KEY)).toBe(NEW_TOKEN)
    // Only the workspace Slack named is sent (#2643): the channel and the switches are not sent back as read.
    expect(sent.p_config).toEqual({ workspace_name: 'Pennie HQ' })
    // #2331's contract release: the token lives only in credential_enc, never in what is sent as config.
    expect(JSON.stringify(sent.p_config)).not.toContain(NEW_TOKEN)
    expect(JSON.stringify(sent.p_config)).not.toContain(OLD_TOKEN)
    // So the row keeps the channel and the switch already turned off, with the workspace Slack named.
    const [row] = db.table
    expect(row).toMatchObject({ sealed_for: 'bidding_ring', updated_by: USER })
    expect(row.config).toMatchObject({ default_channel: '#bidspoke-alerts', volume_alerts_enabled: false, workspace_name: 'Pennie HQ' })

    // The saved Slack copy posts with the new token while the database is down (#2060).
    const copy = await readSlackCopy(env.IDEMPOTENCY as never, KEY)
    expect(copy.kind === 'read' ? copy.connections.get(ORG)?.bot_token : null).toBe(NEW_TOKEN)

    // Ops never holds this login, so it is asked nothing; the new token is never in the answer.
    expect(ops.verify).not.toHaveBeenCalled()
    expect(ops.clearReauth).not.toHaveBeenCalled()
    expect(JSON.stringify(body)).not.toContain(NEW_TOKEN)
  })

  it('the legacy unsealed row production holds (sealed_for null, no credential_enc) is reconnected and sealed by the same save', async () => {
    const db = await storeDouble()
    Object.assign(db.table[0], { sealed_for: null, credential_enc: null })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(200)
    expect(db.table[0]).toMatchObject({ sealed_for: 'bidding_ring', config: { default_channel: '#bidspoke-alerts', volume_alerts_enabled: false } })
    expect(await decryptSecret(db.table[0].credential_enc as string, KEY)).toBe(NEW_TOKEN)
  })

  it('a token Slack refuses is answered in a plain sentence with Slack\'s code, and nothing is saved', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: REFUSED_TOKEN } })
    expect(res.status).toBe(422)
    expect((await res.json()) as Answer).toMatchObject({ error: 'slack_token_refused', message: 'Slack did not accept this token (invalid_auth). Nothing was saved. Check the token in the Slack app and save again.' })
    expect(db.tokenSaves).toEqual([])
  })

  it('Slack not answering is not called a refused token: its own sentence, and nothing is saved', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(() => { throw new TypeError('fetch failed') })
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(503)
    expect((await res.json()) as Answer).toMatchObject({ error: 'slack_unanswered', message: 'Slack did not answer when Bidspoke asked about the token. Nothing was changed. Try again in a minute.' })
    expect(db.tokenSaves).toEqual([])
  })

  it('a field the Slack alerts login does not have, or a blank token, is refused before Slack is asked', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const extra = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN, client_secret: 'x' } })
    expect(extra.status).toBe(422)
    expect(((await extra.json()) as Answer).error).toBe('connection_fields_undeclared')
    const blank = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: '   ' } })
    expect(blank.status).toBe(422)
    expect((await blank.json()) as Answer).toMatchObject({ error: 'connection_fields_missing', message: 'Bot token is empty. Nothing was saved. Fill it in and save again.' })
    expect(asked).toEqual([])
    expect(db.tokenSaves).toEqual([])
  })

  it('a save the database refuses is answered as not stored, and the copy is left as it was', async () => {
    const db = await storeDouble({ saveError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('connection_store_failed')
    expect(kv.size).toBe(0)
  })

  it('with no key ring the token cannot be sealed: refused by name, and nothing is written', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv({ SECRET_ENCRYPTION_KEY: undefined })
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(500)
    expect(((await res.json()) as Answer).error).toBe('connection_seal_failed')
    expect(db.tokenSaves).toEqual([])
  })
})

describe('Reconnect the Slack alerts login with no new token: the stored one is checked again', () => {
  it('asks Slack about the stored token, writes nothing, and audits who asked', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, {})
    expect(res.status).toBe(200)
    expect((await res.json()) as Answer).toMatchObject({ outcome: 'checked', connection: { id: ALERT_ROW, acts_as: 'bidspoke in Pennie HQ' } })
    expect(asked).toEqual([OLD_TOKEN])
    expect(db.tokenSaves).toEqual([])
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(db, ORG, 'service_connection', ALERT_ROW, 'connection_rechecked', USER, {})
  })

  it('with no key ring there is never an unhandled error: the row is named unreadable, even with a plaintext beside it, and Slack is not asked', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env } = makeEnv({ SECRET_ENCRYPTION_KEY: undefined })
    // The row still carries config.bot_token, as production does until the strip migration: it is never read (#2331).
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, {})
    expect(res.status).toBe(422)
    expect(((await res.json()) as Answer).error).toBe('reconnect_login_unreadable')
    expect(asked).toEqual([])
  })

  it('a stored token Slack now refuses says so, and says to reconnect with a new one', async () => {
    const db = await storeDouble()
    db.table[0].config = { default_channel: '#bidspoke-alerts' }
    db.table[0].credential_enc = await encryptSecret(REFUSED_TOKEN, KEY)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, {})
    expect(res.status).toBe(422)
    expect((await res.json()) as Answer).toMatchObject({
      error: 'slack_stored_token_refused',
      message: 'Slack no longer accepts the saved token (invalid_auth). Nothing was changed. Reconnect with a new token from the Slack app.',
    })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #2331's contract release: the plaintext is never read, so a row that was
// never sealed is no usable login. Checking it again neither asks Slack about
// its plaintext nor seals it; the fix is a Reconnect with a new token.
describe('a row that was never sealed, after the contract release', () => {
  it('is named unreadable on a check, Slack is not asked, and nothing is written', async () => {
    const db = await storeDouble({ table: unsealedRows() })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, {})
    expect(res.status).toBe(422)
    expect(((await res.json()) as Answer).error).toBe('reconnect_login_unreadable')
    expect(asked).toEqual([])
    expect(db.updates).toEqual([])
    expect(db.tokenSaves).toEqual([])
  })

  // The save sends no plaintext, old or new: since #2643 it sends only the workspace name, and the
  // database's CHECK service_connections_no_plaintext_token keeps any token out of config
  // (supabase/tests/service_connections_no_plaintext.test.sql).
  it('is sealed by a Reconnect with a new token, which never sends a plaintext', async () => {
    const db = await storeDouble({ table: unsealedRows() })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(200)
    const [row] = db.table
    expect(row.sealed_for).toBe('bidding_ring')
    expect(await decryptSecret(row.credential_enc as string, KEY)).toBe(NEW_TOKEN)
    expect(db.tokenSaves).toHaveLength(1)
    expect(db.tokenSaves[0].p_config).toEqual({ workspace_name: 'Pennie HQ' })
  })
})

describe('what stays refused, and whose row it is', () => {
  it('Remove stays refused for the Slack alerts login, in a sentence that names no retired page', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, ops } = makeEnv()
    const res = await call(env, 'DELETE', `/connections/${ALERT_ROW}`)
    expect(res.status).toBe(422)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('connection_not_removable')
    expect(body.message).not.toMatch(/Integrations/)
    expect(ops.revoke).not.toHaveBeenCalled()
    expect(db.table.find((r) => r.id === ALERT_ROW)).toBeDefined()
  })

  it('another organization\'s alert row is no such connection, and neither Slack nor the database write is reached', async () => {
    const db = await storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = slackAuthTest(slackAccepts)
    const { env } = makeEnv()
    const res = await call(env, 'POST', `/connections/${THEIR_ALERT_ROW}/reconnect`, { fields: { bot_token: NEW_TOKEN } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as Answer).error).toBe('connection_not_found')
    expect(asked).toEqual([])
    expect(db.tokenSaves).toEqual([])
  })
})
