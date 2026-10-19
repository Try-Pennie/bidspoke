/**
 * The OpsConnections entrypoint (#2335, PR 8 of phase 5 of #1689): the named
 * entrypoint the bidding Worker's OPS_CONNECTIONS binding (PR 9) calls.
 *
 * The Phase 0 spike (#2330) measured that Cloudflare does not refuse a binding
 * to an entrypoint the deployed Worker does not export: the binding deploys
 * green and every call throws "internal error; reference = <id>" within 20 to
 * 40 ms. So the first test here is that OpsConnections stays exported from the
 * ops Worker's main module, with exactly the methods bidding will call; a
 * rename or a removal fails here before it can deploy. That a real binding
 * reaches it inside workerd is ops-connections.workers.test.ts.
 *
 * The rest: every answer is a value (a rejection across an RPC call reads as a
 * crash on the receiver too), refused by name outside the ops lane, for a
 * malformed request, for a missing secret, and past the method's ceiling.
 */
import { describe, expect, it } from 'vitest'
import { WorkerEntrypoint } from 'cloudflare:workers'
import * as opsModule from '../index'
import type { OpsEnv } from '../index'
import { OpsConnections, opsConnectionsAnswer } from '../ops-connections-entrypoint'
import { OPS_CONNECTIONS_CEILINGS_MS, OPS_CONNECTIONS_METHODS, parseHealthRequest } from '../../lib/ops-connections-contract'
import { KEYGEN_TIMEOUT_MS, opsKeyPair } from './ops-key-fixture'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '0199f0a0-0000-7000-8000-000000000001'

const entry = (env: Partial<OpsEnv>) => new OpsConnections({} as ExecutionContext, env as OpsEnv)

