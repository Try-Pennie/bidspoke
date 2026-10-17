/**
 * Every Slack alert reader reads the alert row and only the alert row (#2332,
 * phase 2 of #1689, PR (b)).
 *
 * Release 2 lets an organization hold a second Slack row: an ops connection
 * (sealed_for 'ops_key', its own name and bot). The alert row is the one row
 * with service_type 'slack', name 'slack' and sealed_for 'bidding_ring', or the
 * legacy unsealed form (sealed_for null) the production row still has until
 * the backfill seals it. Before this change every reader asked for
 * service_type 'slack' alone, so an ops row could be read as the alert row:
 * with ops alone, alerts would post with the ops bot; with both, the single
 * row reads failed (PostgREST's more than one row) and the all org reads kept
 * whichever row came last.
 *
 * These run the REAL supabase-js client against an in memory PostgREST that
 * evaluates the query string sent (helpers/postgrest-fake.ts), so a reader
 * whose filter is wrong reads the ops row here as it would in production.
 *
 * More than one candidate is its own named refusal,
 * slack_alert_connection_ambiguous, never "no Slack" and never one of them
 * picked. The database makes it impossible today (UNIQUE (organization_id,
 * service_type, name)), so it is planted here directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSlackConnection, lookupSlackConnection, readSlackConnectionForLead } from '../slack'
import { readEverySlackConnection, readSlackConnectionRows, slackOrgIds } from '../alert-fanout'
import { registerSlackKeyRing } from '../slack-key-ring'
import { registerScheduledSlack } from '../scheduled-slack'
import { runDatabaseReachabilityProbe } from '../database-reachability'
import { encryptSecret } from '../secret-crypto'
import { readSlackCopy, SLACK_CONNS_LASTGOOD_KEY } from '../slack-copy'
import { fakeTimers, kvWithCopy, TEST_KEY } from './_scheduled-slack-doubles'
import { fakePostgrest, type Row } from '../../__tests__/helpers/postgrest-fake'

const ORG = '11111111-1111-4111-8111-111111112332'
const OTHER_ORG = '22222222-2222-4222-8222-222222222332'
const RING = { encryptWith: TEST_KEY, decryptWith: [TEST_KEY] }

const legacyAlertRow = (org = ORG): Row => ({
  id: `alert-${org}`, organization_id: org, service_type: 'slack', name: 'slack', sealed_for: null,
  credential_enc: null, config: { bot_token: 'alert-bot-token', default_channel: '#alerts' },
})
const sealedAlertRow = async (org = ORG): Promise<Row> => ({
  id: `alert-${org}`, organization_id: org, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring',
  credential_enc: await encryptSecret('sealed-alert-bot-token', TEST_KEY), config: { default_channel: '#alerts' },
})
/** An ops Slack connection (#1689 Phase 8): its own name and bot, sealed for the ops key. */
const opsRow = (org = ORG): Row => ({
  id: `ops-${org}`, organization_id: org, service_type: 'slack', name: 'ops-bot', sealed_for: 'ops_key',
  // The ops ciphertext is not openable by the bidding ring; the plaintext here
  // stands for anything a mis-scoped reader could turn into a connection.
  credential_enc: null, config: { bot_token: 'OPS-bot-token', default_channel: '#ops' },
})
/** A second candidate for the alert row, which the database's unique constraints forbid today. */
const secondCandidate = (org = ORG): Row => ({
  id: `second-${org}`, organization_id: org, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring',
  credential_enc: null, config: { bot_token: 'second-bot-token', default_channel: '#second' },
})

