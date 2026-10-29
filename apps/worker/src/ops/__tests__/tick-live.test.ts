/**
 * The minute cron's live ports (#1949): the tick end to end through the real
 * ops-writes wrappers (over a stub of PostgREST), the real dispatch signature
 * and the scheduled handler, plus the refusals: an unset ops database secret
 * reported by name, a missing binding, and a gateway that never answers.
 */
import { CURRENT_OPS_KID } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OpsGatewayBinding, OpsTickReport } from '../../lib/ops-gateway-contract'
import { dispatchKey, verifyDispatch } from '../dispatch-auth'
import { scheduledTick, type OpsEnv } from '../index'
import type { OpsInternalBinding } from '../internal'
import { runOpsTick } from '../tick'
import { GATEWAY_DEADLINE_MS, liveTickPorts, opsTickDatabase, RUN_DISPATCH_DEADLINE_MS } from '../tick-live'
import { KEYGEN_TIMEOUT_MS, opsKeyPair } from './ops-key-fixture'
import type { SealRegistry } from '../connection-key'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const WF = '00000000-0000-4000-8000-0000000019a1'
const NOW = Date.parse('2026-10-17T10:02:31.000Z')
const schedule = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }

/** PostgREST, answering each ops function by name, recording what was called. */
function opsDatabase(extra: Record<string, unknown> = {}) {
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
      ported: false, cutover_at: null, replaces: [], porting_served_at: '2026-10-17T10:02:31+00:00', replaced_last_slot: null,
    }],
    record_schedule_observation: [{ outcome: 'recorded', observation_id: '11111111-2222-4333-8444-555555555555' }],
    due_queue_depth: [{ due_runs: 0, due_workflows: 0, oldest_due: null }],
    save_connection_copies: [{ inserted: 1, updated: 0, confirmed: 0, refused_older: 0, refused_expired: 0, refused_removed: 0, withdrawn: 0 }],
    // The measured identities of connections bidding never stored (#2573): none, as today.
    remove_unserved_measured_identities: [],
    purge_expired_connection_tombstones: [{ purged: 1, more: false }],
    sweep_sf_leases: [{ swept: 2, more: false }],
    // The sf_limits sweep's measured orgs (#2336): none, as today.
    sf_limits_targets: [],
    // The connection_check sweep's list and the tick's login states (#2340): none, as today.
    connection_check_targets: [],
    record_connection_check: 'recorded',
    // The frozen definition copies (#1950): the copy's version 3 is not held yet.
    missing_workflow_definitions: [{ workflow_id: WF, organization_id: ORG, version_number: 3 }],
    save_workflow_definition: 'saved',
  }
  Object.assign(answers, extra)
  const bodies: Record<string, unknown> = {}
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
    called.push(name)
    if (init?.body) bodies[name] = JSON.parse(String(init.body)) as unknown
    if (!(name in answers)) return Response.json({ code: '42883', message: `no function ${name}` }, { status: 404 })
    return Response.json(answers[name])
  }) as typeof globalThis.fetch
  return { fetch: fakeFetch, called, bodies }
}

/** What the tick was served for a run (#2998). */
const VARIABLES = { source: 'bidding' as const, servedAt: '2026-10-17T10:02:30.000Z', values: { API_BASE: 'https://api.example.test' }, secretValues: { API_TOKEN: 'fake-tick-live-secret' } }

