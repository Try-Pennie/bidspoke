/**
 * The minute cron's live ports (#1949): the tick end to end through the real
 * ops-writes wrappers (over a stub of PostgREST), the real dispatch signature
 * and the scheduled handler, plus the refusals: an unset ops database secret
 * reported by name, a missing binding, and a gateway that never answers.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { OpsGatewayBinding, OpsTickReport } from '../../lib/ops-gateway-contract'
import { dispatchKey, verifyDispatch } from '../dispatch-auth'
import { scheduledTick, type OpsEnv } from '../index'
import type { OpsInternalBinding } from '../internal'
import { runOpsTick } from '../tick'
import { GATEWAY_DEADLINE_MS, liveTickPorts, opsTickDatabase } from '../tick-live'
import { KEYGEN_TIMEOUT_MS, opsKeyPair } from './ops-key-fixture'
import type { SealRegistry } from '../connection-key'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const WF = '00000000-0000-4000-8000-0000000019a1'
const NOW = Date.parse('2026-10-17T10:02:31.000Z')
const schedule = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }

/** PostgREST, answering each ops function by name, recording what was called. */
function opsDatabase() {
  const called: string[] = []
  const answers: Record<string, unknown> = {
    ops_now: '2026-10-17T10:02:30+00:00',
    claim_ops_sweep: [{ owned: true, db_now: '2026-10-17T10:02:30+00:00', last_started_at: null, last_owner: null }],
    sweep_expired_leases: [{ requeued: 0, retried: 0, needs_human: 0, dead: 0, failed: 0, more: false }],
    expire_overdue_run_requests: [{ expired: 0, more: false }],
    run_queue_disagreements: [],
    save_workflow_copies: [{ inserted: 1, updated: 0, confirmed: 0, refused_older: 0, withdrawn: 0 }],
    workflow_copies: [{
      workflow_id: WF, organization_id: ORG, is_active: true, deleted_at: null, withdrawn_at: null,
      row_updated_at: '2026-10-17T09:00:00+00:00', version_number: 3, trigger: schedule,
      schedule_known_since: '2026-10-17T09:59:00+00:00', switched_off_at: null, served_at: '2026-10-17T10:02:31+00:00',
      received_at: '2026-10-17T09:59:00+00:00', confirmed_at: '2026-10-17T10:02:31+00:00', may_start: true,
      last_served: null, last_observed: null, db_now: '2026-10-17T10:02:30+00:00',
    }],
    record_schedule_observation: [{ outcome: 'recorded', observation_id: '11111111-2222-4333-8444-555555555555' }],
    due_queue_depth: [{ due_runs: 0, due_workflows: 0, oldest_due: null }],
    save_connection_copies: [{ inserted: 1, updated: 0, confirmed: 0, refused_older: 0, refused_expired: 0, refused_removed: 0, withdrawn: 0 }],
  }
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
    called.push(name)
    if (!(name in answers)) return Response.json({ code: '42883', message: `no function ${name}` }, { status: 404 })
    return Response.json(answers[name])
  }) as typeof globalThis.fetch
  return { fetch: fakeFetch, called }
}

