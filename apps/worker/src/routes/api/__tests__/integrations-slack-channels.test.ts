/**
 * GET /slack/channels through the Slack client (#2331 phase 1b, #1689 D3).
 *
 * Who may call it: any signed in user of the organization (jwtAuth). Whose
 * data: it reads the caller's organization's Slack alert row for its token and
 * asks Slack for that workspace's channels; it writes nothing.
 *
 * The route paged conversations.list with a hand written fetch, reading each
 * body as the answer whatever its status: ok:false (and a 429 or 5xx carrying
 * Slack's JSON) answered 502 `Slack API error: <code>`, a body that was not
 * JSON or no answer at all threw to the generic 500. These pin that, answer by
 * answer, and the switch to createSlackClient keeps it (F123). A 429 is never
 * waited for.
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

const TOKEN = 'test-bot-token-channels'
const NETWORK = new TypeError('fetch failed')

type Answer = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> } | 'network'

/** A Slack double answering each call in turn (the last repeating), recording the URL, token and parameters. */
function slack(answers: Answer[]) {
  const calls: Array<{ method: string; url: string; token: string | null; fields: Record<string, string> }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  }))
  return { calls }
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
  const get = (q: string) =>
    root.request(`/integrations/slack/channels?q=${encodeURIComponent(q)}`, { method: 'GET', headers: { Authorization: 'Bearer jwt' } }, env, recordingContext())
  return { get, thrown }
}

let timers: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({
    users: { single: testUser },
    service_connections: { list: [{ config: { bot_token: TOKEN, default_channel: '#alerts' }, credential_enc: null }] },
  }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  timers = vi.spyOn(globalThis, 'setTimeout')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const page = (names: string[], next?: string) => ({
  body: { ok: true, channels: names.map((name, n) => ({ id: `C-${name}-${n}`, name })), response_metadata: { next_cursor: next ?? '' } },
})

describe('GET /slack/channels', () => {
  it('pages with the cursor, filters by name, sorts, and asks with the alert row token', async () => {
    const { calls } = slack([page(['zeta-alerts', 'general'], 'cur-2'), page(['alerts-main', 'random'])])
    const { get } = await app()
    const res = await get('ALERTS')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ channels: [{ id: 'C-alerts-main-0', name: 'alerts-main' }, { id: 'C-zeta-alerts-0', name: 'zeta-alerts' }] })
    expect(calls.map((c) => c.url)).toEqual(['https://slack.com/api/conversations.list', 'https://slack.com/api/conversations.list'])
    expect(calls.every((c) => c.token === TOKEN)).toBe(true)
    // Through createSlackClient, which posts form encoded parameters, not the hand written GET (#2331).
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST'])
    expect(calls[0].fields).toMatchObject({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000' })
    expect(calls[0].fields.cursor).toBeUndefined()
    expect(calls[1].fields.cursor).toBe('cur-2')
  })

  it('stops at 50 matches', async () => {
    const { calls } = slack([page(Array.from({ length: 60 }, (_, n) => `alerts-${String(n).padStart(2, '0')}`), 'more')])
    const { get } = await app()
    const body = await (await get('alerts')).json() as { channels: unknown[] }
    expect(body.channels).toHaveLength(50)
    expect(calls).toHaveLength(1)
  })

  it('asks no Slack for a query under 3 characters', async () => {
    const { calls } = slack([page(['alerts'])])
    const { get } = await app()
    expect(await (await get('al')).json()).toEqual({ channels: [] })
    expect(calls).toHaveLength(0)
  })

  it('ok:false answers 502 Slack API error: <code>', async () => {
    slack([{ body: { ok: false, error: 'missing_scope' } }])
    const { get } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Slack API error: missing_scope' })
  })

  it('ok:false with no code answers 502 Slack API error: unknown', async () => {
    slack([{ body: { ok: false } }])
    const { get } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Slack API error: unknown' })
  })

  it('ok:false on a later page answers 502 too', async () => {
    slack([page(['alerts-a'], 'cur-2'), { body: { ok: false, error: 'invalid_cursor' } }])
    const { get } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Slack API error: invalid_cursor' })
  })

  it('a 429 answers from its body (502 Slack API error: ratelimited), in one request and with no wait', async () => {
    const { calls } = slack([{ status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'Retry-After': '30' } }])
    const { get } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Slack API error: ratelimited' })
    expect(calls).toHaveLength(1)
    expect(timers).not.toHaveBeenCalledWith(expect.anything(), 30_000)
  })

  it('a 500 whose body is not JSON throws, so the generic 500 answers', async () => {
    slack([{ status: 500, raw: '<html>upstream error</html>' }])
    const { get, thrown } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    expect(thrown[0]).toBeInstanceOf(SyntaxError)
  })

  it('no answer throws the fetch error itself, so the generic 500 answers', async () => {
    slack(['network'])
    const { get, thrown } = await app()
    const res = await get('alerts')
    expect(res.status).toBe(500)
    expect(thrown).toEqual([NETWORK])
  })
})
