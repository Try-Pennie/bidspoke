/**
 * The serve (#2335, PR 6 of phase 5 of #1689; plan: discussion #2329, part 2):
 * the ops connections the bidding Worker serves the ops minute tick, and how the
 * ops side parses them (L50). Each connection carries its sealed envelope, its
 * public config, its declared target and a serve_until 6 hours after it was
 * served (Dan's decision 3), and never a plaintext login; each malformed row is
 * refused by name, and a list missing a row it read is never complete, because a
 * complete list withdraws every ops copy it does not name.
 */
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_SERVE_WINDOW_MS, OpsGatewayContractError, TOMBSTONE_SERVE_WINDOW_MS, parseServedOpsConnections, parseStoreRotatedEnvelopeRequest,
} from '../ops-gateway-contract'
import { readOpsConnections } from '../ops-gateway'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const OTHER_ORG = '7a2d3c9f-1e4b-4d2f-8b66-2c3d4e5f6071'
const CONN = '00000000-0000-4000-8000-0000000023c1'
const CONN_B = '00000000-0000-4000-8000-0000000023c2'
const NOW = Date.parse('2026-10-18T22:00:00.000Z')
const SERVED_AT = new Date(NOW).toISOString()
const UNTIL = new Date(NOW + CONNECTION_SERVE_WINDOW_MS).toISOString()

const envelope = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA==' }

const connection = (over: Record<string, unknown> = {}) => ({
  id: CONN, organization_id: ORG, service: 'salesforce', generation: 2, envelope,
  public_config: { name: 'trypennie' }, target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' },
  serve_until: UNTIL, ...over,
})
const tombstone = (over: Record<string, unknown> = {}) => ({
  connection_id: CONN_B, organization_id: ORG, generation: 3, removed_at: '2026-10-18T21:00:00.000Z', ...over,
})
const list = (connections: unknown[] = [connection()], tombstones: unknown[] = [], over: Record<string, unknown> = {}) => ({
  served_at: SERVED_AT, complete: true, connections, tombstones, ...over,
})

describe('the serve window', () => {
  it('is Dan\'s 6 hours, and a removal is served for the 7 hours an ops tombstone lives', () => {
    expect(CONNECTION_SERVE_WINDOW_MS).toBe(6 * 60 * 60 * 1000)
    // supabase-ops 20261017220000: connection_tombstones_ops_outlives_copies holds expires_at >= removed_at + 7 hours.
    expect(TOMBSTONE_SERVE_WINDOW_MS).toBe(7 * 60 * 60 * 1000)
  })
})

