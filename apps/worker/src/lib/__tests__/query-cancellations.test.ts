import { describe, expect, it, vi } from 'vitest'
import {
  CANCELLATION_KEY_PREFIX,
  CANCELLATION_LIST_PAGE_CAP,
  cancelledStatement,
  readCancellations,
  withCancellationRecord,
  type CancellationStore,
} from '../query-cancellations'
import { createSupabaseClient } from '../supabase'
import type { Env } from '../../index'

/**
 * A statement Postgres cancels at its role's statement_timeout never finishes, so
 * pg_stat_statements never records it, and the near limit watch cannot see it (#2651, L800).
 * The Worker is the one party that DOES see every cancellation of its own queries: PostgREST
 * answers it with a 500 carrying `Proxy-Status: PostgREST; error=57014`. So the Supabase
 * client's fetch records each one, and the hourly watch counts them.
 */

const BASE = 'https://xvrmivmpfykwwtriqwpg.supabase.co/rest/v1/'

// The two shapes cancelled at 04:00 and 09:00 UTC on 2026-10-22, copied from the edge logs
// (#2647): HEAD counts with no body, so the 57014 is ONLY in the Proxy-Status header.
const LENDSWIFT_COUNT =
  BASE +
  'workflow_executions?select=id&workflow_id=eq.e1b810da-16c0-49eb-bf12-ba1c9b67c914&is_test=eq.false&status=neq.running&started_at=gte.2026-10-15T01%3A58%3A30.891Z&started_at=lt.2026-10-22T01%3A58%3A30.891Z'
const LENDSWIFT_REASON =
  LENDSWIFT_COUNT +
  '&final_node_namespace=eq.validate_bidding_and_state&status=neq.failed&response_body-%3E%3Ereason=eq.bidding+not+active'

function cancelled(method: 'HEAD' | 'GET' | 'POST' = 'HEAD'): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }), {
    status: 500,
    headers: { 'proxy-status': 'PostgREST; error=57014' },
  })
}

function fakeStore() {
  const puts: { key: string; value: string; opts: { expirationTtl?: number; metadata?: unknown } | undefined }[] = []
  const store: CancellationStore & { puts: typeof puts } = {
    puts,
    put: async (key, value, opts) => void puts.push({ key, value, opts }),
    list: async () => ({ keys: [], list_complete: true }),
  }
  return store
}

describe('cancelledStatement: which answers are a statement cancelled by Postgres', () => {
  it('reads a HEAD count whose only evidence is the Proxy-Status header, naming its shape with no filter value', async () => {
    const s = await cancelledStatement({ url: LENDSWIFT_REASON, method: 'HEAD' }, cancelled('HEAD'))
    expect(s).toBe(
      'HEAD workflow_executions?select=id&workflow_id=eq.?&is_test=eq.?&status=neq.?&started_at=gte.?&started_at=lt.?' +
        '&final_node_namespace=eq.?&status=neq.?&response_body->>reason=eq.?',
    )
    // No lead or workflow data reaches the record (L482).
    expect(s).not.toContain('e1b810da')
    expect(s).not.toContain('2026-10')
    expect(s).not.toContain('bidding')
  })

  it('names an rpc by its function', async () => {
    const s = await cancelledStatement({ url: BASE + 'rpc/query_timeout_watch', method: 'POST' }, cancelled('POST'))
    expect(s).toBe('POST rpc/query_timeout_watch')
  })

  it('reads the error code from the body when the header is missing, leaving the body for the caller', async () => {
    const res = new Response(JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }), { status: 500 })
    const s = await cancelledStatement({ url: BASE + 'workflows?select=id', method: 'GET' }, res)
    expect(s).toBe('GET workflows?select=id')
    expect(((await res.json()) as { code: string }).code).toBe('57014')
  })

  it('ignores every other answer: a success, another error code, a missing table, and a 500 with no code at all', async () => {
    const url = BASE + 'workflows?select=id'
    expect(await cancelledStatement({ url, method: 'GET' }, new Response('[]', { status: 200 }))).toBeNull()
    expect(
      await cancelledStatement({ url, method: 'GET' }, new Response('{"code":"XX000"}', { status: 500, headers: { 'proxy-status': 'PostgREST; error=XX000' } })),
    ).toBeNull()
    expect(
      await cancelledStatement({ url, method: 'HEAD' }, new Response(null, { status: 404, headers: { 'proxy-status': 'PostgREST; error=PGRST205' } })),
    ).toBeNull()
    expect(await cancelledStatement({ url, method: 'GET' }, new Response('not json', { status: 500 }))).toBeNull()
  })

  it('does not mistake a longer code that merely starts with 57014 for a cancellation', async () => {
    const res = new Response(null, { status: 500, headers: { 'proxy-status': 'PostgREST; error=570140' } })
    expect(await cancelledStatement({ url: BASE + 'workflows', method: 'HEAD' }, res)).toBeNull()
  })
})

