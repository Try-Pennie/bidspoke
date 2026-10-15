import { describe, expect, it, vi } from 'vitest'
import { sweepSources, sweepStoredCopies, type SweepSources } from '../stored-copy-sweep'
import { endpointHotKey, endpointLastGoodKey } from '../endpoint-copies'
import { partnerLastGoodKey } from '../partner-last-good'
import { bidMatrixLastGoodKey } from '../bid-matrix-lookup'
import { workflowCopyKey } from '../../engine/definition-loader'
import { STORED_COPY_RECONFIRM_AFTER_MS } from '../stored-copy-age'

/**
 * The stored copy sweep (#1846). An edit route clears a stored outage copy right
 * after its write, and when KV refuses that clear the route says so and carries
 * on. Saving again cannot always repeat the clear (a deleted row is gone, a
 * created endpoint answers 409, a re-applied rename finds nothing to rewrite),
 * so the per minute cron compares every copy with its row and repairs the ones
 * that disagree. These tests drive it over an in-memory KV that pages its
 * listing two keys at a time, so a sweep that reads only the first page fails.
 */
function memoryKv(initial: Record<string, string> = {}, failDeletes: Set<string> = new Set()) {
  const store = new Map(Object.entries(initial))
  // The metadata each put carried: a copy's confirmation time (#1847).
  const meta = new Map<string, unknown>()
  const puts: string[] = []
  const kv = {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    async getWithMetadata(key: string) {
      return { value: store.has(key) ? store.get(key)! : null, metadata: meta.get(key) ?? null }
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      puts.push(key)
      store.set(key, value)
      meta.set(key, opts?.metadata ?? null)
    },
    async delete(key: string) {
      if (failDeletes.has(key)) throw new Error(`KV refused ${key}`)
      store.delete(key)
      meta.delete(key)
    },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
      const start = opts.cursor ? Number(opts.cursor) : 0
      const page = names.slice(start, start + 2)
      const done = start + 2 >= names.length
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 2) }
    },
  }
  return { kv: kv as unknown as KVNamespace, store, meta, puts }
}

const endpointCopy = (over: Partial<{ id: string; workflow_id: string; source_name: string; is_active: boolean }> = {}) =>
  JSON.stringify({ id: 'ep-1', workflow_id: 'wf-1', source_name: 'engine', is_active: true, auth_method: 'api_key', ...over })

const workflowCopy = (rowUpdatedAt: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ is_active: true, lane: 'live', workflow_version_id: 'v1', version_number: 1, row_updated_at: rowUpdatedAt, written_at: '2026-10-07T12:00:00.000Z', workflow: { id: 'wf-1' }, ...over })

function sources(over: Partial<SweepSources> = {}): SweepSources {
  return {
    endpoints: async () => [],
    partners: async () => [],
    workflows: async () => [],
    refreshWorkflow: vi.fn(async () => {}),
    bidMatrix: async () => null,
    ...over,
  }
}

/**
 * Bid matrix copies (#1849): a matrix has no single stamp that moves when a row
 * changes, so the sweep reads each held copy's config and rows through the
 * lookup's own reader and compares the content, every run.
 */
