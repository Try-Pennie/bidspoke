/**
 * POST /slack/resolve and the save's token check, through the Slack client
 * (#2331 phase 1b, #1689 D3).
 *
 * Who may call these: any signed in user of the organization (jwtAuth).
 * /slack/resolve touches no stored data: it asks Slack about the token it is
 * given. POST /slack writes only the caller's organization's Slack alert row.
 *
 * /slack/resolve made two hand written fetches (auth.test, then the first
 * conversations.list) and read each body as the answer whatever its status,
 * throwing (the generic 500) when there was no answer or the body was not
 * JSON. These pin that, answer by answer, and the switch to createSlackClient
 * keeps it (F123: whether the route throws does not change). A 429 is never
 * waited for.
 *
 * POST /slack used to store whatever token it was given. It now asks Slack
 * (auth.test) first and refuses a token Slack rejects with the named error
 * slack_token_invalid, writing nothing; when Slack cannot be asked it writes
 * nothing either, through the generic 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const ORG = 'org-2331'
const testUser = { id: 'user-2331', organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-2331', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const env = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  IDEMPOTENCY: { get: async () => null, put: async () => {} },
  SECRET_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
} as unknown as Env

const TOKEN = 'test-bot-token-2331'
const NETWORK = new TypeError('fetch failed')

type Answer = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> } | 'network'

/** A Slack double answering each call in turn (the last repeating), recording the method, URL, token and form fields. */
function slack(answers: Answer[]) {
  const calls: Array<{ method: string; url: string; token: string | null; fields: Record<string, string> }> = []
  let i = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const text = request.method === 'GET' ? '' : await request.clone().text()
    const fields = Object.fromEntries(new URL(request.url).searchParams)
    if (text && (request.headers.get('Content-Type') ?? '').includes('x-www-form-urlencoded')) Object.assign(fields, Object.fromEntries(new URLSearchParams(text)))
    calls.push({ method: request.method, url: request.url.split('?')[0], token: request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? null, fields })
    const answer = answers[Math.min(i, answers.length - 1)]
    i++
    if (answer === 'network') throw NETWORK
    const body = answer.raw ?? JSON.stringify(answer.body ?? {})
    return new Response(body, { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

/** The routes as production mounts them: a thrown error reaches the root's handler, recorded here, which answers the generic 500. */
async function app() {
  const { default: api } = await import('../index')
  const thrown: unknown[] = []
  const root = new Hono<{ Bindings: Env }>()
  root.onError((err, c) => {
    thrown.push(err)
    return c.json({ error: 'Internal server error' }, 500)
  })
  root.route('/', api)
  const call = (method: string, path: string, body?: unknown) =>
    root.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env, recordingContext())
  return { call, thrown }
}

let supabase: ReturnType<typeof makeSupabase>
let timers: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  supabase = makeSupabase({
    users: { single: testUser },
    service_connections: { upsertResult: { id: 'sc-1' }, writeRows: [{ id: 'sc-1' }] },
  })
  vi.mocked(createSupabaseClient).mockReturnValue(supabase as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  timers = vi.spyOn(globalThis, 'setTimeout')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const CHANNELS = { ok: true, channels: [{ id: 'C2', name: 'zeta' }, { id: 'C1', name: 'alerts' }] }

describe('POST /slack/resolve: auth.test', () => {
  it('answers the workspace and the sorted channels on success, with the token on both calls', async () => {
    const { calls } = slack([{ body: { ok: true, team: 'Pennie' } }, { body: CHANNELS }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: `  ${TOKEN} ` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace_name: 'Pennie', channels: [{ id: 'C1', name: 'alerts' }, { id: 'C2', name: 'zeta' }] })
    expect(calls.map((c) => c.url)).toEqual(['https://slack.com/api/auth.test', 'https://slack.com/api/conversations.list'])
    expect(calls.map((c) => c.token)).toEqual([TOKEN, TOKEN])
    expect(calls[1].fields).toMatchObject({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000' })
  })

  it('a token Slack refuses (ok:false with a code) answers 400 Invalid token: <code>, and lists no channels', async () => {
    const { calls } = slack([{ body: { ok: false, error: 'invalid_auth' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid token: invalid_auth' })
    expect(calls).toHaveLength(1)
  })

  it('ok:false with no code answers 400 Invalid token: auth.test failed', async () => {
    slack([{ body: { ok: false } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid token: auth.test failed' })
  })

  it('a 429 answers from its body (400 Invalid token: ratelimited), in one request and with no wait', async () => {
    const { calls } = slack([{ status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'Retry-After': '30' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid token: ratelimited' })
    expect(calls).toHaveLength(1)
    expect(timers).not.toHaveBeenCalledWith(expect.anything(), 30_000)
  })

  it('a 500 whose body is not JSON throws, so the generic 500 answers', async () => {
    slack([{ status: 500, raw: '<html>upstream error</html>' }])
    const { call, thrown } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(thrown[0]).toBeInstanceOf(SyntaxError)
  })

  it('no answer (a network failure) throws the fetch error itself, so the generic 500 answers', async () => {
    slack(['network'])
    const { call, thrown } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(500)
    expect(thrown).toEqual([NETWORK])
  })
})

describe('POST /slack/resolve: the first conversations.list', () => {
  it('ok:false lists no channels and still answers the workspace', async () => {
    slack([{ body: { ok: true, team: 'Pennie' } }, { body: { ok: false, error: 'missing_scope' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace_name: 'Pennie', channels: [] })
  })

  it('a 429 lists no channels, in one request and with no wait', async () => {
    const { calls } = slack([{ body: { ok: true, team: 'Pennie' } }, { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'Retry-After': '30' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace_name: 'Pennie', channels: [] })
    expect(calls).toHaveLength(2)
    expect(timers).not.toHaveBeenCalledWith(expect.anything(), 30_000)
  })

  it('a 500 whose body is not JSON throws, so the generic 500 answers', async () => {
    slack([{ body: { ok: true, team: 'Pennie' } }, { status: 500, raw: 'oops' }])
    const { call, thrown } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(500)
    expect(thrown[0]).toBeInstanceOf(SyntaxError)
  })

  it('no answer throws the fetch error itself, so the generic 500 answers', async () => {
    slack([{ body: { ok: true, team: 'Pennie' } }, 'network'])
    const { call, thrown } = await app()
    const res = await call('POST', '/integrations/slack/resolve', { bot_token: TOKEN })
    expect(res.status).toBe(500)
    expect(thrown).toEqual([NETWORK])
  })
})

describe('POST /slack verifies the token before sealing (slack_token_invalid)', () => {
  const save = { bot_token: TOKEN, default_channel: '#alerts', workspace_name: 'Pennie' }
  const upserts = () => (supabase.calls.service_connections ?? []).filter(([m]) => m === 'upsert')

  it('saves a token auth.test accepts, asking Slack once with that token', async () => {
    const { calls } = slack([{ body: { ok: true, team: 'Pennie' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack', save)
    expect(res.status).toBe(200)
    expect(calls.map((c) => [c.url, c.token])).toEqual([['https://slack.com/api/auth.test', TOKEN]])
    expect(upserts()).toHaveLength(1)
  })

  it('refuses a token Slack rejects with slack_token_invalid and writes nothing', async () => {
    slack([{ body: { ok: false, error: 'token_revoked' } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack', save)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'slack_token_invalid', slack_error: 'token_revoked' })
    expect(upserts()).toEqual([])
  })

  it('refuses ok:false with no code the same way', async () => {
    slack([{ body: { ok: false } }])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack', save)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'slack_token_invalid', slack_error: null })
    expect(upserts()).toEqual([])
  })

  it.each<[string, Answer]>([
    ['a 429', { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'Retry-After': '30' } }],
    ['a 500', { status: 500, raw: '<html>down</html>' }],
    ['no answer', 'network'],
  ])('writes nothing when Slack cannot be asked (%s): the generic 500, never a token judged invalid', async (_what, answer) => {
    const { calls } = slack([answer])
    const { call } = await app()
    const res = await call('POST', '/integrations/slack', save)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(upserts()).toEqual([])
    expect(calls).toHaveLength(1)
    expect(timers).not.toHaveBeenCalledWith(expect.anything(), 30_000)
  })
})
