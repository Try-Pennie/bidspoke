/**
 * Findings F116 and F126, finished (#2335, PR 8 of phase 5 of #1689; plan:
 * discussion #2329, part 2).
 *
 * The finding: a Reconnect used to write the new generation's envelope into
 * connection_copies before bidding's compare and set committed it. A failed
 * verify then left ops holding a bad credential it would not give up (every
 * later serve of the committed row refused as a lower generation), and a lost
 * compare and set left ops running on a credential the one home never
 * committed (L5, L33, L83).
 *
 * The fix: verify and clearReauth take the candidate in the call, use it for
 * that one call only, and write NO copy (OpsConnectionsDeps has no copy writer
 * at all); the committed copy arrives only by a serve of the committed row
 * (connection-serve.ts). These tests run the whole round: a serve of generation
 * N, a Reconnect with N+1 through clearReauth, then the next serve and the steps
 * that follow, through the real connectionFetch, the real seal, the real
 * Salesforce minter and the real serve, over an in-memory ops database that
 * keeps the one rule that matters here (save_connection_copies refuses a lower
 * generation; proven against Postgres in connection_storage.test.sql and
 * ops_connections_entrypoint.test.sql).
 *
 * F126's three tests: (1) a reconnect whose verify fails leaves ops serving
 * generation N and steps keep running; (2) a reconnect whose bidding compare and
 * set loses leaves ops accepting the next serve of the committed row; (3) a
 * plain Reconnect after a failed one is not refused as an older generation.
 * F116's: the compare and set fails after clearReauth answered, the next serve's
 * generation N wins on ops, and the N+1 envelope is never used.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import type { SealedCandidate } from '../../../lib/ops-connections-contract'
import { saveServedConnections, type ConnectionServeDb } from '../../connection-serve'
import type { ConnectionCopy, ConnectionCopyInput, SaveConnectionCopiesResult } from '../../ops-writes'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import { clearReauth, verifyConnection, type OpsConnectionsDeps } from '../ops-connections'
import { salesforceServiceEntry } from '../salesforce-service'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from './harness'
import { tokenEndpoint, type TokenEndpoint } from '../minters/__tests__/minter-harness'

const WF = '44444444-4444-4444-8444-444444444444'
const TARGET = { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-app-client' }
const COMMITTED_SECRET = 'plain-committed-client-secret'
const CANDIDATE_SECRET = 'plain-candidate-client-secret'
const DATA_URL = 'https://trypennie.my.salesforce.com/services/data/v60.0/query?q=SELECT+Id+FROM+Account'

let keys: TestKeys
let generationN: SealedEnvelope
let generationNext: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  generationN = await sealLogin(keys, { service: 'salesforce', generation: 1, plaintext: JSON.stringify({ client_id: TARGET.client_id, client_secret: COMMITTED_SECRET }) })
  generationNext = await sealLogin(keys, { service: 'salesforce', generation: 2, plaintext: JSON.stringify({ client_id: TARGET.client_id, client_secret: CANDIDATE_SECRET }) })
}, 120_000)

/** The ops database's copies: connection_copy and save_connection_copies, keeping the generation rule. */
function opsCopies(clock: () => number) {
  let kept: { input: ConnectionCopyInput; servedAt: string } | null = null
  const saves: Array<{ generation: number; outcome: 'saved' | 'refused_older' }> = []
  const db: ConnectionServeDb = {
    async saveConnectionCopies(servedAt, _complete, list): Promise<SaveConnectionCopiesResult> {
      const r = { inserted: 0, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0 }
      for (const c of list) {
        if (kept && kept.input.generation > c.generation) {
          r.refusedOlder++
          saves.push({ generation: c.generation, outcome: 'refused_older' })
          continue
        }
        if (kept) r.confirmed++
        else r.inserted++
        kept = { input: c, servedAt }
        saves.push({ generation: c.generation, outcome: 'saved' })
      }
      return r
    },
    recordConnectionTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 0 }),
  }
  const readCopy = async (): Promise<ConnectionCopy> => {
    if (kept === null) return { ...usableCopy(generationN), state: 'not_found', envelope: null, service: null, generation: null, dbNow: new Date(clock()).toISOString() }
    return {
      state: 'usable', connectionId: CONN, service: kept.input.service, generation: kept.input.generation, envelope: kept.input.envelope,
      publicConfig: kept.input.publicConfig, target: kept.input.target, servedAt: kept.servedAt, serveUntil: kept.input.serveUntil, dbNow: new Date(clock()).toISOString(),
    }
  }
  return { db, readCopy, saves, generation: () => kept?.input.generation ?? null }
}

/** The bidding Worker's serve of its committed row, at the generation it holds. */
function servedList(generation: number, envelope: SealedEnvelope, now: number) {
  return {
    served_at: new Date(now).toISOString(),
    complete: true,
    connections: [{
      id: CONN, organization_id: ORG, service: 'salesforce', generation, envelope, public_config: {}, target: TARGET,
      serve_until: new Date(now + 6 * 3_600_000).toISOString(),
    }],
    tombstones: [],
  }
}

interface Round {
  d: Doubles
  deps: OpsConnectionsDeps
  endpoint: TokenEndpoint
  copies: ReturnType<typeof opsCopies>
  /** The secrets the token endpoint was asked with, in order. */
  asked: () => string[]
  serve: (generation: number, envelope: SealedEnvelope) => Promise<Record<string, number>>
  step: () => Promise<string | null>
  refuseCandidate: () => void
}