function gateway(): OpsGatewayBinding & { reports: OpsTickReport[]; started: number } {
  const g = {
    reports: [] as OpsTickReport[],
    started: 0,
    opsWorkflows: async () => ({
      served_at: '2026-10-17T10:02:31.000Z', complete: true,
      workflows: [{ id: WF, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.000Z', version_number: 3, trigger: schedule }],
    }),
    opsTickStarted: async () => { g.started++; return { ok: true } },
    opsTickCompleted: async (r: unknown) => { g.reports.push(r as OpsTickReport); return { ok: true } },
    // The tick never hands back a rotated login (#2335): the ConnectionTokenObject does.
    storeRotatedEnvelope: async () => { throw new Error('the tick does not call storeRotatedEnvelope') },
    replaceConnectionEnvelope: async () => { throw new Error('the tick does not call replaceConnectionEnvelope') },
    // The serve (#2335): one ops connection, ciphertext and public config only.
    opsConnections: async () => ({
      served_at: '2026-10-17T10:02:31.000Z', complete: true, tombstones: [],
      connections: [{
        id: '00000000-0000-4000-8000-0000000023c1', organization_id: ORG, service: 'salesforce', generation: 1,
        envelope: { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA==' },
        public_config: {}, target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, serve_until: '2026-10-17T16:02:31.000Z',
      }],
    }),
    // Verify's, in PR 8 of #2335: the tick never asks.
    moneyIdentities: async () => { throw new Error('the tick does not call moneyIdentities') },
  }
  return g
}

/** OpsInternal as the binding reaches it: it verifies every signature it is handed. */
function self(): OpsInternalBinding & { observed: string[] } {
  const s = {
    observed: [] as string[],
    ping: async () => ({ lane: 'ops' }),
    resealConnections: async () => { throw new Error('the tick does not call resealConnections') },
    // Answers a refusal as OpsInternal.observe does: a value, never a throw across the binding.
    observe: async (signed: unknown) => {
      try {
        const env = await verifyDispatch(await dispatchKey('master-secret'), signed, NOW)
        s.observed.push(env.item.kind)
        return { observed: true, tick_id: env.tick_id, kind: env.item.kind }
      } catch (err) {
        return { observed: false, refused: (err as { reason: string }).reason }
      }
    },
  }
  return s
}

/** A real 4096 bit ops key pair, generated for this run (#2333), and a registry committing its public half. */
let opsPrivateKey = ''
let sealRegistry: SealRegistry = { currentKid: null, publicKeys: {} }
beforeAll(async () => {
  const pair = await opsKeyPair(4096)
  opsPrivateKey = pair.privatePem
  sealRegistry = { currentKid: 'ops-test', publicKeys: { 'ops-test': pair.publicPem } }
}, KEYGEN_TIMEOUT_MS)

const configured = (g = gateway(), s = self()) => ({
  env: {
    LANE: 'ops', OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real',
    PORTING_CAPTURE_MASTER: 'master-secret', OPS_CONNECTIONS_PRIVATE_KEY: opsPrivateKey, OPS_GATEWAY: g, SELF: s,
  } as unknown as OpsEnv,
  g,
  s,
})

describe('the live tick', () => {
  it('runs end to end through the ops functions, signs its dispatch, and reports to the gateway', async () => {
    const db = opsDatabase()
    const { env, g, s } = configured()
    const report = await runOpsTick(liveTickPorts(env, NOW + 17_000, { sealRegistry, now: () => NOW, tickId: 'tick-live', fetch: db.fetch }))
    expect(report.problems).toEqual([])
    expect(report.outcome).toBe('ok')
    expect(db.called).toEqual(expect.arrayContaining(['ops_now', 'claim_ops_sweep', 'save_workflow_copies', 'workflow_copies', 'record_schedule_observation', 'due_queue_depth', 'save_connection_copies']))
    expect(report.counts.connection_copies_saved).toBe(1)
    expect(db.called.indexOf('save_workflow_copies')).toBeLessThan(db.called.indexOf('workflow_copies'))
    expect(s.observed).toEqual(['would_fire'])
    expect(g.started).toBe(1)
    expect(g.reports).toEqual([report])
  })

  it('a dispatch signed with the wrong key is refused by OpsInternal and reported', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, PORTING_CAPTURE_MASTER: 'a-different-master' }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.problems.join(' ')).toMatch(/dispatch of workflow .* failed: OpsInternal refused: bad_signature/)
  })
})

