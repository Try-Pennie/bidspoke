/**
 * The row cap detector (#1436, decided by Dan on #1437, 2026-10-18).
 *
 * PostgREST returns at most ROW_CAP rows and says nothing about having stopped
 * there. A read that came back at the cap without having declared a limit is
 * reported every time, and inside a scheduled tick it also fails, so a job does
 * not go on with a silently short list.
 *
 * These tests drive the real Supabase client (createSupabaseClient) with an
 * injected fetch answering as PostgREST does: `Content-Range: 0-999/*` and 1,000
 * rows, measured on production edge logs on 2026-10-18 for a read sent with no
 * count requested. Every timer is injected; nothing here waits for real (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSupabaseClient } from '../supabase'
import { runInScheduledTick } from '../outage-notice'
import {
  ROW_CAP,
  ROW_CAP_LINE,
  ROW_CAP_ERROR_CODE,
  ROW_CAP_REPORT_INTERVAL_MS,
  detectRowCapHit,
  redactQuery,
  rowCapEvent,
  withRowCapCheck,
  forgetRowCapReports,
  runWithRequestWaitUntil,
} from '../row-cap'
import { PAGE_SIZE } from '../paginate'
import type { Env } from '../../index'

const SUPABASE_URL = 'https://xvrmivmpfykwwtriqwpg.supabase.co'
const BETTER_STACK_URL = 'https://in.example.betterstackdata.com'

type Call = { url: string; method: string; headers: Headers; body: string | null }

/** A PostgREST double: every request answers `rows` rows with the Content-Range PostgREST sends. */
function postgrest(rows: number, opts: { total?: number | '*'; status?: number } = {}) {
  const calls: Call[] = []
  const sends: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers: new Headers(init?.headers), body: (init?.body as string | null) ?? null }
    if (url.startsWith(BETTER_STACK_URL)) {
      sends.push(call)
      return new Response(null, { status: 202 })
    }
    calls.push(call)
    const body = Array.from({ length: rows }, (_, i) => ({ id: i }))
    const total = opts.total ?? '*'
    const range = rows === 0 ? `*/${total}` : `0-${rows - 1}/${total}`
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Range': range },
    })
  }) as typeof fetch
  return { fetchFn, calls, sends }
}

function envFor(extra: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: 'test-service-role-key',
    BETTERSTACK_OUTAGE_TOKEN: 'bs-token',
    BETTERSTACK_OUTAGE_URL: BETTER_STACK_URL,
    ...extra,
  } as unknown as Env
}

let logged: string[]

