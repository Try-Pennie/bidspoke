/**
 * The tail worker keeps a second record of every cron guard fail-open (#2166).
 *
 * On 2026-10-14 the bidding Worker's KV write counting each fail-open failed in
 * the same platform blip that made its guard fail open, so 9 `FAILED OPEN` lines
 * were counted as 3. The lines themselves survived: Cloudflare hands them to this
 * consumer after the invocation ends, through a path that does not depend on the
 * failing isolate or on KV. So each one is copied into cron_guard_fail_opens by
 * its event id, retried, and held in this isolate until the database takes it.
 * The database is reached through fetch, mocked here; the backoff's sleep is
 * injected, so no real time passes (L524).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createFailOpenCopier, failOpensIn, COPY_BACKOFF_MS } from './fail-opens'
import worker, { OPS_WORKER_SCRIPT } from './index'

const AT = Date.parse('2026-10-14T21:34:02.118Z')
const env = { SUPABASE_URL: 'https://bidding.test', SUPABASE_SECRET_KEY: 'test-key' }
const ctx = {} as ExecutionContext
const supabase = () => createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const LINE = (id: string) => `[cron-once] FAILED OPEN event=${id} cron="* * * * *" scheduled=2026-10-14T21:34:00.000Z: claim cron-tick:* * * * *@2026-10-14T21:34Z failed: Network connection lost., running without the claim`

function scheduledTrace(scriptName: string | null, messages: unknown[], outcome = 'ok'): TraceItem {
  return {
    scriptName,
    outcome,
    cpuTime: 5,
    event: { cron: '* * * * *', scheduledTime: AT - 2_118 },
    logs: messages.map((message, i) => ({ timestamp: AT + i, level: 'error', message })),
  } as unknown as TraceItem
}

let posted: Array<{ url: string; prefer: string | null; body: unknown }>
let failures: number

beforeEach(() => {
  posted = []
  failures = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url.includes('/cron_guard_fail_opens')) {
      if (failures > 0) {
        failures--
        return Promise.resolve(Response.json({ message: 'upstream connect error' }, { status: 503 }))
      }
      const headers = new Headers(init?.headers)
      posted.push({ url, prefer: headers.get('Prefer'), body: JSON.parse(init?.body as string) })
      return Promise.resolve(new Response(null, { status: 201 }))
    }
    if (method === 'GET') return Promise.resolve(Response.json({ cost_usd: 0, started_at: '2026-10-06T12:00:00Z' }))
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('failOpensIn', () => {
  it('reads each FAILED OPEN line, by its event id, at the time it was logged', () => {
    const rows = failOpensIn(scheduledTrace('bidspoke-worker', [[LINE('ev-1')], ['[cron-once] running cron="* * * * *"'], LINE('ev-2')]))
    expect(rows).toEqual([
      { event_id: 'ev-1', occurred_at: new Date(AT).toISOString(), cron: '* * * * *', line: LINE('ev-1') },
      { event_id: 'ev-2', occurred_at: new Date(AT + 2).toISOString(), cron: '* * * * *', line: LINE('ev-2') },
    ])
  })

  it('keeps a fail-open from a run that then crashed: it still ran unguarded', () => {
    expect(failOpensIn(scheduledTrace('bidspoke-worker', [[LINE('ev-1')]], 'exception'))).toHaveLength(1)
  })

  it('ignores the ops Worker, a line without an event id, and a line that merely mentions FAILED OPEN', () => {
    expect(failOpensIn(scheduledTrace(OPS_WORKER_SCRIPT, [[LINE('ev-1')]]))).toEqual([])
    expect(failOpensIn(scheduledTrace('bidspoke-worker', [['[cron-once] FAILED OPEN cron="* * * * *": old shape']]))).toEqual([])
    expect(failOpensIn(scheduledTrace('bidspoke-worker', [['Search Workers Logs for "[cron-once] FAILED OPEN event=x"']]))).toEqual([])
    // An id the table would refuse would hold back every row batched with it.
    expect(failOpensIn(scheduledTrace('bidspoke-worker', [[LINE('a'.repeat(101))]]))).toEqual([])
  })
})

describe('createFailOpenCopier', () => {
  function copier(maxHeld?: number) {
    const slept: number[] = []
    const errors: string[] = []
    const c = createFailOpenCopier({ sleep: (ms) => { slept.push(ms); return Promise.resolve() }, error: (l) => { errors.push(l) }, log: () => {}, maxHeld })
    return { c, slept, errors }
  }
  const row = (id: string) => ({ event_id: id, occurred_at: new Date(AT).toISOString(), cron: '* * * * *', line: LINE(id) })

  it('upserts by event id, ignoring a row already there, so a copy written twice counts once', async () => {
    const { c } = copier()
    await c.copy(supabase(), [row('ev-1')])
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain('on_conflict=event_id')
    expect(posted[0].prefer).toContain('resolution=ignore-duplicates')
    expect(posted[0].body).toEqual([row('ev-1')])
    expect(c.held()).toEqual([])
  })

  it('retries a refused write after a short backoff', async () => {
    failures = 1
    const { c, slept } = copier()
    await c.copy(supabase(), [row('ev-1')])
    expect(slept).toEqual([COPY_BACKOFF_MS[0]])
    expect(posted).toHaveLength(1)
  })

  it('holds what the database keeps refusing, says why, and writes it with the next batch once it answers', async () => {
    failures = Infinity
    const { c, errors } = copier()
    await c.copy(supabase(), [row('ev-1')])
    expect(posted).toEqual([])
    expect(c.held().map((r) => r.event_id)).toEqual(['ev-1'])
    expect(errors.join('\n')).toMatch(/could not copy 1 cron guard fail-open .*upstream connect error.*held/)

    failures = 0
    await c.copy(supabase(), [row('ev-2')])
    expect(posted.flatMap((p) => p.body as Array<{ event_id: string }>).map((r) => r.event_id)).toEqual(['ev-1', 'ev-2'])
    expect(c.held()).toEqual([])
  })

  it('retries held rows once per batch, without backoff, so a database outage is not multiplied by every trace', async () => {
    failures = Infinity
    const { c, slept } = copier()
    await c.copy(supabase(), [row('ev-1')])
    slept.length = 0
    vi.mocked(globalThis.fetch).mockClear()
    await c.copy(supabase(), [])
    expect(slept).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(c.held()).toHaveLength(1)
  })

  it('a batch with nothing new and nothing held touches nothing', async () => {
    const { c } = copier()
    await c.copy(supabase(), [])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('caps what it holds, dropping the oldest loudly, with how many', async () => {
    failures = Infinity
    const { c, errors } = copier(2)
    await c.copy(supabase(), [row('ev-1'), row('ev-2'), row('ev-3')])
    expect(c.held().map((r) => r.event_id)).toEqual(['ev-2', 'ev-3'])
    expect(errors.join('\n')).toMatch(/dropped 1 held cron guard fail-open, the oldest event=ev-1 .*2 already held.*1 dropped by this isolate so far/)
  })

})

describe('the tail handler copies fail-opens', () => {
  it('copies a bidding Worker fail-open, and never an ops Worker one', async () => {
    await worker.tail([scheduledTrace(OPS_WORKER_SCRIPT, [[LINE('ops-ev')]]), scheduledTrace('bidspoke-worker', [[LINE('ev-9')]])], env, ctx)
    const ids = posted.flatMap((p) => p.body as Array<{ event_id: string }>).map((r) => r.event_id)
    expect(ids).toEqual(['ev-9'])
  })
})