describe('not configured, said by name', () => {
  it('names both secrets when neither is set, and the tick reports not_configured', async () => {
    expect(opsTickDatabase({ LANE: 'ops' } as unknown as OpsEnv)).toEqual({
      notConfigured: 'OPS_SUPABASE_URL and OPS_SUPABASE_SECRET_KEY are not set on bidspoke-worker-ops',
      secrets: ['OPS_SUPABASE_URL', 'OPS_SUPABASE_SECRET_KEY'],
    })
    const db = opsDatabase()
    const { env, g } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_SUPABASE_SECRET_KEY: undefined }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.problems[0]).toMatch(/OPS_SUPABASE_SECRET_KEY is not set on bidspoke-worker-ops/)
    expect(db.called).toEqual([])
    expect(g.reports[0].outcome).toBe('not_configured')
    expect(g.reports[0].not_configured_secrets).toEqual(['OPS_SUPABASE_SECRET_KEY'])
  })

  // #2333: the ops private key is checked on every live tick.
  it('a live tick with the ops private key unset reports it by name, and still runs everything else', async () => {
    const db = opsDatabase()
    const { env, g, s } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_CONNECTIONS_PRIVATE_KEY: undefined }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
    expect(report.problems).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.'])
    expect(db.called).toEqual(expect.arrayContaining(['ops_now', 'record_schedule_observation']))
    expect(s.observed).toEqual(['would_fire'])
    expect(g.reports[0].not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
  })

  it('a live tick with a malformed ops private key reports it by name', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_CONNECTIONS_PRIVATE_KEY: 'pasted the wrong thing' }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
    expect(report.problems[0]).toMatch(/OPS_CONNECTIONS_PRIVATE_KEY is set on bidspoke-worker-ops but does not import .*seal_key_malformed/)
  })

  it('a live tick with a sound key that is not the committed one reports it by name', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { now: () => NOW, fetch: db.fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
    expect(report.problems[0]).toMatch(/not the private half of the public key committed as kid ops-2026-10/)
  })

  it('refuses a URL naming the bidding database, never connecting to it', () => {
    const refused = opsTickDatabase({ LANE: 'ops', OPS_SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_x' } as unknown as OpsEnv)
    expect(refused).toEqual({ notConfigured: expect.stringMatching(/names the bidding database/), secrets: ['OPS_SUPABASE_URL'] })
  })
})

describe('the bindings', () => {
  it('a missing gateway binding is reported by name, and the tick still plans from the saved copies', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_GATEWAY: undefined }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.problems.join(' ')).toMatch(/OPS_GATEWAY binding to the bidding Worker is missing/)
    expect(db.called).toContain('record_schedule_observation')
  })

  it('a gateway that never answers is given up on at its deadline', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const silent = { ...gateway(), opsWorkflows: () => new Promise<never>(() => {}) }
    const waited: number[] = []
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_GATEWAY: silent }, null, {
      sealRegistry, now: () => NOW, fetch: db.fetch, delay: async (ms) => { waited.push(ms) },
    }))
    expect(waited).toContain(GATEWAY_DEADLINE_MS)
    expect(report.problems.join(' ')).toMatch(/workflow list did not answer within 15 s/)
  })

  it('a connection list that never answers is given up on at its deadline, and no copy is saved (#2335)', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const silent = { ...gateway(), opsConnections: () => new Promise<never>(() => {}) }
    // A deadline that passes at once, so every gateway call is given up on; only the connection list never answers at all.
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_GATEWAY: silent }, null, {
      sealRegistry, now: () => NOW, fetch: db.fetch, delay: async () => {},
    }))
    expect(report.problems).toContainEqual(expect.stringMatching(/could not fetch the ops connections .*connection list did not answer within 15 s/))
    expect(db.called).not.toContain('save_connection_copies')
    expect(db.called).toContain('record_schedule_observation')
  })
})

describe('the scheduled handler', () => {
  it('refuses to tick outside the ops lane, by name', async () => {
    await expect(scheduledTick({ scheduledTime: NOW }, { LANE: 'money' } as unknown as OpsEnv)).rejects.toThrow(/refused to tick: lane_not_ops/)
    await expect(scheduledTick({ scheduledTime: NOW }, {} as unknown as OpsEnv)).rejects.toThrow(/lane_unset/)
  })
})
