import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { createSupabaseClient } from '../supabase'
import { createLeadSupabaseClient, leadRead, LEAD_DB_DOWN_CODE, LEAD_READ_DEADLINE_MS, leadDatabaseDown, noteLeadWriteUnanswered } from '../lead-read-budget'

/**
 * The read time budget for a lead (#1844, Dan's decision of 2026-10-07: fall
 * back fast). Every test drives the REAL supabase-js client; only the network
 * beneath it is replaced, so the library's own retries and error conversion are
 * what is under test.
 */
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env

type Answer = 'ok' | 'refuse' | '503' | '406' | 'hang'

function network(answers: Answer[]) {
  const calls: Array<{ method: string; url: string; signal: AbortSignal | null | undefined }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? 'GET', url, signal: init?.signal })
    const answer = answers.shift() ?? 'ok'
    if (answer === 'refuse') throw new TypeError('fetch failed')
    if (answer === 'hang') {
      // As real fetch does: a signal already aborted rejects at once.
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
      })
    }
    if (answer === '503') return new Response(JSON.stringify({ code: 'PGRST002', message: 'Could not query the database for the schema cache' }), { status: 503, headers: { 'content-type': 'application/json' } })
    if (answer === '406') return new Response(JSON.stringify({ code: 'PGRST116', message: 'no rows' }), { status: 406, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify([{ id: 'row-1' }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** A deadline the test fires by hand, so no test waits in real time (L524). */
function manualDeadlines() {
  const asked: number[] = []
  const controllers: AbortController[] = []
  return {
    asked,
    fireAll: () => controllers.forEach((c) => c.abort(new DOMException('deadline', 'TimeoutError'))),
    deadline: (ms: number) => {
      asked.push(ms)
      const c = new AbortController()
      controllers.push(c)
      return c.signal
    },
  }
}

describe('leadRead on a lead client (#1844)', () => {
  it('returns a healthy read unchanged, with a deadline attached', async () => {
    const net = network(['ok'])
    const d = manualDeadlines()
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: d.deadline })
    const res = await leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    expect(res.error).toBeNull()
    expect(res.data).toEqual([{ id: 'row-1' }])
    expect(d.asked).toEqual([LEAD_READ_DEADLINE_MS])
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0].signal).toBeTruthy()
  })

  it.each([
    ['a refused connection', 'refuse'],
    ['a 503 from PostgREST', '503'],
  ] as const)('answers %s at once with an error, never retrying', async (_label, answer) => {
    const net = network([answer, 'ok', 'ok', 'ok'])
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    const res = await leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    expect(res.error).not.toBeNull()
    expect(net.calls).toHaveLength(1)
  })

  it('answers a read that hangs with an error when its deadline fires', async () => {
    const net = network(['hang'])
    const d = manualDeadlines()
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: d.deadline })
    const pending = leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    // Fire only once the request is waiting on the network, as a real hang is.
    await vi.waitFor(() => expect(net.calls).toHaveLength(1))
    d.fireAll()
    const res = await pending
    expect(res.error).not.toBeNull()
    expect(net.calls).toHaveLength(1)
  })

  it('takes the deadline a caller asks for when it is tighter', async () => {
    const net = network(['ok'])
    const d = manualDeadlines()
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: d.deadline })
    await leadRead(db, db.from('buyer_profiles').select('id'), 'buyer profiles', { deadlineMs: 250 })
    expect(d.asked).toEqual([250])
  })

  it.each(['refuse', '503', 'hang'] as const)('after one %s, sends no further read in that lead and answers each at once', async (answer) => {
    const net = network([answer])
    const d = manualDeadlines()
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: d.deadline })
    const first = leadRead(db, db.from('environment_variables').select('id'), 'env vars')
    if (answer === 'hang') d.fireAll()
    await first
    const second = await leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    expect(second.error).not.toBeNull()
    expect(second.error?.message).toMatch(/earlier read in this lead failed/)
    expect(net.calls).toHaveLength(1)
  })

  it('does not count a not-found answer as the database being down', async () => {
    const net = network(['406', 'ok'])
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    const first = await leadRead(db, db.from('workflows').select('id').single(), 'definition')
    expect(first.error?.code).toBe('PGRST116')
    const second = await leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    expect(second.error).toBeNull()
    expect(net.calls).toHaveLength(2)
  })

  it('keeps each lead separate: one lead failing does not trip another lead', async () => {
    const net = network(['refuse', 'ok'])
    const first = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    const other = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    await leadRead(first, first.from('partner_configs').select('id'), 'partner config')
    const res = await leadRead(other, other.from('partner_configs').select('id'), 'partner config')
    expect(res.error).toBeNull()
  })
})