describe('sweepStoredCopies: bid matrix copies (#1849)', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z')
  const now = () => NOW
  const stamp = (ageMs: number) => ({ confirmed_at: new Date(NOW - ageMs).toISOString() })
  const matrix = (bid: number) => ({ config: { id: 'c-1', is_active: true, dimensions: [], last_synced_at: null }, rows: [{ id: 'r1', is_sell_off: false, row_id: null, row_low: 0, row_high: null, range_low: null, range_high: null, bid_amount: bid }] })
  const OFFER = bidMatrixLastGoodKey('c-1', false)
  const SELL_OFF = bidMatrixLastGoodKey('c-1', true)

  it('rewrites a copy whose matrix changed, stamped now, and reads each side as its own', async () => {
    const { kv, store, meta } = memoryKv({ [OFFER]: JSON.stringify(matrix(25)), [SELL_OFF]: JSON.stringify(matrix(5)) })
    meta.set(OFFER, stamp(60_000))
    meta.set(SELL_OFF, stamp(60_000))
    const bidMatrix = vi.fn(async (_id: string, sellOff: boolean) => (sellOff ? matrix(5) : matrix(30)))
    const r = await sweepStoredCopies(kv, sources({ bidMatrix }), { now })
    expect(bidMatrix.mock.calls.map((c) => c.slice(0, 2)).sort()).toEqual([['c-1', false], ['c-1', true]])
    expect(JSON.parse(store.get(OFFER)!)).toEqual(matrix(30))
    expect(meta.get(OFFER)).toEqual({ confirmed_at: new Date(NOW).toISOString() })
    expect(r.repaired).toEqual([OFFER])
    // The unchanged side, confirmed a minute ago, is left as it is.
    expect(meta.get(SELL_OFF)).toEqual(stamp(60_000))
  })

  it('confirms an unchanged copy that is due, and writes nothing for one confirmed inside the interval', async () => {
    const { kv, meta, puts } = memoryKv({ [OFFER]: JSON.stringify(matrix(25)), [SELL_OFF]: JSON.stringify(matrix(5)) })
    meta.set(OFFER, stamp(STORED_COPY_RECONFIRM_AFTER_MS))
    meta.set(SELL_OFF, stamp(STORED_COPY_RECONFIRM_AFTER_MS - 1))
    const r = await sweepStoredCopies(kv, sources({ bidMatrix: async (_id, sellOff) => (sellOff ? matrix(5) : matrix(25)) }), { now })
    expect(r.reconfirmed).toEqual([OFFER])
    expect(puts).toEqual([OFFER])
  })

  it('removes the copy of a config that is gone', async () => {
    const { kv, store } = memoryKv({ [OFFER]: JSON.stringify(matrix(25)) })
    const r = await sweepStoredCopies(kv, sources({ bidMatrix: async () => null }), { now })
    expect(store.has(OFFER)).toBe(false)
    expect(r.repaired).toEqual([OFFER])
  })

  it('leaves a copy alone when its matrix cannot be read, names it, and sweeps the rest', async () => {
    const other = bidMatrixLastGoodKey('c-2', false)
    const { kv, store } = memoryKv({ [OFFER]: JSON.stringify(matrix(25)), [other]: JSON.stringify(matrix(1)) })
    const r = await sweepStoredCopies(kv, sources({ bidMatrix: async (id) => { if (id === 'c-1') throw new Error('database down'); return null } }), { now })
    expect(store.get(OFFER)).toBe(JSON.stringify(matrix(25)))
    expect(store.has(other)).toBe(false)
    expect(r.failed).toEqual([expect.stringMatching(/bid-matrix-lastgood:c-1:offer.*database down/)])
  })

  it('deletes a key it cannot parse exactly, since no lookup reads it', async () => {
    const odd = 'bid-matrix-lastgood:c-1:sideways'
    const { kv, store } = memoryKv({ [odd]: '{}' })
    await sweepStoredCopies(kv, sources(), { now })
    expect(store.has(odd)).toBe(false)
  })
})