beforeEach(() => {
  forgetRowCapReports()
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const capLines = () => logged.filter((l) => l.includes(ROW_CAP_LINE))

describe('the cap the detector judges by', () => {
  it('is the page size the pagination helper asks for, 1,000 (the max_rows dashboard setting)', () => {
    expect(ROW_CAP).toBe(PAGE_SIZE)
    expect(ROW_CAP).toBe(1000)
  })
})

describe('outside a scheduled tick: every hit is reported, and the read still answers', () => {
  it('reports a table read at the cap with no limit, naming the table and the query', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    const { data, error } = await supabase.from('execution_archive_hours').select('archive_day, hour_start')
    expect(error).toBeNull()
    expect(data).toHaveLength(1000)
    expect(capLines()).toHaveLength(1)
    const event = JSON.parse(capLines()[0])
    expect(event).toMatchObject({ message: ROW_CAP_LINE, relation: 'execution_archive_hours', kind: 'table', rows: 1000, in_scheduled_tick: false })
    expect(event.query).toContain('select=archive_day,hour_start')
  })

  it('reports a read whose limit is above the cap, since a limit above it declares nothing', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflow_executions').select('id').limit(5000)
    expect(pg.calls[0].url).toContain('limit=5000')
    expect(capLines()).toHaveLength(1)
  })

  it('reports a set returning rpc at the cap', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.rpc('execution_counts_per_minute', { p_since: '2026-10-18T00:00:00Z', p_workflow_ids: [] })
    expect(pg.calls[0].method).toBe('POST')
    expect(capLines()).toHaveLength(1)
    expect(JSON.parse(capLines()[0])).toMatchObject({ relation: 'execution_counts_per_minute', kind: 'rpc' })
  })

  it('sends the same event to the Better Stack source, which is where the alert reads it', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('execution_archive_hours').select('archive_day')
    await vi.waitFor(() => expect(pg.sends).toHaveLength(1))
    expect(pg.sends[0].headers.get('Authorization')).toBe('Bearer bs-token')
    expect(JSON.parse(pg.sends[0].body as string)).toEqual(JSON.parse(capLines()[0]))
  })

  it('logs every hit, and sends the same call site to Better Stack at most once per interval', async () => {
    let now = Date.parse('2026-10-18T12:00:00Z')
    const pg = postgrest(1000)
    const wrapped = withRowCapCheck(pg.fetchFn, { betterStack: { token: 'bs-token', url: BETTER_STACK_URL }, sendFetch: pg.fetchFn, now: () => now })
    const read = () => wrapped(`${SUPABASE_URL}/rest/v1/execution_steps?select=id`, { method: 'GET' })
    await read()
    await read()
    await vi.waitFor(() => expect(pg.sends).toHaveLength(1))
    expect(capLines()).toHaveLength(2)
    now += ROW_CAP_REPORT_INTERVAL_MS
    await read()
    await vi.waitFor(() => expect(pg.sends).toHaveLength(2))
  })

  it('hands the send to the request\'s waitUntil, so it outlives the response', async () => {
    const pg = postgrest(1000)
    const kept: Promise<unknown>[] = []
    const wrapped = withRowCapCheck(pg.fetchFn, { betterStack: { token: 'bs-token', url: BETTER_STACK_URL }, sendFetch: pg.fetchFn })
    const res = await runWithRequestWaitUntil((p) => kept.push(p), () => wrapped(`${SUPABASE_URL}/rest/v1/execution_steps?select=id`, { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(kept).toHaveLength(1)
    await Promise.all(kept)
    expect(pg.sends).toHaveLength(1)
  })

  it('a failed Better Stack send never fails the read', async () => {
    const pg = postgrest(1000)
    const sendFetch = (async () => { throw new Error('network down') }) as typeof fetch
    const wrapped = withRowCapCheck(pg.fetchFn, { betterStack: { token: 'bs-token', url: BETTER_STACK_URL }, sendFetch })
    const res = await wrapped(`${SUPABASE_URL}/rest/v1/execution_steps?select=id`, { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1000)
  })
})

describe('quiet when the read declared its limit or cannot be truncated', () => {
  it('is quiet on limit=1000', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflow_executions').select('id').limit(1000)
    expect(capLines()).toHaveLength(0)
  })

  it('is quiet on a range, which declares offset and limit', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflow_executions').select('id').order('id').range(1000, 1999)
    expect(pg.calls[0].url).toContain('limit=1000')
    expect(capLines()).toHaveLength(0)
  })

  it('is quiet on a single row read, whose Accept header asks for one object', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflows').select('id').single()
    expect(pg.calls[0].headers.get('Accept')).toContain('application/vnd.pgrst.object+json')
    expect(capLines()).toHaveLength(0)
  })

  it('a maybeSingle read sends no such header in this client, and 1,000 rows are already an error to it', async () => {
    // postgrest-js 2.117 asks for an array on maybeSingle and refuses more than
    // one row itself (PGRST116), so nothing on the request can exempt it and a
    // read that brought back the whole cap is a defect either way.
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    const { error } = await supabase.from('workflows').select('id').maybeSingle()
    expect(pg.calls[0].headers.get('Accept') ?? '').not.toContain('application/vnd.pgrst.object')
    expect(error?.code).toBe('PGRST116')
  })

  it('ignores an embedded resource limit (x.limit=), which bounds the embed, not the read', () => {
    const hit = detectRowCapHit({
      url: `${SUPABASE_URL}/rest/v1/workflows?select=id,steps(id)&steps.limit=5`,
      method: 'GET',
      accept: null,
      contentRange: '0-999/*',
    })
    expect(hit).not.toBeNull()
  })

  it('is quiet below the cap', async () => {
    const pg = postgrest(999)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflows').select('id')
    expect(capLines()).toHaveLength(0)
  })

  it('is quiet when a count shows exactly the cap exists', async () => {
    const pg = postgrest(1000, { total: 1000 })
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('workflows').select('id', { count: 'exact' })
    expect(capLines()).toHaveLength(0)
  })

  it('reports when a count shows more rows exist than came back', () => {
    expect(detectRowCapHit({ url: `${SUPABASE_URL}/rest/v1/workflows?select=id`, method: 'GET', accept: null, contentRange: '0-999/4210' })).toMatchObject({ rows: 1000, total: 4210 })
  })

  it('is quiet on a head count, which returns no rows', async () => {
    const pg = postgrest(1000, { total: 52_000 })
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await supabase.from('execution_steps').select('id', { count: 'exact', head: true })
    expect(pg.calls[0].method).toBe('HEAD')
    expect(capLines()).toHaveLength(0)
  })

  it('is quiet on a write, whose returned rows PostgREST does not cap', () => {
    expect(detectRowCapHit({ url: `${SUPABASE_URL}/rest/v1/workflows?select=id`, method: 'PATCH', accept: null, contentRange: '0-999/*' })).toBeNull()
    expect(detectRowCapHit({ url: `${SUPABASE_URL}/rest/v1/workflows`, method: 'POST', accept: null, contentRange: '0-999/*' })).toBeNull()
  })

  it('is quiet on a response with no Content-Range', () => {
    expect(detectRowCapHit({ url: `${SUPABASE_URL}/rest/v1/workflows?select=id`, method: 'GET', accept: null, contentRange: null })).toBeNull()
  })

  it('is quiet on an error response, whatever range it carries, and passes it through untouched', async () => {
    const pg = postgrest(1000, { status: 503 })
    const wrapped = withRowCapCheck(pg.fetchFn, { inScheduledTick: () => true })
    const res = await wrapped(`${SUPABASE_URL}/rest/v1/workflows?select=id`, { method: 'GET' })
    expect(res.status).toBe(503)
    expect(capLines()).toHaveLength(0)
  })

  it('reads nothing that is not PostgREST (auth, storage)', () => {
    expect(detectRowCapHit({ url: `${SUPABASE_URL}/auth/v1/admin/users`, method: 'GET', accept: null, contentRange: '0-999/*' })).toBeNull()
  })
})