/**
 * A write the lead waited on that did not answer in time (#1849): the database
 * is not answering, so the lead's later reads go straight to their copies
 * rather than each waiting out its own deadline. Found by the outage drill's
 * hung shape on the Liberty1 click: a held click record and the page after it
 * each waited in turn.
 */
describe('a write that did not answer trips the lead (#1849)', () => {
  it('the next read answers at once without asking the database, naming the write', async () => {
    const net = network(['ok'])
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    noteLeadWriteUnanswered(db, 'held click record')
    const res = await leadRead(db, db.from('service_connections').select('config'), 'slack connection')
    expect(net.calls).toHaveLength(0)
    expect(res.error).toMatchObject({ code: LEAD_DB_DOWN_CODE })
    expect(res.error?.message).toMatch(/held click record/)
  })

  it('says why the lead knows its database is down, for a write with its own repair to skip waiting on it', async () => {
    const net = network(['refuse'])
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    expect(leadDatabaseDown(db)).toBeNull()
    await leadRead(db, db.from('partner_configs').select('id'), 'partner config')
    expect(leadDatabaseDown(db)).toMatch(/partner config/)
    expect(leadDatabaseDown(createSupabaseClient(env))).toBeNull()
  })

  it('changes nothing on any other client', async () => {
    const net = network(['ok'])
    vi.stubGlobal('fetch', net.fetch)
    try {
      const db = createSupabaseClient(env)
      noteLeadWriteUnanswered(db, 'held click record')
      const res = await leadRead(db, db.from('service_connections').select('config'), 'slack connection')
      expect(res.error).toBeNull()
      expect(net.calls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// Plan A1 (Dan, 2026-10-07): no library retries on the reads a lead waits on,
// including a read with no copy, which goes through the client directly. With
// retries on, each such read in an outage waited 1, 2 and 4 s before failing.
describe('a lead client never retries a read', () => {
  it.each(['503', 'refuse'] as const)('answers a %s read on the plain query after one request', async (answer) => {
    const net = network([answer, 'ok'])
    const db = createLeadSupabaseClient(env, { fetch: net.fetch, deadline: manualDeadlines().deadline })
    const res = await db.from('bid_matrix_rows').select('id')
    expect(res.error).not.toBeNull()
    expect(net.calls).toHaveLength(1)
  })
})

describe('leadRead on any other client (#1844)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('runs the read exactly as before: no deadline, and the library keeps its retries', async () => {
    // A plain client is what scheduled jobs and the signed-in app use.
    const net = network(['ok'])
    vi.stubGlobal('fetch', net.fetch)
    const db = createSupabaseClient(env)
    const query = db.from('partner_configs').select('id')
    const signal = vi.spyOn(query, 'abortSignal')
    const retry = vi.spyOn(query, 'retry')
    const res = await leadRead(db, query, 'partner config')
    expect(res.error).toBeNull()
    expect(signal).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('the budget fits inside the steps that wait on it (#1844)', () => {
  it('stays above healthy read times, measured 2026-10-07 (1 in 1,000 reads under 1,056 ms)', () => {
    expect(LEAD_READ_DEADLINE_MS).toBeGreaterThanOrEqual(1_000)
  })
})