describe('sweepStoredCopies: endpoint copies', () => {
  it('keeps a copy that matches its row', async () => {
    const { kv, store } = memoryKv({ [endpointLastGoodKey('engine', '/bidding')]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: true, trigger_auth_method: null }] }))
    expect(store.has(endpointLastGoodKey('engine', '/bidding'))).toBe(true)
    expect(r.repaired).toEqual([])
  })

  it.each([
    ['deleted', []],
    ['switched off', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: false, trigger_auth_method: null }]],
    ['pointed at another workflow', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-2', source_name: 'engine', is_active: true, trigger_auth_method: null }]],
    ['given another source name', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine-2', is_active: true, trigger_auth_method: null }]],
    ['replaced by a new endpoint at the same address', [{ id: 'ep-2', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: true, trigger_auth_method: null }]],
  ])('clears both copies of an endpoint %s', async (_why, rows) => {
    const { kv, store } = memoryKv({
      [endpointLastGoodKey('engine', '/bidding')]: endpointCopy(),
      [endpointHotKey('engine', '/bidding')]: endpointCopy(),
    })
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => rows }))
    expect(store.has(endpointLastGoodKey('engine', '/bidding'))).toBe(false)
    expect(store.has(endpointHotKey('engine', '/bidding'))).toBe(false)
    expect(r.repaired).toEqual([endpointLastGoodKey('engine', '/bidding')])
  })

  // A key the key builder cannot produce is never read by the endpoint route,
  // which always asks for <subdomain>:<path>. So it is deleted exactly, never
  // parsed into a guess at an address whose keys would be cleared instead, and
  // reported once rather than on every run.
  it('deletes a malformed endpoint key exactly, leaving every guessed address alone', async () => {
    const { kv, store } = memoryKv({ 'ep-lastgood:nocolon': endpointCopy(), [endpointHotKey('nocolo', '')]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources())
    expect(store.has('ep-lastgood:nocolon')).toBe(false)
    expect(store.has(endpointHotKey('nocolo', ''))).toBe(true)
    expect(r.repaired).toEqual(['ep-lastgood:nocolon'])
    expect(r.failed).toEqual([])
    expect((await sweepStoredCopies(kv, sources())).repaired).toEqual([])
  })

  it('reads an address whose path itself holds a colon', async () => {
    const { kv, store } = memoryKv({ [endpointLastGoodKey('engine', '/a:b')]: endpointCopy() })
    await sweepStoredCopies(kv, sources({ endpoints: async () => [{ id: 'ep-1', subdomain: 'engine', path: '/a:b', workflow_id: 'wf-1', source_name: 'engine', is_active: true, trigger_auth_method: null }] }))
    expect(store.has(endpointLastGoodKey('engine', '/a:b'))).toBe(true)
  })
})

/**
 * #1847: a copy is served for at most thirty minutes after it was last
 * confirmed. A busy address or partner is confirmed by its own lookups; the
 * sweep confirms the copy no lead has reached, once it is due, by rewriting it
 * stamped now. It confirms only what it compared: a copy that disagrees with its
 * row is cleared, never stamped.
 */
describe('sweepStoredCopies: confirming copies that agree with their rows (#1847)', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z')
  const now = () => NOW
  const stamp = (ageMs: number) => ({ confirmed_at: new Date(NOW - ageMs).toISOString() })
  const row = { id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: true, trigger_auth_method: null }
  const EP = endpointLastGoodKey('engine', '/bidding')

  it('rewrites a matching endpoint copy that is due, stamped now, with the value unchanged', async () => {
    const { kv, store, meta } = memoryKv({ [EP]: endpointCopy() })
    meta.set(EP, stamp(STORED_COPY_RECONFIRM_AFTER_MS))
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [row] }), { now })
    expect(JSON.parse(store.get(EP)!)).toEqual(JSON.parse(endpointCopy()))
    expect(meta.get(EP)).toEqual({ confirmed_at: new Date(NOW).toISOString() })
    expect(r.reconfirmed).toEqual([EP])
    expect(r.repaired).toEqual([])
  })

  it('confirms a matching endpoint copy written before copies carried a confirmation', async () => {
    const { kv, meta } = memoryKv({ [EP]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [row] }), { now })
    expect(meta.get(EP)).toEqual({ confirmed_at: new Date(NOW).toISOString() })
    expect(r.reconfirmed).toEqual([EP])
  })

  it('writes nothing for a matching copy confirmed inside the interval', async () => {
    const { kv, meta, puts } = memoryKv({ [EP]: endpointCopy() })
    meta.set(EP, stamp(STORED_COPY_RECONFIRM_AFTER_MS - 1))
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [row] }), { now })
    expect(puts).toEqual([])
    expect(r.reconfirmed).toEqual([])
  })

  it("clears, never confirms, a copy whose auth method is no longer the workflow trigger's", async () => {
    const { kv, store } = memoryKv({ [EP]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [{ ...row, trigger_auth_method: 'none' }] }), { now })
    expect(store.has(EP)).toBe(false)
    expect(r.repaired).toEqual([EP])
    expect(r.reconfirmed).toEqual([])
  })

  it('rewrites a current partner copy that is due, and leaves one confirmed inside the interval', async () => {
    const due = partnerLastGoodKey('p-due')
    const fresh = partnerLastGoodKey('p-fresh')
    const value = (id: string) => JSON.stringify({ id, updated_at: '2026-10-07T10:00:00+00:00', slug: id })
    const { kv, store, meta, puts } = memoryKv({ [due]: value('p-due'), [fresh]: value('p-fresh') })
    meta.set(due, stamp(STORED_COPY_RECONFIRM_AFTER_MS))
    meta.set(fresh, stamp(60_000))
    const r = await sweepStoredCopies(kv, sources({ partners: async () => [{ id: 'p-due', updated_at: '2026-10-07T10:00:00+00:00' }, { id: 'p-fresh', updated_at: '2026-10-07T10:00:00+00:00' }] }), { now })
    expect(r.reconfirmed).toEqual([due])
    expect(puts).toEqual([due])
    expect(store.get(due)).toBe(value('p-due'))
    expect(meta.get(due)).toEqual({ confirmed_at: new Date(NOW).toISOString() })
  })

  it('names a confirmation KV refuses, and carries on', async () => {
    const { kv, meta } = memoryKv({ [EP]: endpointCopy() })
    meta.set(EP, stamp(STORED_COPY_RECONFIRM_AFTER_MS))
    ;(kv as unknown as { put: () => Promise<void> }).put = async () => { throw new Error('KV write limit') }
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [row] }), { now })
    expect(r.failed).toEqual([expect.stringMatching(/ep-lastgood:engine:\/bidding.*KV write limit/)])
  })
})