describe('withCancellationRecord: the Supabase fetch records each cancellation', () => {
  const now = () => Date.parse('2026-10-22T04:01:04.387Z')

  it('writes one record per cancellation, with the statement and the time in its metadata, and returns the answer unchanged', async () => {
    const store = fakeStore()
    const answer = cancelled('HEAD')
    const fetchFn = withCancellationRecord(async () => answer, { store, now, log: () => {} })
    const res = await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })
    expect(res).toBe(answer)
    expect(store.puts).toHaveLength(1)
    const put = store.puts[0]
    expect(put.key.startsWith(CANCELLATION_KEY_PREFIX)).toBe(true)
    expect(put.opts?.metadata).toEqual({
      s: 'HEAD workflow_executions?select=id&workflow_id=eq.?&is_test=eq.?&status=neq.?&started_at=gte.?&started_at=lt.?',
      at: now(),
    })
    // It expires on its own, long after the hourly watch has read it.
    expect(put.opts?.expirationTtl).toBeGreaterThanOrEqual(24 * 60 * 60)
  })

  it('gives two cancellations of the same statement in the same millisecond two records, so neither is lost', async () => {
    const store = fakeStore()
    const fetchFn = withCancellationRecord(async () => cancelled('HEAD'), { store, now, log: () => {} })
    await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })
    await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })
    expect(new Set(store.puts.map((p) => p.key)).size).toBe(2)
  })

  it('writes nothing for an answer that is not a cancellation', async () => {
    const store = fakeStore()
    const fetchFn = withCancellationRecord(async () => new Response('[]', { status: 200 }), { store, now, log: () => {} })
    await fetchFn(BASE + 'workflows?select=id')
    expect(store.puts).toHaveLength(0)
  })

  it('still hands the caller its answer when the record cannot be written, and says so in the log', async () => {
    const lines: string[] = []
    const store = fakeStore()
    store.put = async () => {
      throw new Error('KV unavailable')
    }
    const answer = cancelled('HEAD')
    const fetchFn = withCancellationRecord(async () => answer, { store, now, log: (l) => void lines.push(l) })
    expect(await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })).toBe(answer)
    expect(lines.some((l) => l.includes('could not be recorded') && l.includes('KV unavailable'))).toBe(true)
  })

  it('gives up on a record that does not answer in time, so a stuck store never holds the caller', async () => {
    const lines: string[] = []
    const store = fakeStore()
    store.put = () => new Promise(() => {})
    const delay = vi.fn(async () => {})
    const answer = cancelled('HEAD')
    const fetchFn = withCancellationRecord(async () => answer, { store, now, log: (l) => void lines.push(l), delay })
    expect(await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })).toBe(answer)
    expect(delay).toHaveBeenCalled()
    expect(lines.some((l) => l.includes('could not be recorded'))).toBe(true)
  })

  it('says, rather than silently skipping, when it has no store to record into', async () => {
    const lines: string[] = []
    const answer = cancelled('HEAD')
    const fetchFn = withCancellationRecord(async () => answer, { store: undefined, now, log: (l) => void lines.push(l) })
    expect(await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })).toBe(answer)
    expect(lines.some((l) => l.includes('no store'))).toBe(true)
  })

  it('logs every cancellation as one line, whether or not it was recorded', async () => {
    const lines: string[] = []
    const fetchFn = withCancellationRecord(async () => cancelled('HEAD'), { store: fakeStore(), now, log: (l) => void lines.push(l) })
    await fetchFn(LENDSWIFT_COUNT, { method: 'HEAD' })
    expect(lines.filter((l) => l.includes('event=query_cancelled'))).toHaveLength(1)
  })
})

