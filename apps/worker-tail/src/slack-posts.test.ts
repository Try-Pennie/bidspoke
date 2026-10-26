/**
 * The tail worker keeps one row per Slack post of the bidding Worker (#2364).
 *
 * deliverMessage and sendThreadReply log one `[slack] post outcome` line per
 * post. Nothing read those lines, so 3,400 refused alert posts from 2026-10-23
 * to 26 paged nobody. This copies each into slack_post_outcomes, the record the
 * minute refusal check reads, through the same retrying copier as the cron
 * records: a line written twice is one row, the ops Worker's traces are
 * skipped, and a line that does not parse is dropped on its own rather than
 * holding back the batch it came in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createSlackPostCopier, slackPostsIn } from './slack-posts'
import { DELIVERY_HELD_CAP, SLACK_POST_HELD_CAP } from './copier-caps'
import worker, { OPS_WORKER_SCRIPT } from './index'

const AT = Date.parse('2026-10-23T03:00:00.000Z')
const env = { SUPABASE_URL: 'https://bidding.test', SUPABASE_SECRET_KEY: 'test-key' }
const ctx = {} as ExecutionContext
const supabase = () => createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const PREFIX = '[slack] post outcome '

function line(fields: Record<string, unknown> = {}): string {
  return `${PREFIX}${JSON.stringify({
    post_id: '0192f3a4-0000-7000-8000-000000000001',
    outcome: 'refused',
    reason: 'not_in_channel',
    status: 200,
    kind: 'destination',
    channel: 'C0STATUS',
    retry_after: null,
    title: 'Workflow Execution Failed',
    ...fields,
  })}`
}

function trace(opts: { script?: string | null; messages?: unknown[] } = {}): TraceItem {
  return {
    scriptName: opts.script === undefined ? 'bidspoke-worker' : opts.script,
    outcome: 'ok',
    eventTimestamp: AT,
    event: { request: { url: 'https://api.trypennie.dev/webhook' } },
    logs: (opts.messages ?? []).map((message, i) => ({ timestamp: AT + i, level: 'log', message })),
  } as unknown as TraceItem
}

describe('slackPostsIn', () => {
  it('copies a refused post with its reason, kind, status, channel and title, timed by its log line', () => {
    expect(slackPostsIn(trace({ messages: [['something else'], [line()]] }))).toEqual([{
      post_id: '0192f3a4-0000-7000-8000-000000000001',
      occurred_at: new Date(AT + 1).toISOString(),
      channel: 'C0STATUS',
      outcome: 'refused',
      reason: 'not_in_channel',
      kind: 'destination',
      status: 200,
      title: 'Workflow Execution Failed',
    }])
  })

  it('copies a delivered post and a post with no answer, from a bare string as well as an argument list', () => {
    const rows = slackPostsIn(trace({ messages: [
      line({ post_id: 'p-1', outcome: 'delivered', reason: null, kind: null }),
      [line({ post_id: 'p-2', outcome: 'no_answer', reason: null, status: null, kind: 'transient' })],
    ] }))
    expect(rows.map((r) => [r.post_id, r.outcome, r.kind])).toEqual([['p-1', 'delivered', null], ['p-2', 'no_answer', 'transient']])
  })

  it('skips the ops Worker\'s traces', () => {
    expect(slackPostsIn(trace({ script: OPS_WORKER_SCRIPT, messages: [[line()]] }))).toEqual([])
  })

  it('drops each malformed line on its own and keeps the good ones beside it', () => {
    const rows = slackPostsIn(trace({ messages: [
      [`${PREFIX}{not json`],
      [line({ post_id: 'bad-outcome', outcome: 'exploded' })],
      [line({ post_id: 'bad-kind', kind: 'whatever' })],
      [line({ post_id: '' })],
      [line({ post_id: 'x'.repeat(101) })],
      [line({ post_id: 'no-channel', channel: '' })],
      [line({ post_id: 'long-title', title: 't'.repeat(201) })],
      [line({ post_id: 'odd-status', status: 'teapot' })],
      [line({ post_id: 'delivered-with-kind', outcome: 'delivered', kind: 'destination' })],
      [line({ post_id: 'refused-without-kind', kind: null })],
      [line({ post_id: 'good' })],
    ] }))
    expect(rows.map((r) => r.post_id)).toEqual(['good'])
  })
})

let posted: Array<{ url: string; prefer: string | null; body: unknown }>
let failures: number

beforeEach(() => {
  posted = []
  failures = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url.includes('/slack_post_outcomes')) {
      if (failures > 0) {
        failures--
        return Promise.resolve(Response.json({ message: 'upstream connect error' }, { status: 503 }))
      }
      const headers = new Headers(init?.headers)
      posted.push({ url, prefer: headers.get('Prefer'), body: JSON.parse(init?.body as string) })
      return Promise.resolve(new Response(null, { status: 201 }))
    }
    return Promise.resolve(new Response(null, { status: 201 }))
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('createSlackPostCopier', () => {
  it('upserts by post id ignoring a row already there, so one post sent twice is one row', async () => {
    const c = createSlackPostCopier({ sleep: () => Promise.resolve(), error: () => {}, log: () => {} })
    const rows = slackPostsIn(trace({ messages: [[line()]] }))
    await c.copy(supabase(), [...rows, ...rows])
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain('on_conflict=post_id')
    expect(posted[0].prefer).toContain('resolution=ignore-duplicates')
    expect((posted[0].body as unknown[]).length).toBe(1)
  })

  it('holds what the database refuses and writes it with the next batch', async () => {
    failures = Infinity
    const errors: string[] = []
    const c = createSlackPostCopier({ sleep: () => Promise.resolve(), error: (l) => { errors.push(l) }, log: () => {} })
    await c.copy(supabase(), slackPostsIn(trace({ messages: [[line()]] })))
    expect(c.held()).toHaveLength(1)
    expect(errors.join('\n')).toMatch(/could not copy 1 Slack post outcome .*held/)
    failures = 0
    await c.copy(supabase(), [])
    expect(c.held()).toEqual([])
  })

  // The outage this record exists for ran at about 1,130 refused posts a day;
  // its cap holds several days of that, and stays below the delivery record's.
  it('has its own cap, sized for days of the measured refusal rate', () => {
    expect(SLACK_POST_HELD_CAP).toBeGreaterThanOrEqual(4 * 1_130)
    expect(SLACK_POST_HELD_CAP).toBeLessThanOrEqual(DELIVERY_HELD_CAP)
  })
})

describe('the tail handler copies Slack post outcomes', () => {
  it('copies the bidding Worker\'s lines and none of the ops Worker\'s, beside a malformed one', async () => {
    await worker.tail([
      trace({ script: OPS_WORKER_SCRIPT, messages: [[line({ post_id: 'ops-p' })]] }),
      trace({ messages: [[`${PREFIX}{broken`], [line({ post_id: 'p-9' })]] }),
      trace({ messages: [[line({ post_id: 'p-10', outcome: 'delivered', reason: null, kind: null })]] }),
    ], env, ctx)
    const ids = posted.flatMap((p) => p.body as Array<{ post_id: string }>).map((r) => r.post_id)
    expect(ids).toEqual(['p-9', 'p-10'])
  })
})