describe('sweepStoredCopies: partner copies', () => {
  it('clears a copy whose partner is gone or has changed since, and keeps a current one', async () => {
    const { kv, store } = memoryKv({
      [partnerLastGoodKey('p-gone')]: JSON.stringify({ id: 'p-gone', updated_at: '2026-10-07T10:00:00+00:00' }),
      [partnerLastGoodKey('p-edited')]: JSON.stringify({ id: 'p-edited', updated_at: '2026-10-07T10:00:00+00:00' }),
      [partnerLastGoodKey('p-current')]: JSON.stringify({ id: 'p-current', updated_at: '2026-10-07T10:00:00+00:00' }),
    })
    const partners = vi.fn(async () => [
      { id: 'p-edited', updated_at: '2026-10-07T11:00:00+00:00' },
      { id: 'p-current', updated_at: '2026-10-07T10:00:00+00:00' },
    ])
    const r = await sweepStoredCopies(kv, sources({ partners }))
    expect(partners).toHaveBeenCalledWith(['p-current', 'p-edited', 'p-gone'])
    expect([...store.keys()]).toEqual([partnerLastGoodKey('p-current')])
    expect(r.repaired.sort()).toEqual([partnerLastGoodKey('p-edited'), partnerLastGoodKey('p-gone')])
  })
})

describe('sweepStoredCopies: workflow definition copies', () => {
  it('refreshes a copy older than its row, or whose row is gone, and leaves a current one', async () => {
    const { kv } = memoryKv({
      [workflowCopyKey('wf-old')]: workflowCopy('2026-10-07T10:00:00.000001+00:00'),
      [workflowCopyKey('wf-gone')]: workflowCopy('2026-10-07T10:00:00+00:00'),
      [workflowCopyKey('wf-current')]: workflowCopy('2026-10-07T10:00:00+00:00'),
    })
    const refreshWorkflow = vi.fn(async (_id: string) => {})
    const r = await sweepStoredCopies(kv, sources({
      refreshWorkflow,
      workflows: async () => [
        // One microsecond later: a save the route's refresh missed.
        { id: 'wf-old', updated_at: '2026-10-07T10:00:00.000002+00:00' },
        { id: 'wf-current', updated_at: '2026-10-07T10:00:00+00:00' },
      ],
    }))
    expect(refreshWorkflow.mock.calls.map(([id]) => id).sort()).toEqual(['wf-gone', 'wf-old'])
    expect(r.repaired.sort()).toEqual([workflowCopyKey('wf-gone'), workflowCopyKey('wf-old')])
  })

  // A stamp that does not parse compares false against everything (L50), which
  // would keep the copy; an unreadable row stamp refreshes it instead.
  it('refreshes a copy whose row stamp cannot be read', async () => {
    const { kv } = memoryKv({ [workflowCopyKey('wf-1')]: workflowCopy('2026-10-07T10:00:00+00:00') })
    const refreshWorkflow = vi.fn(async (_id: string) => {})
    await sweepStoredCopies(kv, sources({ refreshWorkflow, workflows: async () => [{ id: 'wf-1', updated_at: 'not a time' }] }))
    expect(refreshWorkflow).toHaveBeenCalledWith('wf-1')
  })

  it('refreshes a copy marked unverified even when its stamp matches', async () => {
    const { kv } = memoryKv({ [workflowCopyKey('wf-1')]: workflowCopy('2026-10-07T10:00:00+00:00', { unverified: true }) })
    const refreshWorkflow = vi.fn(async (_id: string) => {})
    await sweepStoredCopies(kv, sources({ refreshWorkflow, workflows: async () => [{ id: 'wf-1', updated_at: '2026-10-07T10:00:00+00:00' }] }))
    expect(refreshWorkflow).toHaveBeenCalledWith('wf-1')
  })
})

