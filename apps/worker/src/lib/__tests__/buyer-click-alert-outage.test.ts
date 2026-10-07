/**
 * The click page's Slack lookup in a database outage (#1849).
 *
 * productionClickAlert looked the org's Slack connection up through
 * getSlackConnection: on a lead's client one request with no deadline, so in the
 * outage drill's hung database each page waited out the node's whole alert
 * deadline (5 s) before going quiet. It now reads through leadRead, so it is
 * bounded, answers at once when the lead already knows the database is down,
 * and pages from the last-good copy of the Slack connections either way.
 *
 * The real supabase-js client runs throughout; only the network beneath it is
 * replaced. Slack's own address is answered by a stubbed global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { productionClickAlert, type ClickAlert } from '../buyer-click-alert'
import { createLeadSupabaseClient, noteLeadWriteUnanswered } from '../lead-read-budget'
import { SLACK_CONNS_LASTGOOD_KEY } from '../volume-cliff'
import { encryptSecret } from '../secret-crypto'

const KEY = btoa('2'.repeat(32))
const dbEnv = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const page: ClickAlert = {
  kind: 'page', reason: 'outcome_unknown', partner_id: 'p-1', partner_slug: 'liberty1', prospect_id: 'a0B000000000001', detail: 'http 503',
  hold_recorded: 'outcome_unknown', workflow_id: 'wf-1', trace_id: 'trace-1', at: Date.UTC(2027, 8, 20, 18),
}

/** A database whose every request ends only when its signal aborts: the drill's hung shape (#1851). */
function hungDatabase() {
  const state = { calls: 0 }
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  }) as typeof globalThis.fetch
  return { state, fetch }
}

let slackPosts: string[]
beforeEach(() => {
  slackPosts = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    slackPosts.push(new Headers(init?.headers).get('Authorization') ?? '')
    return new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function envWithCopy(): Promise<Env> {
  const blob = await encryptSecret(JSON.stringify({ 'org-1': { bot_token: 'xoxb-copy', default_channel: 'C-COPY' } }), KEY)
  const kv = { get: async (k: string) => (k === SLACK_CONNS_LASTGOOD_KEY ? blob : null) }
  return { IDEMPOTENCY: kv, SECRET_ENCRYPTION_KEY: KEY, APP_URL: 'https://app.test' } as unknown as Env
}

describe('the click page in a database outage (#1849)', () => {
  it('after the lead has seen the database not answer, pages from the last-good copy without asking it', async () => {
    const db = hungDatabase()
    const supabase = createLeadSupabaseClient(dbEnv, { fetch: db.fetch })
    noteLeadWriteUnanswered(supabase, 'held click record')
    const outcome = await productionClickAlert('org-1', await envWithCopy(), supabase)(page)
    expect(outcome).toBe('posted')
    expect(db.state.calls).toBe(0)
    expect(slackPosts).toEqual(['Bearer xoxb-copy'])
  })

  it('a first lookup that hangs is ended by the lead read deadline and pages from the copy', async () => {
    const db = hungDatabase()
    // The deadline fires at once, standing in for the time passing.
    const supabase = createLeadSupabaseClient(dbEnv, { fetch: db.fetch, deadline: () => AbortSignal.abort() })
    const outcome = await productionClickAlert('org-1', await envWithCopy(), supabase)(page)
    expect(outcome).toBe('posted')
    expect(db.state.calls).toBe(1)
    expect(slackPosts).toEqual(['Bearer xoxb-copy'])
  })
})
