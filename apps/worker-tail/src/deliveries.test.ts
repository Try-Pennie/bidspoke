/**
 * The tail worker keeps one row per cron delivery (#2284).
 *
 * The hourly cron guard check pages when a tick may really have run twice: two
 * deliveries of one tick both ran its jobs. Neither the guard's skip count nor a
 * Workers Logs search can show that (a second delivery that ran leaves no skip,
 * and searches miss lines). So every scheduled invocation of the bidding Worker
 * becomes a row in cron_tick_deliveries, saying what the guard decided for it and
 * how the invocation ended, copied by the same retrying copier as the fail-opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDeliveryCopier, deliveriesIn } from './deliveries'
import { DELIVERY_HELD_CAP, FAIL_OPEN_HELD_CAP } from './copier-caps'
import worker, { OPS_WORKER_SCRIPT } from './index'

const SCHEDULED = Date.parse('2026-10-17T15:15:32.618Z')
const env = { SUPABASE_URL: 'https://bidding.test', SUPABASE_SECRET_KEY: 'test-key' }
const ctx = {} as ExecutionContext
const supabase = () => createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const line = (delivery: string, outcome: string, cron = '*/5 * * * *', scheduled = SCHEDULED) =>
  `[cron-once] delivery ${JSON.stringify({ delivery, outcome, cron, scheduled: new Date(scheduled).toISOString() })}`

function trace(opts: { script?: string | null; messages?: unknown[]; outcome?: string; event?: unknown } = {}): TraceItem {
  return {
    scriptName: opts.script === undefined ? 'bidspoke-worker' : opts.script,
    outcome: opts.outcome ?? 'ok',
    eventTimestamp: SCHEDULED + 3_000,
    event: opts.event === undefined ? { cron: '*/5 * * * *', scheduledTime: SCHEDULED } : opts.event,
    logs: (opts.messages ?? []).map((message, i) => ({ timestamp: SCHEDULED + 3_480 + i, level: 'log', message })),
  } as unknown as TraceItem
}

