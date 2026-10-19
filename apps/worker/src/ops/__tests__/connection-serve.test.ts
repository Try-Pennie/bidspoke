/**
 * The tick's half of the serve (#2335, PR 6 of phase 5 of #1689): what it does
 * with the ops connections the bidding Worker served. Removals first, through
 * record_connection_tombstone, so a copy a removal covers is gone before any
 * list could be read as restoring it; then the copies, through
 * save_connection_copies, complete only when one save carries the whole list.
 * Every failure is reported by name and stops nothing else; a failed fetch
 * saves nothing, so each copy keeps the serve_until it was last served with.
 *
 * The database functions are proven against a real Postgres in
 * supabase-ops/supabase/tests/connection_storage.test.sql.
 */
import { describe, expect, it } from 'vitest'
import { CONNECTION_SERVE_WINDOW_MS } from '../../lib/ops-gateway-contract'
import { saveServedConnections, type ConnectionServeDb } from '../connection-serve'
import { OpsWriteTimeoutError, MAX_COPIES_PER_SAVE, type ConnectionCopyInput, type SaveConnectionCopiesResult } from '../ops-writes'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '00000000-0000-4000-8000-0000000023c1'
const GONE = '00000000-0000-4000-8000-0000000023c2'
const SERVED_AT = '2026-10-18T22:00:00.000Z'
const UNTIL = new Date(Date.parse(SERVED_AT) + CONNECTION_SERVE_WINDOW_MS).toISOString()
const envelope = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA==' }

const connection = (over: Record<string, unknown> = {}) => ({
  id: CONN, organization_id: ORG, service: 'salesforce', generation: 2, envelope, public_config: { name: 'trypennie' },
  target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, serve_until: UNTIL, ...over,
})
const served = (connections: unknown[] = [connection()], tombstones: unknown[] = []) => ({ served_at: SERVED_AT, complete: true, connections, tombstones })

const ok = (n: number, over: Partial<SaveConnectionCopiesResult> = {}): SaveConnectionCopiesResult => ({
  inserted: n, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0, ...over,
})

function db(over: Partial<ConnectionServeDb> = {}) {
  const calls: string[] = []
  const saves: Array<{ servedAt: string; complete: boolean; copies: ConnectionCopyInput[] }> = []
  const removals: Array<{ org: string; connectionId: string; generation: number; removedAt: string }> = []
  const d: ConnectionServeDb = {
    async saveConnectionCopies(servedAt, complete, copies) {
      calls.push('save')
      saves.push({ servedAt, complete, copies: [...copies] })
      return ok(copies.length)
    },
    async recordConnectionTombstone(org, connectionId, generation, removedAt) {
      calls.push('tombstone')
      removals.push({ org, connectionId, generation, removedAt: removedAt.toISOString() })
      return { outcome: 'recorded', copiesRemoved: 1 }
    },
    ...over,
  }
  return { d, calls, saves, removals }
}