describe('parseServedOpsConnections', () => {
  it('reads a well formed list as served', () => {
    const { list: parsed, refused } = parseServedOpsConnections(list([connection()], [tombstone()]))
    expect(refused).toEqual([])
    expect(parsed).toEqual({ served_at: SERVED_AT, complete: true, connections: [connection()], tombstones: [tombstone()] })
  })

  it('reads a connection with no declared target', () => {
    expect(parseServedOpsConnections(list([connection({ target: null })])).list.connections[0].target).toBeNull()
  })

  it.each([
    ['an id that is not a uuid', { id: 'conn-1' }, /connection conn-1/],
    ['an organization that is not a uuid', { organization_id: 'pennie' }, /organization/],
    ['a service that is not a service key', { service: 'Sales Force' }, /service/],
    ['a generation below 1', { generation: 0 }, /generation/],
    ['a generation that is not whole', { generation: 1.5 }, /generation/],
    ['an envelope with a field beside the seal\'s', { envelope: { ...envelope, plaintext: 'x' } }, /envelope/],
    ['an envelope of another version', { envelope: { ...envelope, v: 2 } }, /envelope/],
    ['an envelope whose ciphertext is not base64', { envelope: { ...envelope, ct: 'not base64!' } }, /envelope/],
    ['a plaintext login where the envelope belongs', { envelope: '{"client_secret":"s3cret"}' }, /envelope/],
    ['public config that is not an object', { public_config: ['a'] }, /public config/],
    ['public config naming a login field', { public_config: { name: 'x', client_secret: 's3cret' } }, /public config.*client_secret/],
    ['public config naming a login field deep inside it', { public_config: { auth: { refresh_token: 'r' } } }, /public config.*refresh_token/],
    ['a target naming a login field', { target: { instance_url: 'https://x.my.salesforce.com', password: 'p' } }, /target.*password/],
    ['a target that is not an object', { target: 'https://x.my.salesforce.com' }, /target/],
    ['a serve_until past the 6 hour window', { serve_until: new Date(NOW + CONNECTION_SERVE_WINDOW_MS + 1000).toISOString() }, /serve_until/],
    ['a serve_until not after it was served', { serve_until: SERVED_AT }, /serve_until/],
    ['an unreadable serve_until', { serve_until: 'soon' }, /serve_until/],
  ])('refuses a connection with %s by name, keeps the rest, and does not call the list complete', (_label, over, why) => {
    const { list: parsed, refused } = parseServedOpsConnections(list([connection({ id: CONN_B }), connection(over)]))
    expect(parsed.connections.map((c) => c.id)).toEqual([CONN_B])
    expect(parsed.complete).toBe(false)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatch(why)
    expect(refused[0]).toMatch(/was not saved/)
  })

  it('never puts a refused row\'s values in the sentence that refuses it', () => {
    const { refused } = parseServedOpsConnections(list([connection({ public_config: { client_secret: 'canary-s3cret-91f2' } }), connection({ envelope: 'canary-plain-77ab' })]))
    expect(refused).toHaveLength(2)
    for (const r of refused) expect(r).not.toMatch(/canary/)
  })

  it('refuses a connection whose public config would overflow the ops copy\'s 16 KB check, so one row cannot fail the whole save', () => {
    const { refused } = parseServedOpsConnections(list([connection({ public_config: { note: 'a,b:'.repeat(4000) } })]))
    expect(refused[0]).toMatch(/public config.*16384/)
  })

  it.each([
    ['a connection that is not a uuid', { connection_id: 'x' }],
    ['an organization that is not a uuid', { organization_id: 'x' }],
    ['a generation below 1', { generation: 0 }],
    ['an unreadable removal time', { removed_at: 'earlier' }],
  ])('refuses a tombstone with %s by name, and still calls the connections complete', (_label, over) => {
    const { list: parsed, refused } = parseServedOpsConnections(list([connection()], [tombstone(), tombstone(over)]))
    expect(parsed.tombstones).toEqual([tombstone()])
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatch(/removal/)
    // A removed connection is not in the list either, so the complete list still withdraws it on ops.
    expect(parsed.complete).toBe(true)
  })

  it('keeps a list the bidding Worker itself called incomplete as incomplete', () => {
    expect(parseServedOpsConnections(list([connection()], [], { complete: false })).list.complete).toBe(false)
  })

  it.each([
    ['not an object', 'connections'],
    ['missing served_at', { complete: true, connections: [], tombstones: [] }],
    ['missing complete', { served_at: SERVED_AT, connections: [], tombstones: [] }],
    ['missing connections', { served_at: SERVED_AT, complete: true, tombstones: [] }],
    ['missing tombstones', { served_at: SERVED_AT, complete: true, connections: [] }],
  ])('throws on a list %s', (_label, raw) => {
    expect(() => parseServedOpsConnections(raw)).toThrow(OpsGatewayContractError)
  })

  it('reads every row of another organization as that organization\'s, never as the first row\'s', () => {
    const { list: parsed } = parseServedOpsConnections(list([connection(), connection({ id: CONN_B, organization_id: OTHER_ORG })]))
    expect(parsed.connections.map((c) => [c.id, c.organization_id])).toEqual([[CONN, ORG], [CONN_B, OTHER_ORG]])
  })
})

describe('the rotated envelope request still refuses by the same names (the envelope rule is now shared)', () => {
  const request = (env: unknown) => ({ organization_id: ORG, connection_id: CONN, expected_generation: 1, generation: 2, envelope: env })
  it.each([
    [{ ...envelope, extra: 1 }, 'the rotated envelope must have exactly the fields ct, iv, kid, v, wrapped_key'],
    [{ ...envelope, v: 2 }, 'the rotated envelope is not version 1'],
    [{ ...envelope, kid: 'BAD KID' }, 'the rotated envelope\'s kid is not a kid'],
    [{ ...envelope, iv: '***' }, 'the rotated envelope\'s iv is not base64'],
    ['x', 'the rotated envelope is not an object'],
  ])('%#', (env, message) => {
    expect(() => parseStoreRotatedEnvelopeRequest(request(env))).toThrow(message)
  })
})