describe('sweepStoredCopies: failures', () => {
  it('leaves every copy of a kind alone when its rows cannot be read, and says so', async () => {
    const { kv, store } = memoryKv({ [partnerLastGoodKey('p-1')]: JSON.stringify({ id: 'p-1', updated_at: 'x' }) })
    const r = await sweepStoredCopies(kv, sources({ partners: async () => { throw new Error('database down') } }))
    expect(store.has(partnerLastGoodKey('p-1'))).toBe(true)
    expect(r.failed).toEqual([expect.stringMatching(/partner copies.*database down/)])
  })

  it('carries on past a copy KV will not clear, naming it, so the next run retries it', async () => {
    const stuck = partnerLastGoodKey('p-stuck')
    const { kv, store } = memoryKv({ [stuck]: '{"id":"p-stuck"}', [partnerLastGoodKey('p-gone')]: '{"id":"p-gone"}' }, new Set([stuck]))
    const r = await sweepStoredCopies(kv, sources())
    expect(store.has(partnerLastGoodKey('p-gone'))).toBe(false)
    expect(r.failed).toEqual([expect.stringMatching(/p-stuck.*KV refused/)])
  })

  it('still sweeps the other kinds when one kind fails', async () => {
    const { kv, store } = memoryKv({ [endpointLastGoodKey('engine', '/x')]: endpointCopy() })
    await sweepStoredCopies(kv, sources({ partners: async () => { throw new Error('down') } }))
    expect(store.has(endpointLastGoodKey('engine', '/x'))).toBe(false)
  })
})

/**
 * The rows come from the database through sweepSources. PostgREST answers at
 * most 1,000 rows a request, so the endpoint read pages by id, and the id lists
 * are sent in chunks; a failed read throws, so the sweep leaves that kind alone.
 */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>, failing: Set<string> = new Set()) {
  const calls: Array<{ table: string; range?: [number, number]; ids?: string[] }> = []
  const db = {
    from(table: string) {
      const call: { table: string; range?: [number, number]; ids?: string[] } = { table }
      calls.push(call)
      const q = {
        select: () => q,
        order: () => q,
        range: (a: number, b: number) => { call.range = [a, b]; return q },
        in: (_col: string, ids: string[]) => { call.ids = ids; return q },
        then: (resolve: (v: unknown) => void) => {
          if (failing.has(table)) return resolve({ data: null, error: { message: `${table} read failed` } })
          let rows = tables[table] ?? []
          if (call.ids) rows = rows.filter((r) => call.ids!.includes(r.id as string))
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1)
          resolve({ data: rows, error: null })
        },
      }
      return q
    },
  }
  return { db, calls }
}

/**
 * One deadline for the whole sweep (#2058). A KV call cannot be aborted, so
 * the sweep checks the clock between copies and issues no further call once
 * past it. Each KV read here moves an injected clock on 10 s (L524).
 */