describe('saveServedConnections', () => {
  it('saves each served copy with the serve_until the bidding Worker set, ciphertext and public config only', async () => {
    const f = db()
    const r = await saveServedConnections(f.d, async () => served())
    expect(r.problems).toEqual([])
    expect(f.saves).toEqual([{
      servedAt: SERVED_AT, complete: true,
      copies: [{
        connectionId: CONN, organizationId: ORG, service: 'salesforce', generation: 2, envelope, publicConfig: { name: 'trypennie' },
        target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, serveUntil: UNTIL,
      }],
    }])
    expect(r.counts).toMatchObject({ connections_served: 1, connection_copies_saved: 1 })
  })

  it('records the removals before it saves the copies', async () => {
    const f = db()
    await saveServedConnections(f.d, async () => served([connection()], [{ connection_id: GONE, organization_id: ORG, generation: 3, removed_at: '2026-10-18T21:00:00.000Z' }]))
    expect(f.calls).toEqual(['tombstone', 'save'])
    expect(f.removals).toEqual([{ org: ORG, connectionId: GONE, generation: 3, removedAt: '2026-10-18T21:00:00.000Z' }])
  })

  it('saves an empty complete list, so ops withdraws the copies of connections that are no longer served', async () => {
    const f = db({ saveConnectionCopies: async (s, c, copies) => { f.saves.push({ servedAt: s, complete: c, copies: [...copies] }); return ok(0, { withdrawn: 2 }) } })
    const r = await saveServedConnections(f.d, async () => served([]))
    expect(f.saves).toEqual([{ servedAt: SERVED_AT, complete: true, copies: [] }])
    expect(r.counts.connection_copies_withdrawn).toBe(2)
  })

  it('saves nothing when the bidding Worker cannot be reached, so every copy keeps the serve_until it was last served with, and says so', async () => {
    const f = db()
    const r = await saveServedConnections(f.d, async () => { throw new Error('the bidding Worker\'s connection list did not answer within 15 s') })
    expect(f.calls).toEqual([])
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0].text).toMatch(/could not fetch the ops connections .*15 s.*serve_until.*6 hours/)
  })

  it('reports a list it cannot read and saves nothing', async () => {
    const f = db()
    const r = await saveServedConnections(f.d, async () => ({ served_at: SERVED_AT }))
    expect(f.calls).toEqual([])
    expect(r.problems[0].text).toMatch(/connection list could not be read/)
  })

  it('reports each refused row by name, saves the rest, and withdraws nothing', async () => {
    const f = db()
    const r = await saveServedConnections(f.d, async () => served([connection(), connection({ id: GONE, public_config: { client_secret: 'x' } })]))
    expect(f.saves[0].complete).toBe(false)
    expect(f.saves[0].copies.map((c) => c.connectionId)).toEqual([CONN])
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0].text).toMatch(new RegExp(`${GONE}.*client_secret`))
    // A row refused by its shape is a defect, which the bidding Worker pages at once (#2506).
    expect(r.problems[0].key).toBe('connection_refused')
  })

  it('reports copies that arrived already past their serve_until, which no ops step may use', async () => {
    const f = db({ saveConnectionCopies: async () => ok(0, { refusedExpired: 1 }) })
    const r = await saveServedConnections(f.d, async () => served())
    expect(r.problems[0].text).toMatch(/1 served connection copy arrived already past its serve_until/)
    expect(r.problems[0].key).toBe('connection_copies_expired')
  })

  it('counts a lower generation and a removed one without paging: each is the database keeping a newer state', async () => {
    const f = db({ saveConnectionCopies: async () => ok(0, { refusedOlder: 1, refusedRemoved: 1 }) })
    const r = await saveServedConnections(f.d, async () => served())
    expect(r.problems).toEqual([])
    expect(r.counts).toMatchObject({ connection_copies_refused_older: 1, connection_copies_refused_removed: 1 })
  })

  it('reports a failed save, and a failed removal, each by name, and the one does not stop the other', async () => {
    const f = db({
      recordConnectionTombstone: async () => { throw new OpsWriteTimeoutError('record_connection_tombstone passed its 9000 ms deadline and may still have committed') },
      saveConnectionCopies: async () => { throw new OpsWriteTimeoutError('save_connection_copies passed its 9000 ms deadline and may still have committed') },
    })
    const r = await saveServedConnections(f.d, async () => served([connection()], [{ connection_id: GONE, organization_id: ORG, generation: 3, removed_at: '2026-10-18T21:00:00.000Z' }]))
    expect(r.problems).toHaveLength(2)
    expect(r.problems[0].text).toMatch(new RegExp(`removal of connection ${GONE}.*record_connection_tombstone`))
    expect(r.problems[1].text).toMatch(/could not save the connections it fetched.*save_connection_copies/)
  })

  it('saves a list longer than one save carries in parts, and then withdraws nothing', async () => {
    const f = db()
    const many = Array.from({ length: MAX_COPIES_PER_SAVE + 1 }, (_, i) => connection({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    const r = await saveServedConnections(f.d, async () => served(many))
    expect(f.saves.map((s) => [s.copies.length, s.complete])).toEqual([[MAX_COPIES_PER_SAVE, false], [1, false]])
    expect(r.problems[0].text).toMatch(/more than one save carries/)
    expect(r.problems[0].key).toBe('connections_too_many')
  })
})