function round(): Round {
  const endpoint = tokenEndpoint()
  let candidateRefused = false
  const tokenFor = (secret: string) => (secret === COMMITTED_SECRET ? 'token-for-committed' : 'token-for-candidate')
  const answering = endpoint.fetch
  const minterFetch: typeof endpoint.fetch = async (input, init) => {
    const secret = new URLSearchParams(String(init?.body ?? '')).get('client_secret') ?? ''
    endpoint.respond(candidateRefused && secret === CANDIDATE_SECRET
      ? Response.json({ error: 'invalid_client' }, { status: 400 })
      : Response.json({ access_token: tokenFor(secret) }))
    return answering(input, init)
  }
  const entry = salesforceServiceEntry({ fetch: minterFetch, now: () => T0 })
  const d = makeDoubles(keys, usableCopy(generationN), () => [entry.rules])
  const copies = opsCopies(() => d.now.value)
  d.deps.readCopy = copies.readCopy
  d.respond(async () => Response.json({ organization_id: '00Dcs0000000001EAA', preferred_username: 'ops-integration@trypennie.example' }))
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (service === 'salesforce' ? entry : undefined),
    moneyIdentities: async (org) => ({
      organization_id: org, served_at: new Date(T0).toISOString(),
      salesforce: { sf_org_id: '00Dcs0000000001EAA', username: 'money-integration@trypennie.example', measured_at: new Date(T0 - 3_600_000).toISOString() },
    }),
    recordMeasuredIdentity: async () => 'recorded',
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 0 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no person bound login here') } },
    now: () => d.now.value,
  }
  return {
    d, deps, endpoint, copies,
    asked: () => endpoint.calls.map((c) => c.body.get('client_secret') ?? ''),
    serve: async (generation, envelope) => (await saveServedConnections(copies.db, async () => servedList(generation, envelope, d.now.value))).counts,
    step: async () => {
      const call: ConnectionCall = { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: WF, record: async () => {} }
      const sentBefore = d.rec.sent.length
      d.respond(new Response('{"records":[]}', { status: 200 }))
      const res = await connectionFetch({ ...d.deps, rulesFor: (s) => deps.services(s)?.rules }, call, DATA_URL)
      expect((res as Response).status).toBe(200)
      return new Headers(d.rec.sent[sentBefore].init.headers).get('authorization')
    },
    refuseCandidate: () => { candidateRefused = true },
  }
}

const reconnectWith = (envelope: SealedEnvelope, generation: number): SealedCandidate => ({
  service: 'salesforce', generation, envelope: envelope as SealedCandidate['envelope'], target: TARGET, public_config: {},
})

describe('F126: a Reconnect never moves ops off the committed credential', () => {
  it('(1) a reconnect whose verify fails leaves ops serving generation N, and steps keep running on it', async () => {
    const r = round()
    await r.serve(1, generationN)
    r.refuseCandidate()
    const answer = await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })
    expect(answer).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(r.copies.generation()).toBe(1)
    expect(r.copies.saves).toEqual([{ generation: 1, outcome: 'saved' }])
    // The candidate's failure says nothing about the committed connection.
    expect(r.d.rec.needsReauth).toEqual([])
    expect(await r.step()).toBe('Bearer token-for-committed')
  })

  it('(2) a reconnect whose bidding compare and set loses leaves ops accepting the next serve of the committed row', async () => {
    const r = round()
    await r.serve(1, generationN)
    expect(await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })).toMatchObject({ ok: true, generation: 2 })
    // Bidding's compare and set lost: its row is still generation 1, and the next serve says so.
    const counts = await r.serve(1, generationN)
    expect(counts.connection_copies_saved).toBe(1)
    expect(counts.connection_copies_refused_older).toBe(0)
    expect(r.copies.generation()).toBe(1)
    expect(await r.step()).toBe('Bearer token-for-committed')
  })

  it('(3) a plain Reconnect after a failed one is not refused as an older generation', async () => {
    const r = round()
    await r.serve(1, generationN)
    r.refuseCandidate()
    expect(await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })).toMatchObject({ ok: false })
    // The plain Reconnect: the committed row's own envelope at its own generation.
    const plain = await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationN, 1) })
    expect(plain).toMatchObject({ ok: true, generation: 1, cleared: true })
    expect(r.copies.generation()).toBe(1)
  })
})

describe('F116: the compare and set fails after clearReauth answered', () => {
  it('the next serve\'s generation N wins on ops, and the N+1 envelope is never used again', async () => {
    const r = round()
    await r.serve(1, generationN)
    expect(await verifyConnection(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })).toMatchObject({ ok: true })
    expect(await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })).toMatchObject({ ok: true, cleared: true })
    // Verify and clearReauth each used the candidate for their one call, and wrote no copy.
    expect(r.asked()).toEqual([CANDIDATE_SECRET, CANDIDATE_SECRET])
    expect(r.copies.saves).toEqual([{ generation: 1, outcome: 'saved' }])
    const askedBefore = r.asked().length

    // The compare and set on bidding failed; the minute serve carries generation N.
    await r.serve(1, generationN)
    expect(r.copies.generation()).toBe(1)
    for (let i = 0; i < 3; i++) expect(await r.step()).toBe('Bearer token-for-committed')
    expect(r.asked().slice(askedBefore)).toEqual([COMMITTED_SECRET])
    expect(r.copies.saves.every((s) => s.generation === 1)).toBe(true)
  })

  it('once bidding commits N+1, its serve moves ops forward, and only then do steps use it', async () => {
    const r = round()
    await r.serve(1, generationN)
    expect(await clearReauth(r.deps, { organization_id: ORG, connection_id: CONN, candidate: reconnectWith(generationNext, 2) })).toMatchObject({ ok: true })
    expect(await r.step()).toBe('Bearer token-for-committed')
    await r.serve(2, generationNext)
    expect(r.copies.generation()).toBe(2)
    expect(await r.step()).toBe('Bearer token-for-candidate')
  })
})