function gateway(): OpsGatewayBinding & { reports: OpsTickReport[]; started: number; jobStamps: string[]; jobReports: unknown[]; definitionRequests: unknown[]; variableRequests: unknown[] } {
  const g = {
    definitionRequests: [] as unknown[],
    variableRequests: [] as unknown[],
    reports: [] as OpsTickReport[],
    started: 0,
    jobStamps: [] as string[],
    jobReports: [] as unknown[],
    opsWorkflows: async () => ({
      served_at: '2026-10-17T10:02:31.000Z', complete: true,
      workflows: [{ id: WF, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.000Z', version_number: 3, trigger: schedule, porting: { ported: false, cutover_at: null, replaces: [] } }],
    }),
    opsTickStarted: async () => { g.started++; return { ok: true } },
    opsTickCompleted: async (r: unknown) => { g.reports.push(r as OpsTickReport); return { ok: true } },
    // The ops jobs' stamps (#2340): the sf_limits sweep's.
    opsJobStarted: async (job: string) => { g.jobStamps.push(`started:${job}`); return { stamped: 'started', job } },
    opsJobCompleted: async (job: string, r: unknown) => { g.jobStamps.push(`completed:${job}`); g.jobReports.push(r); return { stamped: 'completed', job } },
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
    // The frozen definition copies (#1950): each version asked for, served.
    opsWorkflowDefinitions: async (request: unknown) => {
      g.definitionRequests.push(request)
      const versions = (request as { versions: Array<{ workflow_id: string; version_number: number }> }).versions
      return { definitions: versions.map((v) => ({ ...v, organization_id: ORG, definition: { nodes: [] } })), unserved: [] }
    },
    // A claimed run's current variables (#2998): each run asked about served one plain value and one secret.
    opsRunVariables: async (request: unknown) => {
      g.variableRequests.push(request)
      const r = request as { organization_id: string; runs: Array<{ workflow_id: string; version_number: number }> }
      return {
        organization_id: r.organization_id,
        runs: r.runs.map((x) => ({ ...x, values: { API_BASE: 'https://api.example.test' }, secret_values: { API_TOKEN: 'fake-tick-live-secret' }, served_at: '2026-10-17T10:02:30.000Z' })),
      }
    },
  }
  return g
}

/** The ops database answering connection_check_targets with one connection of `service` (one with no rules here is refused by the probe, which these tests do not read). */
function listing(db: ReturnType<typeof opsDatabase>, connectionId: string, service: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
    if (name === 'connection_check_targets') {
      db.called.push(name)
      return Response.json([{
        organization_id: ORG, connection_id: connectionId, service, generation: 1, target: null, public_config: {}, servable: true,
        status: 'healthy', last_check_ok_at: '2026-10-17T09:50:00+00:00', last_check_failed_at: null, needs_reauth_at: null, needs_reauth_cause: null,
        refresh_failures: 0, refresh_failing_since: null, measured_sf_org_id: null, measured_username: null, db_now: '2026-10-17T10:02:30+00:00',
      }])
    }
    return db.fetch(input, init)
  }) as typeof fetch
}

/** OpsInternal as the binding reaches it: it verifies every signature it is handed. */
function self(): OpsInternalBinding & { observed: string[]; ran: string[] } {
  const s = {
    observed: [] as string[],
    ran: [] as string[],
    ping: async () => ({ lane: 'ops' }),
    // Answers as OpsInternal.run does: verifies, then reports the run done.
    run: async (signed: unknown) => {
      const env = await verifyDispatch(await dispatchKey('master-secret'), signed, NOW)
      if (env.item.kind !== 'run') return { refused: 'not_a_run' }
      s.ran.push(env.item.run.runRequestId)
      return { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' }
    },
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

/**
 * CONNECTION_TOKENS as the write back check reaches it (#2340 phase 10 item 4):
 * each object named by its connection id, answering writeBackState; none held
 * unless a test says otherwise. Records which objects were asked, and about what.
 */
function tokenObjects(answer: (connectionId: string) => unknown = () => ({ ok: true, state: 'none' })) {
  const asked: Array<{ name: string; request: unknown }> = []
  const binding = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      writeBackState: async (request: unknown) => {
        asked.push({ name: id.name, request })
        return answer(id.name)
      },
    }),
  }
  return { asked, binding }
}

const configured = (g = gateway(), s = self(), t = tokenObjects()) => ({
  env: {
    LANE: 'ops', OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real',
    PORTING_CAPTURE_MASTER: 'master-secret', OPS_CONNECTIONS_PRIVATE_KEY: opsPrivateKey, OPS_GATEWAY: g, SELF: s, CONNECTION_TOKENS: t.binding,
  } as unknown as OpsEnv,
  g,
  s,
  t,
})