describe('the real Supabase client records cancellations (built is not wired, L3)', () => {
  it('records a cancelled count made through createSupabaseClient into the IDEMPOTENCY store, and the caller still gets its error', async () => {
    const store = fakeStore()
    const env = { SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co', SUPABASE_SECRET_KEY: 'k', IDEMPOTENCY: store } as unknown as Env
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const supabase = createSupabaseClient(env, { fetch: async () => cancelled('HEAD') })
      const { error } = await supabase
        .from('workflow_executions')
        .select('id', { count: 'exact', head: true })
        .eq('workflow_id', 'e1b810da-16c0-49eb-bf12-ba1c9b67c914')
      expect(error).not.toBeNull()
      expect(store.puts).toHaveLength(1)
      expect((store.puts[0].opts?.metadata as { s: string }).s).toBe('HEAD workflow_executions?select=id&workflow_id=eq.?')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('readCancellations: what the hourly watch counts', () => {
  it('reads every page of records', async () => {
    const pages = [
      { keys: [{ name: `${CANCELLATION_KEY_PREFIX}a`, metadata: { s: 'HEAD a', at: 1 } }], list_complete: false, cursor: 'c1' },
      { keys: [{ name: `${CANCELLATION_KEY_PREFIX}b`, metadata: { s: 'HEAD b', at: 2 } }], list_complete: true },
    ]
    const list = vi.fn(async (opts: { prefix: string; cursor?: string }) => {
      expect(opts.prefix).toBe(CANCELLATION_KEY_PREFIX)
      return opts.cursor === 'c1' ? pages[1] : pages[0]
    })
    const r = await readCancellations({ list, put: async () => {} })
    expect(r.events).toEqual([
      { statement: 'HEAD a', atMs: 1 },
      { statement: 'HEAD b', atMs: 2 },
    ])
    expect(r.truncated).toBe(false)
  })

  it('throws when the record cannot be listed, so an unreadable record is never read as no cancellations (L98)', async () => {
    const list = async () => {
      throw new Error('list failed')
    }
    await expect(readCancellations({ list, put: async () => {} })).rejects.toThrow('list failed')
  })

  it('counts a record whose metadata it cannot read as a cancellation of an unknown statement, rather than dropping it', async () => {
    const list = async () => ({ keys: [{ name: `${CANCELLATION_KEY_PREFIX}x`, metadata: null }], list_complete: true })
    const r = await readCancellations({ list, put: async () => {} })
    expect(r.events).toHaveLength(1)
    expect(r.events[0].statement).toBe('a statement whose record could not be read')
  })

  it('stops at the page cap and says the count is a floor', async () => {
    const list = async () => ({ keys: [{ name: `${CANCELLATION_KEY_PREFIX}x`, metadata: { s: 'HEAD x', at: 1 } }], list_complete: false, cursor: 'more' })
    const r = await readCancellations({ list, put: async () => {} })
    expect(r.events).toHaveLength(CANCELLATION_LIST_PAGE_CAP)
    expect(r.truncated).toBe(true)
  })
})