describe('sweepStoredCopies: its deadline (#2058)', () => {
  const START = Date.parse('2026-10-14T21:40:00Z')
  const fresh = { confirmed_at: new Date(START).toISOString() }
  function slowKv(keys: string[]) {
    let t = START
    const { kv, meta } = memoryKv(Object.fromEntries(keys.map((k) => [k, JSON.stringify({ updated_at: 'u1' })])))
    for (const k of keys) meta.set(k, fresh)
    const reads: string[] = []
    const inner = kv as unknown as { getWithMetadata: (k: string) => Promise<unknown> }
    const read = inner.getWithMetadata.bind(inner)
    inner.getWithMetadata = async (k: string) => { reads.push(k); t += 10_000; return read(k) }
    return { kv, reads, now: () => t }
  }
  const partnerKeys = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((id) => partnerLastGoodKey(id))
  const partnersAgree = sources({ partners: async (ids) => ids.map((id) => ({ id, updated_at: 'u1' })) })

  it('stops starting reads once past its deadline, and says how far it got', async () => {
    const { kv, reads, now } = slowKv([...partnerKeys, workflowCopyKey('wf-1')])
    const r = await sweepStoredCopies(kv, partnersAgree, { now, deadlineAt: START + 25_000 })
    // Reads at 10, 20 and 30 s: the third began before the deadline, none after it.
    expect(reads).toEqual(partnerKeys.slice(0, 3))
    expect(r.stopped).toBe('deadline')
    expect(r.checked).toBe(3)
    expect(r.left).toBe(2)
    expect(r.notReached).toEqual(['workflow definition copies', 'bid matrix copies'])
    // Not a clean run: the stretch of failed sweeps goes on until one finishes.
    expect(r.failed).toEqual([expect.stringMatching(/stopped at its deadline with 2 partner copies left, and did not reach workflow definition copies or bid matrix copies/)])
  })

  it('sweeps everything, and reports no stop, when the deadline is not reached', async () => {
    const { kv, reads, now } = slowKv(partnerKeys)
    const r = await sweepStoredCopies(kv, partnersAgree, { now, deadlineAt: START + 10 * 60_000 })
    expect(reads).toEqual(partnerKeys)
    expect(r.stopped).toBeUndefined()
    expect(r.failed).toEqual([])
  })
})

describe('sweepSources', () => {
  it('pages the endpoint read past the 1,000 row answer limit', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `ep-${String(i).padStart(4, '0')}`, subdomain: 's', path: `/${i}`, workflow_id: 'wf', source_name: 'x', is_active: true, workflows: { auth_method: null } }))
    const { db, calls } = fakeDb({ webhook_endpoints: rows })
    const got = await sweepSources(db as never, memoryKv().kv).endpoints()
    expect(got).toHaveLength(1001)
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it("hands each endpoint row its workflow trigger's auth method, read as one field rather than the whole definition (#1847)", async () => {
    const selects: string[] = []
    const { db } = fakeDb({ webhook_endpoints: [{ id: 'ep-1', subdomain: 's', path: '/', workflow_id: 'wf', source_name: 'x', is_active: true, workflows: { auth_method: 'none' } }] })
    const from = db.from.bind(db)
    db.from = (table: string) => {
      const q = from(table) as unknown as { select: (cols: string) => unknown }
      const select = q.select
      q.select = (cols: string) => { selects.push(cols); return select(cols) }
      return q as never
    }
    const [got] = await sweepSources(db as never, memoryKv().kv).endpoints()
    expect(got).toEqual({ id: 'ep-1', subdomain: 's', path: '/', workflow_id: 'wf', source_name: 'x', is_active: true, trigger_auth_method: 'none' })
    expect(selects[0]).toContain('workflows!inner(auth_method:definition->trigger->config->>auth_method)')
    expect(selects[0]).not.toMatch(/\(definition\)/)
  })

  it('reads partners and workflows by id in chunks of 100', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `p-${i}`)
    const { db, calls } = fakeDb({ partner_configs: ids.map((id) => ({ id, updated_at: 't' })) })
    expect(await sweepSources(db as never, memoryKv().kv).partners(ids)).toHaveLength(150)
    expect(calls.map((c) => c.ids?.length)).toEqual([100, 50])
  })

  it.each(['webhook_endpoints', 'partner_configs', 'workflows'])('throws when %s cannot be read', async (table) => {
    const { db } = fakeDb({}, new Set([table]))
    const s = sweepSources(db as never, memoryKv().kv)
    const read = table === 'webhook_endpoints' ? s.endpoints() : table === 'partner_configs' ? s.partners(['a']) : s.workflows(['a'])
    await expect(read).rejects.toThrow(`${table} read failed`)
  })
})