describe('OPS_TICK_MODE (#1950)', () => {
  const claimedRow = {
    run_request_id: '0192f4a0-0000-7000-8000-000000000001', organization_id: ORG, workflow_id: WF, workflow_version: 3, trigger_kind: 'schedule',
    claim_token: '11111111-2222-4333-8444-555555555555', claim_expires_at: '2026-10-17T10:03:30+00:00', state_version: 2, attempts: 0, uncharged_attempts: 0,
    max_attempts: 3, resume_reason: null, execution_chain_id: '0192f4a0-0000-7000-9000-000000000001', resumed_from_execution_id: null, payload: null, payload_ref: null,
  }

  it('unset, the tick observes: no claim, no real fire', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.mode).toBe('observe')
    expect(db.called).not.toContain('claim_run_requests')
    expect(db.called).not.toContain('record_schedule_fire')
  })

  it('live: records the fire through record_schedule_fire, claims with the run lease, and hands the run to OpsInternal.run signed', async () => {
    const db = opsDatabase({
      record_schedule_fire: [{ outcome: 'enqueued', fire_id: '0192f4a0-0000-7000-a000-000000000001', run_request_id: claimedRow.run_request_id, run_status: 'queued' }],
      claim_run_requests: [claimedRow],
    })
    const { env, s } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_TICK_MODE: 'live' } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.mode).toBe('live')
    expect(db.called).toEqual(expect.arrayContaining(['record_schedule_fire', 'claim_run_requests']))
    expect(db.bodies.claim_run_requests).toMatchObject({ p_limit: 40, p_per_workflow: 5, p_lease_seconds: 60 })
    expect(s.ran).toEqual([claimedRow.run_request_id])
    expect(report.counts).toMatchObject({ runs_claimed: 1, runs_done: 1, fires_enqueued: 1 })
  })

  it('live: writes the claimed run\'s variable copy through save_variable_copies, names and plain values only, confirmed at most every 10 minutes (#2999)', async () => {
    const reads = { nodes: [{ id: 'n', type: 'transform', config: { mappings: [{ source: 'env.API_BASE', target: 'a' }, { source: 'env.API_TOKEN', target: 't' }, { source: 'env.GONE', target: 'g' }] } }], edges: [] }
    const db = opsDatabase({
      record_schedule_fire: [{ outcome: 'enqueued', fire_id: '0192f4a0-0000-7000-a000-000000000001', run_request_id: claimedRow.run_request_id, run_status: 'queued' }],
      claim_run_requests: [claimedRow],
      variable_copies: [],
      workflow_definition: [{ definition: reads, saved_at: '2026-10-17T09:00:00+00:00', variables: null }],
      save_variable_copies: [{ versions_written: 1, versions_unchanged: 0, keys_written: 3, keys_deleted: 0, refused_no_copy: 0, refused_older: 0 }],
    })
    const { env, s } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_TICK_MODE: 'live' } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(s.ran).toEqual([claimedRow.run_request_id])
    expect(db.bodies.save_variable_copies).toEqual({
      p_confirm_every_seconds: 600,
      p_copies: [{
        organization_id: ORG, workflow_id: WF, version_number: 3, served_at: '2026-10-17T10:02:30.000Z',
        values: { API_BASE: 'https://api.example.test' }, secret_keys: ['API_TOKEN'], absent_keys: ['GONE'],
      }],
    })
    expect(JSON.stringify(db.bodies)).not.toContain('fake-tick-live-secret')
    expect(report.counts).toMatchObject({ variable_copies_versions_written: 1, variable_copies_keys_written: 3, runs_variables_live: 1 })
  })

  it('a value that names no mode runs observe, and is reported not configured by name', async () => {
    const db = opsDatabase()
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_TICK_MODE: 'yes' } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(report.mode).toBe('observe')
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_TICK_MODE'])
    expect(db.called).not.toContain('claim_run_requests')
  })
})

describe('OPS_CONTINUATION (#1951)', () => {
  const bucket = {} as R2Bucket

  it('unset, or observe with its bucket bound, is configured', async () => {
    const { env } = configured()
    for (const e of [env, { ...env, OPS_CONTINUATION: 'observe', OPS_CHECKPOINTS: bucket }, { ...env, OPS_CONTINUATION: 'off' }]) {
      const report = await runOpsTick(liveTickPorts(e as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: opsDatabase().fetch }))
      expect(report.not_configured_secrets ?? []).toEqual([])
    }
  })

  it('observe without the OPS_CHECKPOINTS binding is reported not configured, by the binding\'s name, every tick', async () => {
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_CONTINUATION: 'observe' } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: opsDatabase().fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CHECKPOINTS'])
  })

  it('on with its bucket bound is configured, and on without it is reported by the binding\'s name', async () => {
    const { env } = configured()
    const bound = await runOpsTick(liveTickPorts({ ...env, OPS_CONTINUATION: 'on', OPS_CHECKPOINTS: bucket } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: opsDatabase().fetch }))
    expect(bound.not_configured_secrets ?? []).toEqual([])
    const unbound = await runOpsTick(liveTickPorts({ ...env, OPS_CONTINUATION: 'on' } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: opsDatabase().fetch }))
    expect(unbound.not_configured_secrets).toEqual(['OPS_CHECKPOINTS'])
  })

  it('a value this build does not run is off, and reported by name with the modes it does run', async () => {
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, OPS_CONTINUATION: 'suspend', OPS_CHECKPOINTS: bucket } as OpsEnv, null, { sealRegistry, now: () => NOW, fetch: opsDatabase().fetch }))
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CONTINUATION'])
  })
})

