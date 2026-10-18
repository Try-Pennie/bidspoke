/**
 * PR 6 of #2335's done line (plan: discussion #2329, part 2): with the bidding
 * Worker unreachable, a copy past serve_until is refused with
 * connection_copy_expired.
 *
 * End to end through the real pieces: the bidding Worker's readOpsConnections
 * (over a PostgREST double holding one sealed ops_key row) serves the list, the
 * real ops tick saves it, the bidding Worker then stops answering, the tick
 * keeps running and saves nothing, and the real connectionFetch reads the copy.
 * The ops database is an in-memory double of save_connection_copies and
 * connection_copy that keeps only what this needs: a copy's serve_until as
 * saved, and its state read in connection_copy's order on the database's clock.
 * Those two functions are proven against a real Postgres in
 * supabase-ops/supabase/tests/connection_storage.test.sql (section C, a copy
 * past serve_until reads as connection_copy_expired).
 */
import { createClient } from '@supabase/supabase-js'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import { readOpsConnections } from '../../lib/ops-gateway'
import { connectionFetch } from '../connections/connection-fetch'
import { ConnectionRefusal } from '../connections/refusals'
import { CONN, ORG, T0, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, type TestKeys } from '../connections/__tests__/harness'
import type { OrganizationId } from '../ops-db'
import type { ConnectionCopy, ConnectionCopyInput, SaveConnectionCopiesResult } from '../ops-writes'
import { runOpsTick, type OpsTickDb, type OpsTickPorts } from '../tick'

const H = 60 * 60 * 1000

let keys: TestKeys
let envelope: SealedEnvelope
beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys)
}, 120_000)

/** One clock for both Workers and the ops database, moved by the test. */
const clock = { value: T0 }

/** The bidding database: one ops connection, sealed to the ops key. */
function biddingDb() {
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const table = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/', '')
    if (table === 'service_connections') {
      return Response.json([{
        id: CONN, organization_id: ORG, service_type: 'example', sealed_for: 'ops_key', credential_generation: 1,
        credential_enc: JSON.stringify(envelope), config: {}, target: { host: 'api.example.test' },
      }])
    }
    return Response.json([])
  }) as typeof globalThis.fetch
  return createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never)
}

interface Kept { input: ConnectionCopyInput; servedAt: string }

/** The ops database: the copies, and the minimum of every other function the tick calls. */
function opsDb() {
  const copies = new Map<string, Kept>()
  const db: OpsTickDb = {
    now: async () => new Date(clock.value).toISOString(),
    // Every sweep stands down: this test is about the copies.
    claimSweep: async () => ({ owned: false, lastStartedAt: null, lastOwner: 'another-tick' }),
    sweepLeases: async () => { throw new Error('not claimed') },
    expireRuns: async () => { throw new Error('not claimed') },
    queueDisagreements: async () => [],
    saveCopies: async () => ({ inserted: 0, updated: 0, confirmed: 0, refusedOlder: 0, withdrawn: 0 }),
    readCopies: async () => ({ copies: [], reachedLimit: false }),
    recordObservation: async () => 'recorded',
    dueQueueDepth: async () => ({ dueRuns: 0, dueWorkflows: 0, oldestDue: null }),
    async saveConnectionCopies(servedAt, _complete, list): Promise<SaveConnectionCopiesResult> {
      const r = { inserted: 0, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0 }
      for (const c of list) {
        if (Date.parse(c.serveUntil) <= clock.value) { r.refusedExpired++; continue }
        const old = copies.get(c.connectionId)
        if (old && old.input.generation > c.generation) { r.refusedOlder++; continue }
        copies.set(c.connectionId, { input: c, servedAt })
        if (old) r.confirmed++
        else r.inserted++
      }
      return r
    },
    recordConnectionTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 0 }),
  }
  /** connection_copy: not_found, then serve_until on the database's clock, else usable. */
  const readCopy = async (_org: OrganizationId, connectionId: string): Promise<ConnectionCopy> => {
    const kept = copies.get(connectionId)
    if (!kept) return { ...usableCopy(envelope), state: 'not_found', envelope: null, dbNow: new Date(clock.value).toISOString() }
    const expired = Date.parse(kept.input.serveUntil) <= clock.value
    return {
      state: expired ? 'connection_copy_expired' : 'usable',
      connectionId,
      service: kept.input.service,
      generation: kept.input.generation,
      envelope: expired ? null : kept.input.envelope,
      publicConfig: kept.input.publicConfig,
      target: kept.input.target,
      servedAt: kept.servedAt,
      serveUntil: kept.input.serveUntil,
      dbNow: new Date(clock.value).toISOString(),
    }
  }
  return { db, readCopy, copies }
}