/** An ops database double answering one rpc by name, recording what was sent. */
function opsDatabase(answers: Record<string, unknown>) {
  const calls: Array<{ rpc: string; body: unknown }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const rpc = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
    calls.push({ rpc, body: JSON.parse(String(init?.body ?? '{}')) })
    if (!Object.hasOwn(answers, rpc)) return Response.json({ message: 'unexpected' }, { status: 500 })
    return Response.json(answers[rpc])
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const configured: Partial<OpsEnv> = { LANE: 'ops', OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real' }

describe('OpsConnections stays exported from the ops Worker (Phase 0 spike, #2330)', () => {
  it('is a named export of the main module, a WorkerEntrypoint, with exactly the methods the bidding Worker calls', () => {
    expect(opsModule.OpsConnections).toBe(OpsConnections)
    expect(Object.getPrototypeOf(OpsConnections)).toBe(WorkerEntrypoint)
    expect(Object.getOwnPropertyNames(OpsConnections.prototype).filter((n) => n !== 'constructor').sort()).toEqual([...OPS_CONNECTIONS_METHODS].sort())
  })

  it('is not the default export, which the public route reaches', () => {
    expect(Object.values(opsModule.default)).not.toContain(OpsConnections)
  })
})

describe('every answer is a value, refused by name', () => {
  it.each([[undefined, 'lane_unset'], ['', 'lane_unset'], ['money', 'lane_not_ops']])('outside the ops lane (LANE %j), every method refuses %s', async (lane, code) => {
    const e = entry({ ...configured, LANE: lane })
    for (const method of OPS_CONNECTIONS_METHODS) {
      expect(await (e[method] as (r: unknown) => Promise<unknown>)({ organization_id: ORG })).toMatchObject({ ok: false, refused: code })
    }
  })

  it('a request the contract refuses names the field, and reaches nothing', async () => {
    const answer = await entry(configured).verify({ organization_id: 'acme', connection_id: CONN })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_request_invalid', retry_at: null })
    expect((answer as { detail: string }).detail).toMatch(/organization_id/)
  })

  it('with the ops database unset, refuses naming the secret', async () => {
    const answer = await entry({ LANE: 'ops' }).health({ organization_id: ORG })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_not_configured' })
    expect((answer as { detail: string }).detail).toMatch(/OPS_SUPABASE_URL/)
  })

  it('a method that opens a login, with no ops private key, refuses naming it rather than failing in the cipher', async () => {
    for (const method of ['verify', 'clearReauth', 'lookup'] as const) {
      const answer = await (entry(configured)[method] as (r: unknown) => Promise<unknown>)({
        organization_id: ORG, connection_id: CONN, key: 'objects', parents: [],
        candidate: { service: 'salesforce', generation: 1, envelope: { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcA==', iv: 'aXY=', ct: 'Y3Q=' }, target: null, public_config: {} },
      })
      expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_not_configured' })
      expect((answer as { detail: string }).detail).toMatch(/OPS_CONNECTIONS_PRIVATE_KEY/)
    }
  })

  it('health reads one organization\'s statuses through the live wiring and the ops database', async () => {
    const db = opsDatabase({
      connection_status: [{
        connection_id: CONN, service: 'salesforce', generation: 2, status: 'healthy', last_check_ok_at: '2026-10-19T10:00:00+00:00',
        last_check_failed_at: null, last_check_cause: null, needs_reauth_at: null, needs_reauth_cause: null, reauth_cleared_at: null,
      }],
    })
    const answer = await opsConnectionsAnswer(configured as OpsEnv, 'health', { organization_id: ORG.toUpperCase() }, parseHealthRequest, { opsFetch: db.fetch })
    expect(answer).toMatchObject({ ok: true, reached_limit: false, connections: [{ connection_id: CONN, status: 'healthy' }] })
    expect(db.calls).toEqual([{ rpc: 'connection_status', body: { p_organization_id: ORG, p_limit: 1000 } }])
  })

  it('revoke writes the tombstone through the live wiring', async () => {
    const db = opsDatabase({ record_connection_tombstone: [{ outcome: 'recorded', copies_removed: 1 }] })
    const answer = await opsConnectionsAnswer(configured as OpsEnv, 'revoke', { organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-19T10:00:00.000Z' },
      (await import('../../lib/ops-connections-contract')).parseRevokeRequest, { opsFetch: db.fetch })
    expect(answer).toEqual({ ok: true, outcome: 'recorded', copies_removed: 1 })
    expect(db.calls[0]).toEqual({ rpc: 'record_connection_tombstone', body: { p_organization_id: ORG, p_connection_id: CONN, p_generation: 3, p_removed_at: '2026-10-19T10:00:00.000Z' } })
  })

  it('a method past its ceiling answers ops_connections_timeout and aborts the work it was doing', async () => {
    let aborted = false
    const answer = await opsConnectionsAnswer(configured as OpsEnv, 'health', { organization_id: ORG }, parseHealthRequest, {
      delay: async () => {},
      run: (_deps, _request, signal) => new Promise<never>(() => { signal.addEventListener('abort', () => { aborted = true }) }),
    })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_timeout' })
    expect((answer as { detail: string }).detail).toContain(`${OPS_CONNECTIONS_CEILINGS_MS.health / 1000} s`)
    expect(aborted).toBe(true)
  })

  it('an error nothing expected is answered by its kind only, never its message', async () => {
    const answer = await opsConnectionsAnswer(configured as OpsEnv, 'health', { organization_id: ORG }, parseHealthRequest, {
      run: async () => { throw new TypeError('plain-leaked-message-value') },
    })
    expect(answer).toEqual({ ok: false, refused: 'ops_connections_failed', detail: expect.stringContaining('TypeError'), retry_at: null })
    expect(JSON.stringify(answer)).not.toContain('plain-leaked-message-value')
  })

  it('opens with the configured ops key: a verify reaches the copy read, not a configuration refusal', async () => {
    const pair = await opsKeyPair(4096)
    const db = opsDatabase({
      connection_copy: [{ state: 'not_found', connection_id: CONN, service: null, generation: null, envelope: null, public_config: null, target: null, served_at: null, serve_until: null, db_now: '2026-10-19T10:00:00+00:00' }],
    })
    const answer = await opsConnectionsAnswer({ ...configured, OPS_CONNECTIONS_PRIVATE_KEY: pair.privatePem } as OpsEnv, 'verify', { organization_id: ORG, connection_id: CONN },
      (await import('../../lib/ops-connections-contract')).parseVerifyRequest, { opsFetch: db.fetch, sealRegistry: { currentKid: 'ops-test', publicKeys: { 'ops-test': pair.publicPem } } })
    expect(answer).toMatchObject({ ok: false, refused: 'connection_not_found' })
    expect(db.calls.map((c) => c.rpc)).toEqual(['connection_copy'])
  }, KEYGEN_TIMEOUT_MS)

  it('refuses as not configured a set key that is the private half of no committed public key (#2333), rather than trying it under the current kid', async () => {
    const [pair, committed] = await Promise.all([opsKeyPair(4096), opsKeyPair(4096)])
    const db = opsDatabase({})
    const answer = await opsConnectionsAnswer({ ...configured, OPS_CONNECTIONS_PRIVATE_KEY: pair.privatePem } as OpsEnv, 'verify', { organization_id: ORG, connection_id: CONN },
      (await import('../../lib/ops-connections-contract')).parseVerifyRequest, { opsFetch: db.fetch, sealRegistry: { currentKid: 'ops-test', publicKeys: { 'ops-test': committed.publicPem } } })
    expect(answer).toMatchObject({ ok: false, refused: 'ops_connections_not_configured', detail: expect.stringContaining('not the private half of any committed public key') })
    expect(db.calls).toEqual([])
  }, KEYGEN_TIMEOUT_MS)
})