describe('deliveriesIn', () => {
  it('reads the guard\'s delivery line, with how the invocation ended', () => {
    expect(deliveriesIn(trace({ messages: [['[cron-once] running cron="*/5 * * * *"'], [line('d-1', 'ran')]], outcome: 'canceled' }))).toEqual([{
      delivery_id: 'd-1',
      occurred_at: new Date(SCHEDULED + 3_481).toISOString(),
      cron: '*/5 * * * *',
      scheduled_at: new Date(SCHEDULED).toISOString(),
      outcome: 'ran',
      invocation_outcome: 'canceled',
    }])
  })

  it('reads a line handed over as a bare string as well as an argument list', () => {
    expect(deliveriesIn(trace({ messages: [line('d-1', 'failed_open')] }))[0]).toMatchObject({ delivery_id: 'd-1', outcome: 'failed_open' })
  })

  // A delivery the guard never decided for (killed while asking, or a line that
  // changed shape) is still a delivery, so it is recorded rather than lost, and
  // the hourly check can see a record with no decisions in it.
  it('records a scheduled invocation with no delivery line as no_decision, named by its own times', () => {
    const rows = deliveriesIn(trace({ messages: [['something else']], outcome: 'exceededCpu' }))
    expect(rows).toEqual([{
      delivery_id: `trace:${SCHEDULED}:${SCHEDULED + 3_000}:*/5 * * * *`,
      occurred_at: new Date(SCHEDULED + 3_000).toISOString(),
      cron: '*/5 * * * *',
      scheduled_at: new Date(SCHEDULED).toISOString(),
      outcome: 'no_decision',
      invocation_outcome: 'exceededCpu',
    }])
  })

  it('ignores the ops Worker, a request trace, an unknown outcome and a malformed line', () => {
    expect(deliveriesIn(trace({ script: OPS_WORKER_SCRIPT, messages: [[line('d-1', 'ran')]] }))).toEqual([])
    expect(deliveriesIn(trace({ event: { request: { url: 'https://x' } }, messages: [[line('d-1', 'ran')]] }))).toEqual([])
    const odd = deliveriesIn(trace({ messages: [[line('d-1', 'exploded')], ['[cron-once] delivery {not json']] }))
    expect(odd.map((r) => r.outcome)).toEqual(['no_decision'])
    // An id the table would refuse would hold back every row batched with it.
    expect(deliveriesIn(trace({ messages: [[line('a'.repeat(201), 'ran')]] })).map((r) => r.outcome)).toEqual(['no_decision'])
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
    if (method === 'POST' && url.includes('/cron_tick_deliveries')) {
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

describe('createDeliveryCopier', () => {
  it('upserts by delivery id, ignoring a row already there, and holds what the database refuses', async () => {
    failures = Infinity
    const errors: string[] = []
    const c = createDeliveryCopier({ sleep: () => Promise.resolve(), error: (l) => { errors.push(l) }, log: () => {} })
    const rows = deliveriesIn(trace({ messages: [[line('d-1', 'ran')]] }))
    await c.copy(supabase(), rows)
    expect(c.held().map((r) => r.delivery_id)).toEqual(['d-1'])
    expect(errors.join('\n')).toMatch(/could not copy 1 cron tick delivery .*upstream connect error.*held/)
    failures = 0
    await c.copy(supabase(), [])
    expect(posted[0].url).toContain('on_conflict=delivery_id')
    expect(posted[0].prefer).toContain('resolution=ignore-duplicates')
    expect(c.held()).toEqual([])
  })
})

// Lessons review on #2284: the delivery copier shared the fail-open copier's
// 2,000 row cap, which a day long database outage overruns (about 1,900
// deliveries a day, twice that while Cloudflare doubles ticks). Its cap is
// sized from the real crons, and an overflow says how many it dropped.
describe('the delivery copier\'s own cap', () => {
  // The cap against the real crons is held in
  // apps/web/src/lib/__tests__/tail-copier-caps.test.ts, which can read
  // the bidding Worker's wrangler.toml; this app's tests run on Workers types only.
  it('is its own, larger than the fail-open copier\'s', () => {
    expect(DELIVERY_HELD_CAP).toBeGreaterThan(FAIL_OPEN_HELD_CAP)
  })

  it('past its cap drops the oldest, and says how many and since when, never silently', async () => {
    failures = Infinity
    const errors: string[] = []
    const c = createDeliveryCopier({ sleep: () => Promise.resolve(), error: (l) => { errors.push(l) }, log: () => {}, maxHeld: 3 })
    const rows = Array.from({ length: 5 }, (_, i) => deliveriesIn(trace({ messages: [[line(`d-${i}`, 'ran')]] }))[0])
    await c.copy(supabase(), rows)
    expect(c.held().map((r) => r.delivery_id)).toEqual(['d-2', 'd-3', 'd-4'])
    const dropped = errors.find((e) => e.includes('dropped'))!
    expect(dropped).toMatch(/dropped 2 held cron tick deliveries, the oldest delivery=d-0 /)
    expect(dropped).toMatch(/3 already held/)
    expect(dropped).toMatch(/2 dropped by this isolate so far/)
    await c.copy(supabase(), [deliveriesIn(trace({ messages: [[line('d-5', 'ran')]] }))[0]])
    expect(errors.filter((e) => e.includes('dropped')).at(-1)).toMatch(/dropped 1 held cron tick delivery, .*3 dropped by this isolate so far/)
  })
})

describe('the tail handler copies deliveries', () => {
  it('copies one row per bidding Worker scheduled invocation, and none for the ops Worker', async () => {
    await worker.tail([
      trace({ script: OPS_WORKER_SCRIPT, messages: [[line('ops-d', 'ran')]] }),
      trace({ messages: [[line('d-9', 'ran')]] }),
      trace({ messages: [[line('d-10', 'skipped')]] }),
    ], env, ctx)
    const ids = posted.flatMap((p) => p.body as Array<{ delivery_id: string }>).map((r) => r.delivery_id)
    expect(ids).toEqual(['d-9', 'd-10'])
  })
})