describe('inside a scheduled tick: the read fails', () => {
  it('a hit comes back as an error naming the table and the query, with no rows', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    const { data, error } = await runInScheduledTick(async () => await supabase.from('execution_archive_hours').select('archive_day, hour_start'))
    expect(data).toBeNull()
    expect(error?.code).toBe(ROW_CAP_ERROR_CODE)
    expect(error?.message).toContain('execution_archive_hours')
    expect(error?.message).toContain('select=archive_day,hour_start')
    expect(JSON.parse(capLines()[0]).in_scheduled_tick).toBe(true)
  })

  it('is not retried by the client, so one hit is one read', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await runInScheduledTick(async () => await supabase.from('execution_steps').select('id'))
    expect(pg.calls).toHaveLength(1)
  })

  it('throws for a caller that asked the client to throw', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await expect(runInScheduledTick(async () => await supabase.from('execution_steps').select('id').throwOnError())).rejects.toThrow(/execution_steps/)
  })

  it('sends to Better Stack before the read fails, so the tick ending cannot lose the report', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    await runInScheduledTick(async () => await supabase.from('execution_steps').select('id'))
    expect(pg.sends).toHaveLength(1)
  })

  it('waits for the Better Stack send inside a tick, and never waits for it outside one', async () => {
    const pg = postgrest(1000)
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const slowSend = (async () => { await gate; return new Response(null, { status: 202 }) }) as typeof fetch
    const read = (scheduled: boolean) =>
      withRowCapCheck(pg.fetchFn, { betterStack: { token: 't', url: BETTER_STACK_URL }, sendFetch: slowSend, inScheduledTick: () => scheduled })(
        `${SUPABASE_URL}/rest/v1/execution_steps?select=id${scheduled ? '&a=eq.1' : ''}`,
        { method: 'GET' },
      )
    let settled = false
    const inTick = read(true).then((r) => { settled = true; return r })
    const outside = await read(false)
    expect(outside.status).toBe(200)
    await Promise.resolve()
    expect(settled).toBe(false)
    open()
    expect((await inTick).status).toBe(500)
  })

  it('a declared limit inside a tick still answers normally', async () => {
    const pg = postgrest(1000)
    const supabase = createSupabaseClient(envFor(), { fetch: pg.fetchFn })
    const { data, error } = await runInScheduledTick(async () => await supabase.from('execution_steps').select('id').limit(1000))
    expect(error).toBeNull()
    expect(data).toHaveLength(1000)
  })
})

describe('the event carries no row values', () => {
  it('redacts filter values and keeps the shape of the query', () => {
    const q = redactQuery(new URLSearchParams('select=id,email&email=eq.someone@example.com&ssn_hash=in.(a,b)&status=not.eq.done&order=id.asc&limit=5000&offset=0'))
    expect(q).toBe('select=id,email&email=eq.?&ssn_hash=in.?&status=not.eq.?&order=id.asc&limit=5000&offset=0')
    expect(q).not.toContain('someone')
  })

  it('pins the whole event to exactly these fields', () => {
    const hit = detectRowCapHit({ url: `${SUPABASE_URL}/rest/v1/persons?select=id&email=eq.a@b.c`, method: 'GET', accept: null, contentRange: '0-999/*' })
    expect(hit).not.toBeNull()
    const event = rowCapEvent(hit!, false, Date.parse('2026-10-18T12:00:00Z'))
    expect(Object.keys(event).sort()).toEqual(['dt', 'in_scheduled_tick', 'kind', 'message', 'query', 'relation', 'rows', 'total'])
    expect(JSON.stringify(event)).not.toContain('a@b.c')
  })
})