describe('the live tick', () => {
  it('runs end to end through the ops functions, signs its dispatch, and reports to the gateway', async () => {
    const db = opsDatabase()
    const { env, g, s } = configured()
    const report = await runOpsTick(liveTickPorts(env, NOW + 17_000, { sealRegistry, now: () => NOW, tickId: 'tick-live', fetch: db.fetch }))
    expect(report.problems).toEqual([])
    expect(report.outcome).toBe('ok')
    expect(db.called).toEqual(expect.arrayContaining(['ops_now', 'claim_ops_sweep', 'save_workflow_copies', 'workflow_copies', 'record_schedule_observation', 'due_queue_depth', 'save_connection_copies', 'remove_unserved_measured_identities']))
    expect(report.counts.connection_copies_saved).toBe(1)
    // The two connection storage sweeps (#2334), through their real ops functions.
    expect(db.called).toEqual(expect.arrayContaining(['purge_expired_connection_tombstones', 'sweep_sf_leases']))
    expect(report.counts).toMatchObject({ tombstones_purged: 1, sf_leases_swept: 2 })
    expect(db.called.indexOf('save_workflow_copies')).toBeLessThan(db.called.indexOf('workflow_copies'))
    expect(s.observed).toEqual(['would_fire'])
    expect(g.started).toBe(1)
    expect(g.reports).toEqual([report])
    // The frozen definition copies (#1950): the version not held is asked of the gateway and saved through its ops function.
    expect(g.definitionRequests).toEqual([{ versions: [{ workflow_id: WF, version_number: 3 }] }])
    expect(db.called.indexOf('missing_workflow_definitions')).toBeLessThan(db.called.indexOf('save_workflow_definition'))
    expect(report.counts.definitions_saved).toBe(1)
  })

  it('runs the sf_limits sweep through its ops function and stamps it through the gateway under its own job id (#2336, #2340)', async () => {
    const db = opsDatabase()
    const { env, g } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(db.called).toContain('sf_limits_targets')
    expect(g.jobStamps.filter((j) => j.endsWith('ops-sf-limits'))).toEqual(['started:ops-sf-limits', 'completed:ops-sf-limits'])
    expect(g.jobReports).toContainEqual({ started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW).toISOString(), counts: { sf_limits_orgs: 0 } })
    expect(report.outcome).toBe('ok')
  })

  it('runs the connection_check sweep through its ops function, stamps it under its own job id, and reports a complete list of no login (#2340)', async () => {
    const db = opsDatabase()
    const { env, g } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    // Twice: the sweep's list, and the tick's login states.
    expect(db.called.filter((n) => n === 'connection_check_targets')).toHaveLength(2)
    expect(g.jobStamps.filter((j) => j.endsWith('ops-connection-check'))).toEqual(['started:ops-connection-check', 'completed:ops-connection-check'])
    expect(g.jobReports).toContainEqual({ started_at: new Date(NOW).toISOString(), finished_at: new Date(NOW).toISOString(), counts: { connection_check_connections: 0 } })
    expect(report.connection_logins).toEqual({ complete: true, logins: [] })
    expect(report.outcome).toBe('ok')
  })

  it('with no ops connection (today) asks no ConnectionTokenObject, needs no binding to, and reports a complete list of no write back (#2340 phase 10 item 4)', async () => {
    const db = opsDatabase()
    const { env, t } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, CONNECTION_TOKENS: undefined }, null, { sealRegistry, now: () => NOW, fetch: db.fetch }))
    expect(t.asked).toEqual([])
    expect(report.write_backs).toEqual({ complete: true, pending: [] })
    expect(report.outcome).toBe('ok')
  })

  it('asks a listed connection\'s ConnectionTokenObject by its connection id, about that connection, and lists one pending past the bound (#2340 phase 10 item 4)', async () => {
    const db = opsDatabase()
    const CONN = '00000000-0000-4000-8000-0000000023c1'
    const withTarget = listing(db, CONN, 'google_user')
    const t = tokenObjects(() => ({ ok: true, state: 'pending', pendingSinceMs: NOW - 50 * 60_000, attempts: 7 }))
    const { env } = configured(gateway(), self(), t)
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: withTarget }))
    expect(t.asked).toEqual([{ name: CONN, request: { organizationId: ORG, connectionId: CONN, service: 'google_user' } }])
    expect(report.write_backs).toEqual({
      complete: true,
      pending: [{ organization_id: ORG, connection_id: CONN, service: 'google_user', since: new Date(NOW - 50 * 60_000).toISOString(), attempts: 7 }],
    })
  })

  it('with a connection listed and the CONNECTION_TOKENS binding missing, says so by name for that connection, never nothing pending (#2340 phase 10 item 4)', async () => {
    const db = opsDatabase()
    const CONN = '00000000-0000-4000-8000-0000000023c1'
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts({ ...env, CONNECTION_TOKENS: undefined }, null, { sealRegistry, now: () => NOW, fetch: listing(db, CONN, 'google_user') }))
    expect(report.write_backs).toEqual({ complete: false, pending: [] })
    expect(report.problem_keys).toContain(`write_back_unreadable:${CONN}`)
    expect(report.problems.join(' ')).toMatch(/CONNECTION_TOKENS binding is missing/)
  })

  it('probes a connection through connectionFetch, which reads the copy first, and a service with no rules is refused by name (#2340)', async () => {
    const db = opsDatabase()
    const base = db.fetch
    const CONN = '00000000-0000-4000-8000-0000000023c1'
    const NONESUCH = '00000000-0000-4000-8000-0000000023c2'
    const row = (connectionId: string, service: string) => ({
      organization_id: ORG, connection_id: connectionId, service, generation: 1,
      target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, public_config: {}, servable: true,
      status: 'healthy', last_check_ok_at: '2026-10-17T09:50:00+00:00', last_check_failed_at: null, needs_reauth_at: null, needs_reauth_cause: null,
      refresh_failures: 0, refresh_failing_since: null, measured_sf_org_id: null, measured_username: null, db_now: '2026-10-17T10:02:30+00:00',
    })
    const withTargets: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
      if (name === 'connection_check_targets') {
        db.called.push(name)
        return Response.json([row(CONN, 'salesforce'), row(NONESUCH, 'nonesuch')])
      }
      if (name === 'connection_copy') {
        db.called.push(name)
        return Response.json([{ state: 'not_found', connection_id: CONN, service: null, generation: null, envelope: null, public_config: null, target: null, served_at: null, serve_until: null, db_now: '2026-10-17T10:02:30+00:00' }])
      }
      return base(input, init)
    }) as typeof fetch
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: withTargets }))
    // The Salesforce one reached connectionFetch, whose copy read found it gone, so nothing was recorded about it.
    expect(db.called).toContain('connection_copy')
    expect(report.counts.connection_check_gone).toBe(1)
    // The one with no rules on this Worker is refused by name, and that refusal is recorded as its failed check.
    expect(report.problem_keys).toEqual([`connection_check_refused:${NONESUCH}`])
    expect(report.problems[0]).toMatch(/connection_service_unknown/)
    // One record only: the refused one. The one found gone has nothing to record.
    expect(db.called.filter((n) => n === 'record_connection_check')).toHaveLength(1)
  })

  it('reads a measured org through connectionFetch, which refuses by name a copy the ops database does not hold (#2336)', async () => {
    const db = opsDatabase()
    const answers = db as unknown as { fetch: typeof fetch }
    const base = answers.fetch
    const CONN = '00000000-0000-4000-8000-0000000023c1'
    const withTarget: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const name = new URL(input instanceof Request ? input.url : input.toString()).pathname.replace('/rest/v1/rpc/', '')
      if (name === 'sf_limits_targets') {
        db.called.push(name)
        return Response.json([{
          sf_org_id: '00Dst0000000001AAA', organization_id: ORG, connection_id: CONN, generation: 1,
          target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, reading_measured_at: null, db_now: '2026-10-17T10:02:30+00:00',
        }])
      }
      if (name === 'connection_copy') {
        db.called.push(name)
        return Response.json([{ state: 'not_found', connection_id: CONN, service: null, generation: null, envelope: null, public_config: null, target: null, served_at: null, serve_until: null, db_now: '2026-10-17T10:02:30+00:00' }])
      }
      return base(input, init)
    }) as typeof fetch
    const { env } = configured()
    const report = await runOpsTick(liveTickPorts(env, null, { sealRegistry, now: () => NOW, fetch: withTarget }))
    expect(db.called).toContain('connection_copy')
    expect(report.problem_keys).toEqual(['sf_limits_refused:00Dst0000000001AAA'])
    expect(report.problems[0]).toMatch(/connection_not_found/)
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
    expect(report.problems[0]).toContain(`not the private half of the public key committed as kid ${CURRENT_OPS_KID} (`)
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

  it('a run dispatch is given up on by the tick\'s own deadline, counted from when the tick began, not from the dispatch', async () => {
    const { env } = configured({ ...gateway() }, { ...self(), run: () => new Promise<never>(() => {}) })
    let clock = NOW
    const waited: number[] = []
    const ports = liveTickPorts(env, null, { sealRegistry, now: () => clock, delay: async (ms) => { waited.push(ms) } })
    // The sweeps, copies and connections before the claim took three minutes.
    clock = NOW + 3 * 60_000
    const run = {
      runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: ORG, workflowId: WF, workflowVersion: 3, triggerKind: 'schedule',
      claimToken: '11111111-2222-4333-8444-555555555555', claimExpiresAt: '2026-10-17T10:06:30+00:00', stateVersion: 2, attempts: 0, unchargedAttempts: 0,
      maxAttempts: 3, resumeReason: null, executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: null, payloadRef: null,
    } as unknown as Parameters<typeof ports.dispatchRun>[0]
    await expect(ports.dispatchRun(run, VARIABLES)).rejects.toThrow(/OpsInternal.run did not answer/)
    expect(waited).toEqual([RUN_DISPATCH_DEADLINE_MS - 3 * 60_000])
    // With no time left it is not dispatched at all.
    clock = NOW + RUN_DISPATCH_DEADLINE_MS
    await expect(ports.dispatchRun(run, VARIABLES)).rejects.toThrow(/no time left/)
    expect(waited).toHaveLength(1)
  })

  // #2998: a run's variables are asked of the bidding Worker by the tick and travel in its signed dispatch.
  it('asks the bidding Worker for run variables through opsRunVariables, bounded by the gateway deadline', async () => {
    const g = gateway()
    const { env } = configured(g)
    const ports = liveTickPorts(env, null, { sealRegistry, now: () => NOW })
    const request = { organization_id: ORG, runs: [{ workflow_id: WF, version_number: 3 }] }
    expect(await ports.gateway.fetchRunVariables(request)).toMatchObject({ organization_id: ORG, runs: [{ workflow_id: WF, version_number: 3 }] })
    expect(g.variableRequests).toEqual([request])
    const waited: number[] = []
    const silent = liveTickPorts({ ...env, OPS_GATEWAY: { ...g, opsRunVariables: () => new Promise<never>(() => {}) } }, null, {
      sealRegistry, now: () => NOW, delay: async (ms) => { waited.push(ms) },
    })
    await expect(silent.gateway.fetchRunVariables(request)).rejects.toThrow(/run variables did not answer within 15 s/)
    expect(waited).toEqual([GATEWAY_DEADLINE_MS])
  })

  it('signs a run\'s variables into its dispatch, which OpsInternal verifies whole', async () => {
    const seen: unknown[] = []
    const s = { ...self(), run: async (signed: unknown) => {
      const verified = await verifyDispatch(await dispatchKey('master-secret'), signed, NOW)
      if (verified.item.kind === 'run') seen.push(verified.item.variables)
      return { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' }
    } }
    const { env } = configured(gateway(), s)
    const ports = liveTickPorts(env, null, { sealRegistry, now: () => NOW })
    const run = {
      runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: ORG, workflowId: WF, workflowVersion: 3, triggerKind: 'schedule',
      claimToken: '11111111-2222-4333-8444-555555555555', claimExpiresAt: '2026-10-17T10:06:30+00:00', stateVersion: 2, attempts: 0, unchargedAttempts: 0,
      maxAttempts: 3, resumeReason: null, executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: null, payloadRef: null,
    } as unknown as Parameters<typeof ports.dispatchRun>[0]
    expect(await ports.dispatchRun(run, VARIABLES)).toMatchObject({ outcome: 'completed' })
    expect(seen).toEqual([VARIABLES])
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