function db(rows: Row[]) {
  const fake = fakePostgrest({ service_connections: rows })
  registerSlackKeyRing(fake.client, RING)
  return fake
}

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('one org reads (getSlackConnection, readSlackConnectionForLead)', () => {
  it('never reads an ops Slack row as the alert row when it is the only Slack row', async () => {
    const { client } = db([opsRow()])
    expect(await getSlackConnection(client, ORG, [])).toBeNull()
    expect(await lookupSlackConnection(client, ORG, [])).toEqual({ kind: 'none' })
    expect(await readSlackConnectionForLead(client, ORG)).toBeNull()
  })

  it('reads the legacy unsealed alert row beside an ops row', async () => {
    const { client } = db([opsRow(), legacyAlertRow()])
    expect((await getSlackConnection(client, ORG, []))?.bot_token).toBe('alert-bot-token')
    expect((await readSlackConnectionForLead(client, ORG))?.bot_token).toBe('alert-bot-token')
  })

  it('reads the sealed alert row beside an ops row', async () => {
    const { client } = db([await sealedAlertRow(), opsRow()])
    expect((await getSlackConnection(client, ORG, []))?.bot_token).toBe('sealed-alert-bot-token')
  })

  it('asks the database for the alert row by service type, name and seal', async () => {
    const fake = db([legacyAlertRow()])
    await getSlackConnection(fake.client, ORG, [])
    const read = fake.requests.find((r) => r.path === 'service_connections')!
    expect(read.params.get('service_type')).toBe('eq.slack')
    expect(read.params.get('name')).toBe('eq.slack')
    expect(read.params.get('or')).toBe('(sealed_for.eq.bidding_ring,sealed_for.is.null)')
    expect(read.params.get('organization_id')).toBe(`eq.${ORG}`)
  })

  it('refuses two candidates by name, never as no Slack and never by picking one', async () => {
    const { client } = db([legacyAlertRow(), secondCandidate(), opsRow()])
    expect(await lookupSlackConnection(client, ORG, [])).toEqual({ kind: 'unreachable', reason: 'slack_alert_connection_ambiguous' })
    expect(await getSlackConnection(client, ORG, [])).toBeNull()
    expect(logs.some((l) => l.includes('slack_alert_connection_ambiguous') && l.includes(ORG))).toBe(true)
    // A lead's page falls back to the saved copy on a throw, as for a failed read.
    await expect(readSlackConnectionForLead(client, ORG)).rejects.toThrow(/slack_alert_connection_ambiguous/)
  })

  it('on the scheduled client, two candidates are answered from the saved copy, as an unreadable token is', async () => {
    const { client } = db([legacyAlertRow(), secondCandidate()])
    const kv = await kvWithCopy({ [ORG]: { bot_token: 'copy-bot-token', default_channel: '#copy' } })
    registerScheduledSlack(client, { kv, secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    const found = await lookupSlackConnection(client, ORG)
    expect(found.kind).toBe('stored')
    expect(found.kind === 'stored' && found.connection.bot_token).toBe('copy-bot-token')
    expect(logs.some((l) => l.includes('slack_alert_connection_ambiguous'))).toBe(true)
  })
})

describe('all org reads (alert-fanout)', () => {
  it('lists no org whose only Slack row is an ops row', async () => {
    const { client } = db([opsRow(), legacyAlertRow(OTHER_ORG)])
    const list = await slackOrgIds(client, 'test', 'tell-only')
    expect(list).toEqual({ kind: 'live', orgIds: [OTHER_ORG] })
    const every = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(every.kind === 'live' && [...every.connections.keys()]).toEqual([OTHER_ORG])
  })

  it('holds one entry per org, the alert row, with an ops row read after it', async () => {
    const { client } = db([legacyAlertRow(), opsRow()])
    const every = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(every.kind).toBe('live')
    if (every.kind !== 'live') return
    expect(every.connections.size).toBe(1)
    expect(every.connections.get(ORG)?.bot_token).toBe('alert-bot-token')
  })

  it('leaves out, by name, an org with two candidates, and keeps the others', async () => {
    const { client } = db([legacyAlertRow(), secondCandidate(), legacyAlertRow(OTHER_ORG)])
    const every = await readEverySlackConnection(client, 'test', 'tell-only')
    expect(every.kind === 'live' && [...every.connections.keys()]).toEqual([OTHER_ORG])
    expect(logs.some((l) => l.includes('slack_alert_connection_ambiguous') && l.includes(ORG))).toBe(true)
  })

  it('the probe read (readSlackConnectionRows) returns no ops row', async () => {
    const { client } = db([opsRow(), legacyAlertRow()])
    const { data, error } = await readSlackConnectionRows(client)
    expect(error).toBeNull()
    expect((data ?? []).map((r) => (r.config as { bot_token: string }).bot_token)).toEqual(['alert-bot-token'])
  })
})

describe('the minute probe', () => {
  /** A KV the probe can write, seeded with a saved copy. */
  async function writableKv(conns: Record<string, unknown>) {
    const seeded = await kvWithCopy(conns)
    const store = new Map<string, string>()
    const key = SLACK_CONNS_LASTGOOD_KEY
    const saved = await seeded.get(key)
    if (saved) store.set(key, saved)
    return {
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
      delete: (k: string) => { store.delete(k); return Promise.resolve() },
    }
  }
  const deps = (client: ReturnType<typeof db>['client'], kv: Awaited<ReturnType<typeof writableKv>>) => ({
    kv,
    secretKeys: TEST_KEY,
    appUrl: 'https://app.example',
    now: () => Date.parse('2026-10-17T15:00:00Z'),
    supabase: client,
    sleep: fakeTimers('never').sleep,
    stamps: { started: vi.fn().mockResolvedValue(undefined), completed: vi.fn().mockResolvedValue(undefined) },
  })

  it('writes the alert row to the saved copy, never the ops row', async () => {
    const { client } = db([legacyAlertRow(), opsRow()])
    const kv = await writableKv({})
    await runDatabaseReachabilityProbe(deps(client, kv))
    const copy = await readSlackCopy(kv, TEST_KEY)
    expect(copy.kind === 'read' && copy.connections.get(ORG)?.bot_token).toBe('alert-bot-token')
  })

  it('carries forward the existing entry of an org with two candidates, said by name', async () => {
    const { client } = db([legacyAlertRow(), secondCandidate(), legacyAlertRow(OTHER_ORG)])
    const kv = await writableKv({ [ORG]: { bot_token: 'copy-bot-token', default_channel: '#copy' } })
    await runDatabaseReachabilityProbe(deps(client, kv))
    const copy = await readSlackCopy(kv, TEST_KEY)
    expect(copy.kind).toBe('read')
    if (copy.kind !== 'read') return
    expect(copy.connections.get(ORG)?.bot_token).toBe('copy-bot-token')
    expect(copy.connections.get(OTHER_ORG)?.bot_token).toBe('alert-bot-token')
    expect(logs.some((l) => l.includes('slack_alert_connection_ambiguous') && l.includes(ORG))).toBe(true)
  })
})