function ports(db: OpsTickDb, fetchConnections: () => Promise<unknown>): OpsTickPorts {
  return {
    tickId: `tick-${clock.value}`,
    scheduledTime: clock.value,
    now: () => clock.value,
    db,
    checkSecrets: async () => [],
    gateway: {
      fetchWorkflows: async () => ({ served_at: new Date(clock.value).toISOString(), complete: true, workflows: [] }),
      fetchConnections,
      started: async () => {},
      completed: async () => {},
    },
    dispatch: async () => {},
  }
}

describe('with the bidding Worker unreachable, a copy past serve_until is refused with connection_copy_expired', () => {
  it('serves until 6 hours after the last serve, then refuses by name and sends nothing', async () => {
    clock.value = T0
    const ops = opsDb()
    const bidding = biddingDb()

    // The minute the bidding Worker last answered.
    const served = await runOpsTick(ports(ops.db, () => readOpsConnections(bidding, clock.value)))
    expect(served.problems).toEqual([])
    expect(ops.copies.get(CONN)?.input.serveUntil).toBe(new Date(T0 + 6 * H).toISOString())

    // Then it stops answering, and the tick goes on every minute without it.
    const down = async () => { throw new Error('the bidding Worker\'s connection list did not answer within 15 s') }
    for (const at of [T0 + 60_000, T0 + 3 * H, T0 + 6 * H - 60_000]) {
      clock.value = at
      const report = await runOpsTick(ports(ops.db, down))
      expect(report.problems).toContainEqual(expect.stringMatching(/could not fetch the ops connections/))
    }
    // Nothing renewed it: the copy still ends where the last serve put it.
    expect(ops.copies.get(CONN)?.input.serveUntil).toBe(new Date(T0 + 6 * H).toISOString())

    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.deps.readCopy = ops.readCopy
    const call = { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' as const }, purpose: 'lookup' as const, record: { recordsNothing: 'this test' } }

    // A minute before serve_until the copy still serves.
    clock.value = T0 + 6 * H - 60_000
    d.now.value = clock.value
    const answered = await connectionFetch(d.deps, call, 'https://api.example.test/x')
    expect((answered as Response).status).toBe(200)
    expect(d.rec.events).toContain('send')

    // At serve_until, still with no answer from the bidding Worker, it is refused by name before anything is opened or sent.
    clock.value = T0 + 6 * H
    d.now.value = clock.value
    d.rec.events.length = 0
    const err = await connectionFetch(d.deps, call, 'https://api.example.test/x').then(
      () => { throw new Error('the expired copy was used') },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConnectionRefusal)
    expect((err as ConnectionRefusal).code).toBe('connection_copy_expired')
    expect(d.rec.events).toEqual([])
  })

  it('a serve that arrives after the outage renews the copy, so the window is measured from the last serve, not the first', async () => {
    clock.value = T0
    const ops = opsDb()
    const bidding = biddingDb()
    await runOpsTick(ports(ops.db, () => readOpsConnections(bidding, clock.value)))
    clock.value = T0 + 5 * H
    await runOpsTick(ports(ops.db, () => readOpsConnections(bidding, clock.value)))
    expect(ops.copies.get(CONN)?.input.serveUntil).toBe(new Date(T0 + 11 * H).toISOString())
  })
})