/** PostgREST for the two reads, answering each table's rows and recording each query. */
function servedDb(tables: { service_connections?: unknown[]; connection_tombstones?: unknown[] }, opts: { failing?: string } = {}) {
  const queries: URL[] = []
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    queries.push(url)
    const table = url.pathname.replace('/rest/v1/', '')
    if (opts.failing === table) return Response.json({ code: 'PGRST000', message: 'the database is not answering' }, { status: 503 })
    return Response.json((tables as Record<string, unknown[]>)[table] ?? [])
  }) as typeof globalThis.fetch
  return {
    client: createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never),
    queries,
  }
}

const row = (over: Record<string, unknown> = {}) => ({
  id: CONN, organization_id: ORG, service_type: 'salesforce', sealed_for: 'ops_key', credential_generation: 2,
  credential_enc: JSON.stringify(envelope), config: { name: 'trypennie' },
  target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, ...over,
})

describe('readOpsConnections, the bidding side of the serve', () => {
  it('serves each ops_key connection as its envelope, public config and target, with serve_until 6 hours after it was served', async () => {
    const { client, queries } = servedDb({ service_connections: [row()], connection_tombstones: [] })
    const served = await readOpsConnections(client, NOW)
    expect(served).toEqual({ served_at: SERVED_AT, complete: true, connections: [connection()], tombstones: [] })
    // And the ops side reads exactly that back.
    expect(parseServedOpsConnections(served)).toEqual({ list: served, refused: [] })
    const q = queries.find((u) => u.pathname === '/rest/v1/service_connections')!
    expect(q.searchParams.get('sealed_for')).toBe('eq.ops_key')
    expect(q.searchParams.get('credential_enc')).toBe('not.is.null')
  })

  it('drops a bidding_ring row the filter let through, so the Slack token\'s ciphertext never reaches ops, and does not call the list complete', async () => {
    const { client } = servedDb({ service_connections: [row(), row({ id: CONN_B, sealed_for: 'bidding_ring', service_type: 'slack' })] })
    const served = await readOpsConnections(client, NOW)
    expect(served.connections.map((c) => c.id)).toEqual([CONN])
    expect(served.complete).toBe(false)
  })

  it('drops a row whose credential is not a sealed envelope, and a row whose config names a login field, each without its value', async () => {
    const errors: string[] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
    try {
      const { client } = servedDb({
        service_connections: [
          row(),
          row({ id: CONN_B, credential_enc: 'canary-plaintext-login' }),
          row({ id: '00000000-0000-4000-8000-0000000023c3', config: { bot_token: 'canary-bot-token' } }),
        ],
      })
      const served = await readOpsConnections(client, NOW)
      expect(served.connections.map((c) => c.id)).toEqual([CONN])
      expect(served.complete).toBe(false)
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).not.toMatch(/canary/)
    expect(errors.join('\n')).toMatch(new RegExp(CONN_B))
  })

  it('serves each removal of the last 7 hours once, at its highest generation', async () => {
    const { client, queries } = servedDb({
      service_connections: [],
      connection_tombstones: [
        { connection_id: CONN_B, organization_id: ORG, generation: 2, removed_at: '2026-10-18T20:00:00+00:00' },
        { connection_id: CONN_B, organization_id: ORG, generation: 3, removed_at: '2026-10-18T21:00:00+00:00' },
      ],
    })
    const served = await readOpsConnections(client, NOW)
    expect(served.tombstones).toEqual([{ connection_id: CONN_B, organization_id: ORG, generation: 3, removed_at: '2026-10-18T21:00:00+00:00' }])
    const q = queries.find((u) => u.pathname === '/rest/v1/connection_tombstones')!
    expect(q.searchParams.get('removed_at')).toBe(`gte.${new Date(NOW - TOMBSTONE_SERVE_WINDOW_MS).toISOString()}`)
  })

  it.each(['service_connections', 'connection_tombstones'])('throws when the %s read fails, rather than serving a list that would withdraw every ops copy', async (table) => {
    const { client } = servedDb({ service_connections: [row()] }, { failing: table })
    await expect(readOpsConnections(client, NOW)).rejects.toThrow(/ops connections|removed connections/)
  })
})
