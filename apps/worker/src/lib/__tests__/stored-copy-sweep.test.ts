import { describe, expect, it, vi } from 'vitest'
import { sweepSources, sweepStoredCopies, type SweepSources } from '../stored-copy-sweep'
import { endpointHotKey, endpointLastGoodKey } from '../endpoint-copies'
import { partnerLastGoodKey } from '../partner-last-good'
import { workflowCopyKey } from '../../engine/definition-loader'

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
  const kv = {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      if (failDeletes.has(key)) throw new Error(`KV refused ${key}`)
      store.delete(key)
    },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
      const start = opts.cursor ? Number(opts.cursor) : 0
      const page = names.slice(start, start + 2)
      const done = start + 2 >= names.length
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 2) }
    },
  }
  return { kv: kv as unknown as KVNamespace, store }
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
    ...over,
  }
}

describe('sweepStoredCopies: endpoint copies', () => {
  it('keeps a copy that matches its row', async () => {
    const { kv, store } = memoryKv({ [endpointLastGoodKey('engine', '/bidding')]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources({ endpoints: async () => [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: true }] }))
    expect(store.has(endpointLastGoodKey('engine', '/bidding'))).toBe(true)
    expect(r.repaired).toEqual([])
  })

  it.each([
    ['deleted', []],
    ['switched off', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: false }]],
    ['pointed at another workflow', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-2', source_name: 'engine', is_active: true }]],
    ['given another source name', [{ id: 'ep-1', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine-2', is_active: true }]],
    ['replaced by a new endpoint at the same address', [{ id: 'ep-2', subdomain: 'engine', path: '/bidding', workflow_id: 'wf-1', source_name: 'engine', is_active: true }]],
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

  // A key the key builder cannot produce has no address to clear, so it is
  // reported, never parsed into a guess at one and deleted.
  it('reports a malformed endpoint key rather than clearing a guessed address', async () => {
    const { kv, store } = memoryKv({ 'ep-lastgood:nocolon': endpointCopy(), [endpointHotKey('nocolo', '')]: endpointCopy() })
    const r = await sweepStoredCopies(kv, sources())
    expect(store.has('ep-lastgood:nocolon')).toBe(true)
    expect(store.has(endpointHotKey('nocolo', ''))).toBe(true)
    expect(r.repaired).toEqual([])
    expect(r.failed).toEqual([expect.stringMatching(/ep-lastgood:nocolon.*not an endpoint address/)])
  })

  it('reads an address whose path itself holds a colon', async () => {
    const { kv, store } = memoryKv({ [endpointLastGoodKey('engine', '/a:b')]: endpointCopy() })
    await sweepStoredCopies(kv, sources({ endpoints: async () => [{ id: 'ep-1', subdomain: 'engine', path: '/a:b', workflow_id: 'wf-1', source_name: 'engine', is_active: true }] }))
    expect(store.has(endpointLastGoodKey('engine', '/a:b'))).toBe(true)
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

describe('sweepSources', () => {
  it('pages the endpoint read past the 1,000 row answer limit', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `ep-${String(i).padStart(4, '0')}`, subdomain: 's', path: `/${i}`, workflow_id: 'wf', source_name: 'x', is_active: true }))
    const { db, calls } = fakeDb({ webhook_endpoints: rows })
    const got = await sweepSources(db as never, memoryKv().kv).endpoints()
    expect(got).toHaveLength(1001)
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
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
