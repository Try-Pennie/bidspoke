/**
 * The ops minute cron's tick (#1949), in observe mode and in live mode (#1950),
 * against injected ports.
 *
 * The database functions are proven against a real Postgres in
 * supabase-ops/supabase/tests/ops_tick.test.sql, and the binding to OpsInternal
 * inside workerd in self-dispatch.workers.test.ts. These prove the tick's own
 * rules: every fire is computed on the DATABASE clock; each job, each schedule
 * and each dispatch is its own failure boundary; it plans from the copies as
 * the database holds them after its save, never from its own fetch; a missing
 * key, a lost claim, a failed fetch, a missed slot and a statement timeout are
 * each reported, never swallowed; in observe mode it runs nothing that sends
 * anywhere, and in live mode it records real fires, claims runs and hands each
 * to OpsInternal.run, counting how they ended.
 *
 * Every clock is injected: the worker clock is set an hour away from the
 * database clock, so a fire computed on the wrong one is visible.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_DEFINITIONS_PER_REQUEST, OPS_TICK_PROBLEM_RULES } from '../../lib/ops-gateway-contract'
import { organizationIdFrom, type OrganizationId } from '../ops-db'
import {
  OpsWriteTimeoutError, type ConnectionCopyInput, type SaveConnectionCopiesResult, type SaveCopiesResult, type ScheduleObservation, type SweepClaim, type SweepResult,
  type OpsResealState, type UnservedIdentityRemoved, type WorkflowCopy, type WorkflowCopyInput,
} from '../ops-writes'
import type { OpsSweep } from '../run-vocabulary'
import { ConnectionRefusal, RequeueAt } from '../connections/refusals'
import type {
  ClaimRunRequests, ClaimedRun, CompleteOutcome, CompletedRun, ConnectionCheckTarget, ScheduleFire, ScheduleFireResult, SfLimitsTarget,
} from '../ops-writes'
import { RUN_LEASE_SECONDS, type RunInvocationReport } from '../run-invocation'
import { SF_LIMITS_EVERY_SECONDS } from '../sf-limits'
import { CONNECTION_CHECK_JOB, SF_LIMITS_JOB } from '../../lib/ops-gateway-contract'
import { CONNECTION_CHECK_EVERY_SECONDS, CONNECTION_CHECK_READ_LIMIT, CONNECTION_LOGINS_READ_LIMIT, type ProbeAnswer } from '../connection-check'
import {
  COPIES_STALE_AFTER_MS, DEFINITIONS_PER_TICK, DEFINITIONS_READ_LIMIT, OBSERVATION_PURGE_EVERY_SECONDS, RUN_OUTCOME_FAILING_RATE, RUN_OUTCOME_MIN_RUNS, TICK_CLAIM_LIMIT, TICK_CLAIM_PER_WORKFLOW, TICK_SWEEPS, runOpsTick, type DispatchItem, type OpsTickDb, type OpsTickPorts, type UnconfiguredSecret } from '../tick'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const WF_A = '00000000-0000-4000-8000-0000000019a1'
const WF_B = '00000000-0000-4000-8000-0000000019a2'
const DB_NOW = '2026-10-17T10:02:30.000Z'
/** An hour off the database: a fire computed on this clock would be for 11:00, not 10:00. */
const WORKER_NOW = Date.parse('2026-10-17T11:02:31.000Z')

const every5 = { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 }
const schedule = (config: unknown = every5) => ({ type: 'schedule', config })

function copy(over: Partial<WorkflowCopy> = {}): WorkflowCopy {
  return {
    workflowId: WF_A,
    organizationId: ORG,
    isActive: true,
    deletedAt: null,
    withdrawnAt: null,
    rowUpdatedAt: '2026-10-17T09:00:00.000Z',
    versionNumber: 3,
    trigger: schedule(),
    // Known from just before the 10:00 slot, so that slot is the one due.
    scheduleKnownSince: '2026-10-17T09:59:00.000Z',
    switchedOffAt: null,
    receivedAt: '2026-10-17T10:01:00.000Z',
    confirmedAt: '2026-10-17T10:01:00.000Z',
    mayStart: true,
    lastServed: null,
    lastObserved: null,
    dbNow: DB_NOW,
    // Not ported and replacing none, as the last served list said (#1952).
    porting: { ported: false, cutoverAt: null, replaces: [], servedAt: '2026-10-17T11:02:31.000Z' },
    replacedLastSlot: null,
    ...over,
  }
}

function served(workflows: Array<Record<string, unknown>> = [{}]) {
  return {
    served_at: '2026-10-17T11:02:31.000Z',
    complete: true,
    workflows: workflows.map((w) => ({
      id: WF_A, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.000Z', version_number: 3, trigger: schedule(),
      porting: { ported: false, cutover_at: null, replaces: [] }, ...w,
    })),
  }
}

const CONN = '00000000-0000-4000-8000-0000000023c1'

/** One ops connection as the bidding Worker serves it (#2335): ciphertext and public config only. */
function servedConnections() {
  return {
    served_at: '2026-10-17T11:02:31.000Z',
    complete: true,
    connections: [{
      id: CONN, organization_id: ORG, service: 'salesforce', generation: 1,
      envelope: { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA==' },
      public_config: {}, target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, serve_until: '2026-10-17T17:02:31.000Z',
    }],
    tombstones: [],
  }
}

interface Fake {
  ports: OpsTickPorts
  db: OpsTickDb & {
    calls: string[]; saved: WorkflowCopyInput[][]; savedConnections: ConnectionCopyInput[][]; observations: ScheduleObservation[]
    sfReadings: Array<{ sfOrgId: string; dailyApiMax: number; dailyApiRemaining: number }>
    connectionChecks: Array<{ connectionId: string; result: { ok: true } | { ok: false; cause: string } }>
    savedDefinitions: Array<{ organizationId: string; workflowId: string; versionNumber: number; definition: unknown }>
    fires: Array<{ organizationId: string; fire: ScheduleFire }>
    claims: ClaimRunRequests[]
    completed: Array<{ runRequestId: string; end: CompleteOutcome }>
  }
  /** The runs handed to OpsInternal.run (#1950). */
  ranRuns: string[]
  /** The definition requests sent to the bidding Worker (#1950). */
  definitionRequests: Array<{ versions: Array<{ workflow_id: string; version_number: number }> }>
  dispatched: DispatchItem[]
  stamps: string[]
  reports: unknown[]
  /** The ops jobs' stamps through the gateway (#2340), as `started:<job>` and `completed:<job>`. */
  jobStamps: string[]
  sfReads: string[]
  /** The connections the connection_check sweep probed (#2340). */
  probes: string[]
  /** The connections whose ConnectionTokenObject the write back check asked (#2340, phase 10 item 4). */
  objectReads: string[]
}

/** One ops connection, as connection_check_targets answers it (#2340). */
function connTarget(over: Partial<ConnectionCheckTarget> = {}): ConnectionCheckTarget {
  return {
    organizationId: ORG, connectionId: CONN, service: 'salesforce', generation: 1,
    target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' }, publicConfig: {}, servable: true,
    status: 'healthy', lastCheckOkAt: '2026-10-17T09:48:30.000Z', lastCheckFailedAt: null, needsReauthAt: null, needsReauthCause: null,
    refreshFailures: 0, refreshFailingSince: null, measuredIdentity: { sfOrgId: '00Dst0000000001AAA', username: 'ops-one@example.com' },
    dbNow: DB_NOW, ...over,
  }
}

const SF_ORG = '00Dst0000000001AAA'

/** One measured Salesforce org, as sf_limits_targets answers it (#2336). */
function sfTarget(over: Partial<SfLimitsTarget> = {}): SfLimitsTarget {
  return {
    sfOrgId: SF_ORG, organizationId: ORG, connectionId: CONN, generation: 1,
    target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG-ops' },
    readingMeasuredAt: '2026-10-17T09:58:30.000Z', dbNow: DB_NOW, ...over,
  }
}

function fake(opts: {
  copies?: WorkflowCopy[]
  fetch?: () => Promise<unknown>
  /** What the bidding Worker answers the connection list with (#2335). */
  fetchConnections?: () => Promise<unknown>
  sweepOwned?: boolean
  leases?: SweepResult
  /** What each page of the tombstone_expiry sweep answers (#2334). */
  tombstones?: { purged: number; more: boolean }
  /** What each page of the Salesforce lease sweep answers (#2334). */
  sfLeases?: { swept: number; more: boolean }
  /** What each page of the observation purge answers (#1950). */
  observationsPurge?: { purged: number; more: boolean }
  stepTestsPurge?: { purged: number; more: boolean }
  stepRecordsPurge?: { purged: number; more: boolean }
  /** The database clock, when a case needs another time than DB_NOW. */
  dbNow?: string
  /** The versions missing_workflow_definitions lists (#1950); none by default. */
  missingDefs?: Array<{ workflowId: string; organizationId: string; versionNumber: number }>
  /** What the bidding Worker answers the definition request with; each asked version served by default. */
  serveDefs?: (request: { versions: Array<{ workflow_id: string; version_number: number }> }) => Promise<unknown>
  /** What save_workflow_definition answers each save. */
  saveDef?: (workflowId: string) => 'saved' | 'already_saved' | 'conflict' | 'no_copy'
  /** The tick's mode (#1950); observe by default, as deployed. */
  mode?: 'observe' | 'live'
  /** The runs a live claim takes. */
  claimed?: ClaimedRun[]
  /** What OpsInternal.run answers for each run; completed done by default. */
  runReport?: (run: ClaimedRun) => Promise<RunInvocationReport>
  failing?: Partial<Record<keyof OpsTickDb, Error>>
  observed?: (o: ScheduleObservation) => 'recorded' | 'already_recorded'
  dispatchFails?: (item: DispatchItem) => boolean
  disagreements?: number
  dueRuns?: number
  db?: 'not_configured'
  stampFails?: boolean
  /** What the secrets check finds unset or unusable, or the error it throws. */
  secrets?: UnconfiguredSecret[] | Error
  /** The measured Salesforce orgs the sf_limits sweep finds (#2336); none by default, as today. */
  sfTargets?: SfLimitsTarget[]
  /** What each /limits read answers. */
  sfRead?: (t: SfLimitsTarget) => Promise<Response | RequeueAt>
  /** The ops job stamps fail (#2340). */
  jobStampFails?: boolean
  /** The ops connections connection_check_targets lists (#2340); none by default, as today. */
  connTargets?: ConnectionCheckTarget[]
  /** The read reached its limit. */
  connTargetsFull?: boolean
  /** What each identity probe answers. */
  probe?: (t: ConnectionCheckTarget) => Promise<ProbeAnswer>
  /** What each connection's ConnectionTokenObject answers the write back read with; none held by default. */
  writeBack?: (t: ConnectionCheckTarget) => Promise<unknown>
  /** OPS_RESEAL as the Worker reads it (#2486); unset by default, as outside a rotation. */
  resealSwitch?: string
  /** What observe_ops_reseal answers; switched on two minutes before the database clock by default. */
  resealState?: Partial<OpsResealState>
  /** The measured identities of connections bidding never stored that a complete serve removes (#2573); none by default. */
  unservedRemoved?: UnservedIdentityRemoved[]
} = {}): Fake {
  const calls: string[] = []
  const saved: WorkflowCopyInput[][] = []
  const savedConnections: ConnectionCopyInput[][] = []
  const observations: ScheduleObservation[] = []
  const sfReadings: Array<{ sfOrgId: string; dailyApiMax: number; dailyApiRemaining: number }> = []
  const connectionChecks: Fake['db']['connectionChecks'] = []
  const fail = (name: keyof OpsTickDb) => {
    calls.push(name)
    const e = opts.failing?.[name]
    if (e) throw e
  }
  const db = {
    calls,
    saved,
    savedConnections,
    observations,
    sfReadings,
    connectionChecks,
    async connectionCheckTargets(limit: number) {
      fail('connectionCheckTargets'); calls.push(`connectionCheckTargets:${limit}`)
      return { targets: opts.connTargets ?? [], reachedLimit: opts.connTargetsFull ?? false }
    },
    async recordConnectionCheck(_org: unknown, connectionId: string, result: { ok: true } | { ok: false; cause: string }) {
      fail('recordConnectionCheck'); connectionChecks.push({ connectionId, result }); return 'recorded' as const
    },
    async now() { fail('now'); return opts.dbNow ?? DB_NOW },
    async observeReseal(mode: 'preview' | 'apply', restartAfterSeconds: number): Promise<OpsResealState> {
      fail('observeReseal'); calls.push(`observeReseal:${mode}:${restartAfterSeconds}`)
      return {
        mode, modeSince: new Date(Date.parse(DB_NOW) - 2 * 60_000).toISOString(), lastRunAt: null, lastRunNothingLeft: null, lastRunLeft: null,
        nothingLeftSince: null, restarted: false, dbNow: DB_NOW, ...opts.resealState,
      }
    },
    savedDefinitions: [] as Array<{ organizationId: string; workflowId: string; versionNumber: number; definition: unknown }>,
    fires: [] as Array<{ organizationId: string; fire: ScheduleFire }>,
    claims: [] as ClaimRunRequests[],
    completed: [] as Array<{ runRequestId: string; end: CompleteOutcome }>,
    async recordFire(organizationId: OrganizationId, fire: ScheduleFire): Promise<ScheduleFireResult> {
      fail('recordFire'); db.fires.push({ organizationId, fire })
      return { outcome: 'enqueued', fireId: 'fire-1', runRequestId: 'run-1', runStatus: 'queued' }
    },
    async claimRuns(claim: ClaimRunRequests): Promise<ClaimedRun[]> {
      fail('claimRuns'); db.claims.push(claim)
      return opts.claimed ?? []
    },
    async completeRun(run: ClaimedRun, end: CompleteOutcome): Promise<CompletedRun> {
      fail('completeRun'); db.completed.push({ runRequestId: run.runRequestId, end })
      return { outcome: 'completed', runStatus: end.outcome }
    },
    async missingDefinitions(limit: number) {
      fail('missingDefinitions'); calls.push(`missingDefinitions:${limit}`)
      const missing = (opts.missingDefs ?? []).map((m) => ({ ...m, organizationId: organizationIdFrom(m.organizationId) }))
      return { missing, reachedLimit: missing.length === limit }
    },
    async saveDefinition(organizationId: string, workflowId: string, versionNumber: number, definition: Record<string, unknown>) {
      fail('saveDefinition'); db.savedDefinitions.push({ organizationId, workflowId, versionNumber, definition })
      return opts.saveDef?.(workflowId) ?? 'saved'
    },
    async purgeObservations(limit: number) { fail('purgeObservations'); calls.push(`purgeObservations:${limit}`); return opts.observationsPurge ?? { purged: 0, more: false } },
    async purgeStepTests(limit: number) { fail('purgeStepTests'); calls.push(`purgeStepTests:${limit}`); return opts.stepTestsPurge ?? { purged: 0, more: false } },
    async purgeStepRecords(limit: number) { fail('purgeStepRecords'); calls.push(`purgeStepRecords:${limit}`); return opts.stepRecordsPurge ?? { purged: 0, more: false } },
    async sfLimitsTargets(limit: number) {
      fail('sfLimitsTargets'); calls.push(`sfLimitsTargets:${limit}`)
      return { targets: opts.sfTargets ?? [], reachedLimit: false }
    },
    async recordSfLimitsReading(sfOrgId: string, reading: { dailyApiMax: number; dailyApiRemaining: number }) {
      fail('recordSfLimitsReading'); sfReadings.push({ sfOrgId, ...reading }); return 'recorded' as const
    },
    async claimSweep(sweep: OpsSweep, _owner: string, every: number): Promise<SweepClaim> {
      fail('claimSweep'); calls.push(`claim:${sweep}`, `claim:${sweep}:${every}`)
      return { owned: opts.sweepOwned ?? true, lastStartedAt: null, lastOwner: 'another-tick' }
    },
    async sweepLeases() { fail('sweepLeases'); return opts.leases ?? { requeued: 0, retried: 0, needsHuman: 0, dead: 0, failed: 0, more: false } },
    async purgeTombstones(limit: number) { fail('purgeTombstones'); calls.push(`purgeTombstones:${limit}`); return opts.tombstones ?? { purged: 0, more: false } },
    async sweepSfLeases(limit: number) { fail('sweepSfLeases'); calls.push(`sweepSfLeases:${limit}`); return opts.sfLeases ?? { swept: 0, more: false } },
    async expireRuns() { fail('expireRuns'); return { expired: 0, more: false } },
    async queueDisagreements() {
      fail('queueDisagreements')
      return Array.from({ length: opts.disagreements ?? 0 }, (_, i) => ({ kind: 'waiting_run_without_queue_row', runRequestId: `r${i}`, organizationId: ORG }))
    },
    async saveCopies(_servedAt: string, _complete: boolean, list: readonly WorkflowCopyInput[]): Promise<SaveCopiesResult> {
      fail('saveCopies'); saved.push([...list]); return { inserted: list.length, updated: 0, confirmed: 0, refusedOlder: 0, withdrawn: 0 }
    },
    async readCopies() { fail('readCopies'); return { copies: opts.copies ?? [copy()], reachedLimit: false } },
    async recordObservation(_org: unknown, o: ScheduleObservation) { fail('recordObservation'); observations.push(o); return opts.observed?.(o) ?? 'recorded' },
    async dueQueueDepth() { fail('dueQueueDepth'); return { dueRuns: opts.dueRuns ?? 0, dueWorkflows: opts.dueRuns ? 1 : 0, oldestDue: null } },
    async saveConnectionCopies(_servedAt: string, _complete: boolean, list: readonly ConnectionCopyInput[]): Promise<SaveConnectionCopiesResult> {
      fail('saveConnectionCopies'); savedConnections.push([...list])
      return { inserted: list.length, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0 }
    },
    async recordConnectionTombstone() { fail('recordConnectionTombstone'); return { outcome: 'recorded' as const, copiesRemoved: 0 } },
    async removeUnservedMeasuredIdentities() { fail('removeUnservedMeasuredIdentities'); return opts.unservedRemoved ?? [] },
  }
  const dispatched: DispatchItem[] = []
  const stamps: string[] = []
  const reports: unknown[] = []
  const jobStamps: string[] = []
  const sfReads: string[] = []
  const probes: string[] = []
  const objectReads: string[] = []
  const definitionRequests: Array<{ versions: Array<{ workflow_id: string; version_number: number }> }> = []
  const ranRuns: string[] = []
  const ports: OpsTickPorts = {
    mode: opts.mode ?? 'observe',
    dispatchRun: async (run) => {
      ranRuns.push(run.runRequestId)
      return (opts.runReport ?? (async () => ({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' }) as RunInvocationReport))(run)
    },
    tickId: 'tick-1',
    resealSwitch: opts.resealSwitch,
    scheduledTime: Date.parse('2026-10-17T11:02:48.004Z'),
    now: () => WORKER_NOW,
    db: opts.db === 'not_configured'
      ? { notConfigured: 'OPS_SUPABASE_SECRET_KEY is not set, so the ops database cannot be reached', secrets: ['OPS_SUPABASE_SECRET_KEY'] }
      : db,
    checkSecrets: async () => {
      if (opts.secrets instanceof Error) throw opts.secrets
      return opts.secrets ?? []
    },
    gateway: {
      fetchWorkflows: opts.fetch ?? (async () => served()),
      fetchConnections: opts.fetchConnections ?? (async () => servedConnections()),
      started: async () => { stamps.push('started'); if (opts.stampFails) throw new Error('the gateway is not deployed') },
      completed: async (r) => { stamps.push('completed'); reports.push(r); if (opts.stampFails) throw new Error('the gateway is not deployed') },
      fetchDefinitions: async (request) => {
        definitionRequests.push(request)
        if (opts.serveDefs) return opts.serveDefs(request)
        return {
          definitions: request.versions.map((v) => ({ workflow_id: v.workflow_id, organization_id: ORG, version_number: v.version_number, definition: { nodes: [] } })),
          unserved: [],
        }
      },
      jobStarted: async (job) => { jobStamps.push(`started:${job}`); if (opts.jobStampFails) throw new Error('the gateway is not deployed') },
      jobCompleted: async (job) => { jobStamps.push(`completed:${job}`); if (opts.jobStampFails) throw new Error('the gateway is not deployed') },
    },
    sfLimits: {
      read: async (t, url) => {
        sfReads.push(url)
        return (opts.sfRead ?? (async () => Response.json({ DailyApiRequests: { Max: 1_680_000, Remaining: 1_205_253 } })))(t)
      },
      // The deadlines never pass unless a test makes them.
      sleep: () => new Promise<void>(() => undefined),
      log: () => undefined,
    },
    connectionCheck: {
      probe: async (t) => {
        probes.push(t.connectionId)
        return (opts.probe ?? (async () => ({ kind: 'measured', identity: { kind: 'salesforce', sfOrgId: '00Dst0000000001AAA', username: 'ops-one@example.com' } }) as const))(t)
      },
      sleep: () => new Promise<void>(() => undefined),
      log: () => undefined,
    },
    writeBacks: {
      read: async (t) => {
        objectReads.push(t.connectionId)
        return (opts.writeBack ?? (async () => ({ ok: true, state: 'none' })))(t)
      },
      sleep: () => new Promise<void>(() => undefined),
    },
    dispatch: async (item) => {
      if (opts.dispatchFails?.(item)) throw new Error('OpsInternal refused: bad_signature')
      dispatched.push(item)
    },
  }
  return { ports, db, dispatched, stamps, reports, jobStamps, sfReads, probes, objectReads, definitionRequests, ranRuns }
}

describe('a healthy tick', () => {
  it('fires on the database clock, records the slot it would fire, dispatches it, and reports ok with both stamps', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('ok')
    expect(report.problems).toEqual([])
    expect(report.mode).toBe('observe')
    expect(report.db_now).toBe(DB_NOW)
    expect(f.db.observations.map((o) => [o.scheduledFor.toISOString(), o.outcome, o.reason])).toEqual([['2026-10-17T10:00:00.000Z', 'would_fire', 'due']])
    expect(f.dispatched).toEqual([{ kind: 'would_fire', workflowId: WF_A, organizationId: ORG, scheduledFor: '2026-10-17T10:00:00.000Z', dispatchAt: '2026-10-17T10:00:00.000Z' }])
    expect(f.stamps).toEqual(['started', 'completed'])
    expect(f.reports).toEqual([report])
  })

  it('saves the served list before reading the copies, and records what a claim would find without claiming', async () => {
    const f = fake({ dueRuns: 3 })
    const report = await runOpsTick(f.ports)
    expect(f.db.saved).toHaveLength(1)
    expect(f.db.saved[0][0]).toMatchObject({ workflowId: WF_A, isActive: true, rowUpdatedAt: '2026-10-17T09:00:00.000Z' })
    expect(f.db.calls.indexOf('saveCopies')).toBeLessThan(f.db.calls.indexOf('readCopies'))
    expect(report.counts.due_runs).toBe(3)
    expect(report.counts.would_claim).toBe(3)
  })

  it('sends a probe through the dispatch path when nothing is due, so the path is proven every minute', async () => {
    const f = fake({ copies: [copy({ trigger: { type: 'http_webhook', config: {} } })] })
    await runOpsTick(f.ports)
    expect(f.dispatched).toEqual([{ kind: 'probe' }])
  })
})

describe('the copy rule (decision 4)', () => {
  it('plans from the copy the database holds after the save, not from its own fetch: a newer switch off saved by another tick wins', async () => {
    // This tick fetched the workflow on; another tick saved it off first.
    const f = fake({ copies: [copy({ isActive: false, mayStart: false, switchedOffAt: '2026-10-17T10:02:00.000Z' })] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(f.dispatched).toEqual([{ kind: 'probe' }])
    expect(report.counts.schedules_not_startable).toBe(1)
    expect(report.outcome).toBe('ok')
  })

  it('a fetch that fails with a saved copy plans from the copy, and says so', async () => {
    const f = fake({ fetch: async () => { throw new Error('the bidding database did not answer') } })
    const report = await runOpsTick(f.ports)
    expect(f.db.saved).toEqual([])
    expect(f.db.observations).toHaveLength(1)
    expect(report.outcome).toBe('problems')
    expect(report.problems.join(' ')).toMatch(/could not fetch the ops workflows from the bidding Worker \(the bidding database did not answer\), so it planned from the saved copies/)
    expect(report.counts.copies_used_saved).toBe(1)
  })

  it('a fetch that fails with no saved copy plans nothing, and says so', async () => {
    const f = fake({ fetch: async () => { throw new Error('binding refused') }, copies: [] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(report.outcome).toBe('problems')
    expect(report.problems.join(' ')).toMatch(/no saved copy/)
  })

  it('a served row it cannot read is refused by name and the list is not used to withdraw anything', async () => {
    let complete: boolean | null = null
    const f = fake({ fetch: async () => served([{}, { id: 'not-a-uuid' }]) })
    f.db.saveCopies = async (_s, c, list) => { complete = c; f.db.saved.push([...list]); return { inserted: 1, updated: 0, confirmed: 0, refusedOlder: 0, withdrawn: 0 } }
    const report = await runOpsTick(f.ports)
    expect(complete).toBe(false)
    expect(f.db.saved[0]).toHaveLength(1)
    expect(report.problems.join(' ')).toMatch(/workflow not-a-uuid in a shape the ops Worker does not read/)
  })
})

describe('failure boundaries', () => {
  it('not configured: says which secret, skips the database, still proves the gateway and the dispatch path', async () => {
    const f = fake({ db: 'not_configured' })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('not_configured')
    expect(report.problems[0]).toMatch(/OPS_SUPABASE_SECRET_KEY is not set/)
    expect(report.db_now).toBeNull()
    expect(f.db.calls).toEqual([])
    expect(f.dispatched).toEqual([{ kind: 'probe' }])
    expect(f.stamps).toEqual(['started', 'completed'])
    expect(report.not_configured_secrets).toEqual(['OPS_SUPABASE_SECRET_KEY'])
  })

  // #2333: the ops private key is checked every tick, so an unset or unusable key
  // pages before the first connection needs it, naming which secret.
  it('an unusable ops private key is reported not_configured by name, and every other job still runs', async () => {
    const f = fake({ secrets: [{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY', problem: 'OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.' }] })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
    expect(report.problems).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.'])
    // Nothing the observe tick does opens a connection yet, so the key stops none of it.
    expect(report.db_now).toBe(DB_NOW)
    expect(f.db.observations).toHaveLength(1)
    expect(f.dispatched).toHaveLength(1)
    expect(f.reports).toEqual([report])
  })

  it('names the database secret and the private key together when both are missing', async () => {
    const f = fake({ db: 'not_configured', secrets: [{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY', problem: 'the key is not set' }] })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('not_configured')
    expect(report.not_configured_secrets).toEqual(['OPS_SUPABASE_SECRET_KEY', 'OPS_CONNECTIONS_PRIVATE_KEY'])
  })

  it('a secrets check that throws is reported, never read as every secret being sound', async () => {
    const f = fake({ secrets: new Error('the key import crashed') })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('problems')
    expect(report.problems.join(' ')).toMatch(/could not check its secrets \(the key import crashed\)/)
    expect(f.db.observations).toHaveLength(1)
  })

  it('a healthy tick names no secret', async () => {
    const report = await runOpsTick(fake().ports)
    expect(report.not_configured_secrets).toEqual([])
  })

  it('a sweep claimed by another tick stands down, recorded and not a problem', async () => {
    const f = fake({ sweepOwned: false })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('sweepLeases')
    expect(f.db.calls).not.toContain('expireRuns')
    expect(f.db.calls).not.toContain('queueDisagreements')
    expect(f.db.calls).not.toContain('purgeTombstones')
    // The Salesforce lease sweep takes no claim, so a held interval never stops it.
    expect(f.db.calls).toContain('sweepSfLeases')
    // The sf_limits sweep stands down too: no orgs read, nothing stamped (#2336).
    expect(f.db.calls).not.toContain('sfLimitsTargets')
    // So does the connection_check sweep (#2340): nothing probed, nothing stamped,
    // while the login states are still read, as every tick reads them.
    expect(f.db.calls.filter((c) => c.startsWith('connectionCheckTargets:'))).toEqual([`connectionCheckTargets:${CONNECTION_LOGINS_READ_LIMIT}`])
    expect(f.jobStamps).toEqual([])
    expect(report.counts.sweeps_stood_down).toBe(6)
    expect(report.outcome).toBe('ok')
  })

  it('counts every run the lease sweep moved, the runs it ended failed included (#2334)', async () => {
    const f = fake({ leases: { requeued: 1, retried: 2, needsHuman: 3, dead: 4, failed: 5, more: false } })
    const report = await runOpsTick(f.ports)
    expect(report.counts.leases_swept).toBe(15)
  })

  it('a statement past its deadline is reported as possibly committed, and every other job still runs', async () => {
    const f = fake({ failing: { saveCopies: new OpsWriteTimeoutError('save_workflow_copies passed its 9000 ms deadline and may still have committed') } })
    const report = await runOpsTick(f.ports)
    expect(report.problems.join(' ')).toMatch(/may still have committed/)
    expect(f.db.calls).toContain('readCopies')
    expect(f.db.calls).toContain('sweepLeases')
    expect(f.db.observations).toHaveLength(1)
  })

  it('a database clock that cannot be read plans nothing, since no fire may be computed on the Worker clock', async () => {
    const f = fake({ failing: { now: new Error('connection refused') } })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(report.db_now).toBeNull()
    expect(report.problems.join(' ')).toMatch(/could not read the database clock/)
  })

  it('one sweep failing does not stop the others, the copies or the schedules', async () => {
    const f = fake({ failing: { sweepLeases: new Error('lock timeout') } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('expireRuns')
    expect(f.db.calls).toContain('queueDisagreements')
    expect(f.db.calls).toContain('purgeTombstones')
    expect(f.db.calls).toContain('sweepSfLeases')
    expect(f.db.observations).toHaveLength(1)
    expect(report.problems.join(' ')).toMatch(/lease_expiry sweep failed: lock timeout/)
  })

  it('a tombstone sweep that throws is reported by name and stops neither the other sweeps nor the schedules (#2334)', async () => {
    const f = fake({ failing: { purgeTombstones: new Error('lock timeout') } })
    const report = await runOpsTick(f.ports)
    expect(report.problems).toEqual(['The tombstone_expiry sweep failed: lock timeout.'])
    expect(report.problem_keys).toEqual(['sweep_failed:tombstone_expiry'])
    expect(f.db.calls).toEqual(expect.arrayContaining(['sweepLeases', 'expireRuns', 'queueDisagreements', 'sweepSfLeases', 'saveConnectionCopies']))
    expect(f.db.observations).toHaveLength(1)
    expect(f.dispatched).toHaveLength(1)
  })

  it('a Salesforce lease sweep that throws is reported by name and stops neither the other sweeps nor the schedules (#2334)', async () => {
    const f = fake({ failing: { sweepSfLeases: new Error('statement timeout') } })
    const report = await runOpsTick(f.ports)
    expect(report.problems).toEqual(['The sf_lease_expiry sweep failed: statement timeout.'])
    expect(report.problem_keys).toEqual(['sweep_failed:sf_lease_expiry'])
    expect(f.db.calls).toEqual(expect.arrayContaining(['sweepLeases', 'expireRuns', 'queueDisagreements', 'purgeTombstones', 'saveConnectionCopies']))
    expect(f.db.observations).toHaveLength(1)
    expect(f.dispatched).toHaveLength(1)
  })

  it('reports a disagreement between the queue and the runs', async () => {
    const report = await runOpsTick(fake({ disagreements: 2 }).ports)
    expect(report.problems.join(' ')).toMatch(/2 runs where the run queue and the runs disagree/)
  })

  it('one schedule that cannot be planned does not stop another', async () => {
    const bad = copy({ workflowId: WF_B, trigger: schedule({ ...every5, interval_seconds: 30 }) })
    const f = fake({ copies: [bad, copy()] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations.map((o) => o.workflowId)).toEqual([WF_A])
    expect(report.problems.join(' ')).toMatch(new RegExp(`The schedule of workflow ${WF_B} is refused: an interval of 30 seconds`))
  })

  it('one schedule whose recording throws does not stop the next', async () => {
    const f = fake({ copies: [copy({ workflowId: WF_B }), copy()] })
    const record = f.db.recordObservation.bind(f.db)
    f.db.recordObservation = async (org, o) => {
      if (o.workflowId === WF_B) throw new Error('record_schedule_observation failed (57014): canceling statement due to statement timeout')
      return record(org, o)
    }
    const report = await runOpsTick(f.ports)
    expect(f.db.observations.map((o) => o.workflowId)).toEqual([WF_A])
    expect(report.problems.join(' ')).toMatch(new RegExp(`The schedule of workflow ${WF_B} could not be planned: .*statement timeout`))
  })

  it('a schedule whose workflow has no saved version is refused rather than fired as version 0', async () => {
    const f = fake({ copies: [copy({ versionNumber: null })] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(report.problems.join(' ')).toMatch(/has no saved version/)
  })

  it('one dispatch failing does not stop another', async () => {
    const f = fake({
      copies: [copy(), copy({ workflowId: WF_B })],
      dispatchFails: (item) => item.kind === 'would_fire' && item.workflowId === WF_A,
    })
    const report = await runOpsTick(f.ports)
    expect(f.dispatched.map((d) => d.kind === 'would_fire' && d.workflowId)).toEqual([WF_B])
    expect(report.problems.join(' ')).toMatch(/dispatch of workflow 00000000-0000-4000-8000-0000000019a1's Oct 17, 6:00 AM ET slot failed: OpsInternal refused: bad_signature/)
  })

  it('a failed started stamp is reported and the tick still runs; a failed completed stamp still returns the report', async () => {
    const f = fake({ stampFails: true })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toHaveLength(1)
    expect(report.problems.join(' ')).toMatch(/could not stamp its start with the bidding Worker/)
  })

  // #2410 added the flag; since #2506 the stamp's problem is keyed start_stamp
  // and held, like every transient kind, until three ticks in a row miss. The
  // flag stays, and claims nothing it did not measure.
  it('says in the report whether the start stamp failed, and claims nothing it did not measure', async () => {
    const failed = await runOpsTick(fake({ stampFails: true }).ports)
    expect(failed.start_stamp_failed).toBe(true)
    expect(failed.problems).toEqual(['The ops tick could not stamp its start with the bidding Worker (the gateway is not deployed).'])
    expect(failed.problem_keys).toEqual(['start_stamp'])
    const stamped = await runOpsTick(fake().ports)
    expect(stamped.start_stamp_failed).toBe(false)
  })
})

describe('slots', () => {
  it('a slot another tick already recorded is not dispatched again (a doubled or overlapping tick)', async () => {
    const f = fake({ observed: () => 'already_recorded' })
    const report = await runOpsTick(f.ports)
    expect(f.dispatched).toEqual([{ kind: 'probe' }])
    expect(report.counts.slots_already_recorded).toBe(1)
  })

  it('a missed slot is recorded once and reported', async () => {
    const f = fake({ copies: [copy({ scheduleKnownSince: '2026-10-17T09:00:00.000Z', lastObserved: '2026-10-17T09:30:00.000Z' })] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations.map((o) => [o.scheduledFor.toISOString(), o.outcome, o.reason])).toEqual([
      ['2026-10-17T10:00:00.000Z', 'would_fire', 'due'],
      ['2026-10-17T09:55:00.000Z', 'missed', 'catch_up_none'],
    ])
    expect(report.problems.join(' ')).toMatch(/Workflow 00000000-0000-4000-8000-0000000019a1 missed its Oct 17, 5:55 AM ET slot \(catch_up_none\)/)
  })

  it('a missed slot another tick already reported is not reported twice', async () => {
    const f = fake({
      copies: [copy({ scheduleKnownSince: '2026-10-17T09:00:00.000Z', lastObserved: '2026-10-17T09:30:00.000Z' })],
      observed: (o) => (o.outcome === 'missed' ? 'already_recorded' : 'recorded'),
    })
    const report = await runOpsTick(f.ports)
    expect(report.problems).toEqual([])
  })

  it('never fires a slot at or before the floor', async () => {
    const f = fake({ copies: [copy({ scheduleKnownSince: '2026-10-17T10:00:00.000Z' })] })
    await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
  })
})

describe('the floor of a ported or replacing workflow (#1952, #1698 D8)', () => {
  /**
   * Weekly, Saturdays 06:00 UTC, catching up the latest missed slot within 72
   * hours. The database clock reads Saturday 2026-10-17 10:02:30, so the 06:00
   * slot is missed and, from a floor before it, caught up.
   */
  const weekly = schedule({ cron: '0 6 * * SAT', timezone: 'UTC', overlap: 'skip', catch_up: 'latest', catch_up_window_seconds: 259_200, jitter_max_seconds: 0 })
  /** Known since a week ago, observed nothing yet: on its own, the 06:00 slot is caught up. */
  const weeklyCopy = (over: Partial<WorkflowCopy> = {}) => copy({ trigger: weekly, scheduleKnownSince: '2026-10-10T07:00:00.000Z', ...over })
  const ported = (cutoverAt: string | null) => ({ ported: true, cutoverAt, replaces: [], servedAt: '2026-10-17T11:02:31.000Z' })
  const slots = (f: Fake) => f.db.observations.map((o) => [o.scheduledFor.toISOString(), o.outcome, o.reason])

  it('catches up the missed slot from a floor before it (the control the cases below are measured against)', async () => {
    const f = fake({ copies: [weeklyCopy()] })
    await runOpsTick(f.ports)
    expect(slots(f)).toEqual([['2026-10-17T06:00:00.000Z', 'would_fire', 'catch_up']])
  })

  it('never catches up a period before the cutover, which Pipedream already ran', async () => {
    const f = fake({ copies: [weeklyCopy({ porting: ported('2026-10-17T07:00:00.000Z') })] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(report.problems).toEqual([])
  })

  it('a slot exactly at the cutover instant is not fired either: Pipedream may have run it', async () => {
    const f = fake({ copies: [weeklyCopy({ porting: ported('2026-10-17T06:00:00.000Z') })] })
    await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
  })

  it('fires slots after the cutover', async () => {
    const f = fake({ copies: [weeklyCopy({ porting: ported('2026-10-17T05:00:00.000Z') })] })
    await runOpsTick(f.ports)
    expect(slots(f)).toEqual([['2026-10-17T06:00:00.000Z', 'would_fire', 'catch_up']])
  })

  it('a ported workflow not cut over yet fires nothing and reports nothing missed, since Pipedream may still run every period, and says so in a log line', async () => {
    const lines = captureLog()
    try {
      const f = fake({ copies: [copy({ porting: ported(null) })] })
      const report = await runOpsTick(f.ports)
      expect(f.db.observations).toEqual([])
      expect(report.counts.schedules_awaiting_cutover).toBe(1)
      expect(report.problems).toEqual([])
      expect(lines().find((l) => l.step === 'schedule_awaiting_cutover')).toMatchObject({ workflow_id: WF_A })
    } finally {
      lines.restore()
    }
  })

  it('never re-fires a slot the workflow it replaces already served', async () => {
    // A converter rerun at 05:00 minted this id; the old one served 06:00.
    const replacing = { ported: false, cutoverAt: null, replaces: [WF_B], servedAt: '2026-10-17T11:02:31.000Z' }
    const f = fake({ copies: [weeklyCopy({ scheduleKnownSince: '2026-10-17T05:00:00.000Z', porting: replacing, replacedLastSlot: '2026-10-17T06:00:00.000Z' })] })
    await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    // An older served slot of the old one floors nothing after it.
    const older = fake({ copies: [weeklyCopy({ scheduleKnownSince: '2026-10-17T05:00:00.000Z', porting: replacing, replacedLastSlot: '2026-10-10T06:00:00.000Z' })] })
    await runOpsTick(older.ports)
    expect(slots(older)).toEqual([['2026-10-17T06:00:00.000Z', 'would_fire', 'catch_up']])
  })

  it('in live mode too: the floor holds back a real fire, not only an observation', async () => {
    const f = fake({ mode: 'live', copies: [weeklyCopy({ porting: ported('2026-10-17T07:00:00.000Z') })] })
    await runOpsTick(f.ports)
    expect(f.db.fires).toEqual([])
    const control = fake({ mode: 'live', copies: [weeklyCopy()] })
    await runOpsTick(control.ports)
    expect(control.db.fires.map((x) => x.fire.scheduledFor.toISOString())).toEqual(['2026-10-17T06:00:00.000Z'])
  })

  it('a copy never told its porting facts fires nothing, and pages once it lasts, since its floor is unknown', async () => {
    const f = fake({ copies: [copy({ porting: null })] })
    const report = await runOpsTick(f.ports)
    expect(f.db.observations).toEqual([])
    expect(report.counts.schedules_floor_unknown).toBe(1)
    expect(report.problem_keys).toEqual([`schedule_floor_unknown:${WF_A}`])
    expect(OPS_TICK_PROBLEM_RULES.schedule_floor_unknown).toBe('three_in_a_row')
    expect(report.problems.join(' ')).toMatch(/does not say whether it was ported from Pipedream/)
  })

  it('saves the porting facts the bidding Worker served with each copy', async () => {
    const f = fake({ fetch: async () => served([{ porting: { ported: true, cutover_at: '2026-10-17T07:00:00.000Z', replaces: [WF_B] } }]) })
    await runOpsTick(f.ports)
    expect(f.db.saved[0][0].porting).toEqual({ ported: true, cutoverAt: '2026-10-17T07:00:00.000Z', replaces: [WF_B] })
  })

  it('with the bidding Worker unreachable, plans from the facts its copy last served, never firing before that cutover, and says where the floor came from', async () => {
    const lines = captureLog()
    try {
      const f = fake({
        fetch: async () => { throw new Error('the bidding database did not answer') },
        copies: [weeklyCopy({ porting: { ...ported('2026-10-17T07:00:00.000Z'), servedAt: '2026-10-17T09:30:00.000Z' } })],
      })
      await runOpsTick(f.ports)
      expect(f.db.observations).toEqual([])
      expect(lines().find((l) => l.step === 'schedule_floor_from_copy')).toMatchObject({
        workflow_id: WF_A, floor: '2026-10-17T07:00:00.000Z', porting_served_at: '2026-10-17T09:30:00.000Z', cutover_at: '2026-10-17T07:00:00.000Z',
      })
    } finally {
      lines.restore()
    }
  })
})

/** The tick's own log lines (JSON on console.log), captured for one case. */
function captureLog(): (() => Array<Record<string, unknown>>) & { restore: () => void } {
  const seen: Array<Record<string, unknown>> = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    try {
      seen.push(JSON.parse(String(args[0])) as Record<string, unknown>)
    } catch {
      // not one of the tick's JSON lines
    }
  }
  return Object.assign(() => seen, { restore: () => { console.log = original } })
}

/** One claimed run of `workflowId`. */
function claimedRun(workflowId: string, n: number, over: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    runRequestId: `0192f4a0-0000-7000-8000-${String(n).padStart(12, '0')}`, organizationId: ORG, workflowId, workflowVersion: 3,
    triggerKind: 'schedule', claimToken: `token-${n}`, claimExpiresAt: '2026-10-17T10:03:30.000Z', stateVersion: 2,
    attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
    executionChainId: `0192f4a0-0000-7000-9000-${String(n).padStart(12, '0')}`, resumedFromExecutionId: null, payload: null, payloadRef: null,
    ...over,
  }
}

describe('live mode (#1950): real fires, the claim and run dispatch', () => {
  it('observe mode, as deployed, records observations and never claims or fires', async () => {
    const f = fake({ claimed: [claimedRun(WF_A, 1)] })
    const report = await runOpsTick(f.ports)
    expect(report.mode).toBe('observe')
    expect(f.db.fires).toEqual([])
    expect(f.db.calls).not.toContain('claimRuns')
    expect(f.ranRuns).toEqual([])
  })

  it('records a due slot as a real fire with its schedule\'s overlap, and observes nothing it would fire', async () => {
    const f = fake({ mode: 'live' })
    const report = await runOpsTick(f.ports)
    expect(report.mode).toBe('live')
    expect(f.db.fires).toEqual([{ organizationId: ORG, fire: {
      workflowId: WF_A, workflowVersion: 3, scheduledFor: new Date('2026-10-17T10:00:00.000Z'), previousScheduledFor: null, overlap: 'skip',
    } }])
    expect(f.db.observations.filter((o) => o.outcome === 'would_fire')).toEqual([])
    expect(f.dispatched.filter((d) => d.kind === 'would_fire')).toEqual([])
    expect(report.counts.fires_enqueued).toBe(1)
  })

  it('plans from the later of the last real fire and the last observed slot, so going live re-fires nothing observe already passed', async () => {
    const f = fake({ mode: 'live', copies: [copy({ lastServed: null, lastObserved: '2026-10-17T10:00:00.000Z' })] })
    await runOpsTick(f.ports)
    expect(f.db.fires).toEqual([])
    // An older real fire does not stand in front of a later observed slot.
    const both = fake({ mode: 'live', copies: [copy({ lastServed: '2026-10-17T09:55:00.000Z', lastObserved: '2026-10-17T10:00:00.000Z' })] })
    await runOpsTick(both.ports)
    expect(both.db.fires).toEqual([])
  })

  it('claims with k per workflow and its run lease, hands each claimed run to OpsInternal.run, and counts what they ended as', async () => {
    const f = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2)] })
    const report = await runOpsTick(f.ports)
    expect(f.db.claims).toEqual([{ worker: 'tick-1', limit: TICK_CLAIM_LIMIT, perWorkflow: TICK_CLAIM_PER_WORKFLOW, leaseSeconds: RUN_LEASE_SECONDS }])
    expect(f.ranRuns.sort()).toEqual([claimedRun(WF_A, 1).runRequestId, claimedRun(WF_A, 2).runRequestId])
    expect(report.counts).toMatchObject({ runs_claimed: 2, runs_done: 2 })
    expect(report.outcome).toBe('ok')
  })

  it('ends a claimed run of a workflow switched off, deleted or with no copy, without running it', async () => {
    const WF_C = '00000000-0000-4000-8000-0000000019a3'
    const f = fake({
      mode: 'live',
      copies: [copy(), copy({ workflowId: WF_B, isActive: false, mayStart: false }), copy({ workflowId: WF_C, deletedAt: '2026-10-17T09:30:00.000Z', mayStart: false })],
      claimed: [claimedRun(WF_B, 1), claimedRun(WF_C, 2), claimedRun('00000000-0000-4000-8000-0000000019ff', 3)],
    })
    await runOpsTick(f.ports)
    expect(f.ranRuns).toEqual([])
    expect(f.db.completed.map((c) => c.end)).toEqual([
      { outcome: 'dead', reason: 'workflow_inactive' }, { outcome: 'dead', reason: 'workflow_deleted' }, { outcome: 'dead', reason: 'workflow_deleted' },
    ])
  })

  it('refuses to fire or start anything from copies last confirmed more than 6 hours ago, and pages at once (Dan, 2026-10-22)', async () => {
    expect(COPIES_STALE_AFTER_MS).toBe(6 * 3600_000)
    const stale = new Date(Date.parse(DB_NOW) - COPIES_STALE_AFTER_MS - 60_000).toISOString()
    const f = fake({
      mode: 'live', fetch: async () => { throw new Error('the bidding database did not answer') },
      copies: [copy({ confirmedAt: stale })], claimed: [claimedRun(WF_A, 1)],
    })
    const report = await runOpsTick(f.ports)
    expect(f.db.fires).toEqual([])
    expect(f.db.calls).not.toContain('claimRuns')
    expect(f.ranRuns).toEqual([])
    expect(report.problem_keys).toContain('copies_stale')
    expect(OPS_TICK_PROBLEM_RULES.copies_stale).toBe('at_once')
  })

  it('within the 6 hours, a bidding outage still fires and runs from the saved copies', async () => {
    const recent = new Date(Date.parse(DB_NOW) - COPIES_STALE_AFTER_MS + 60_000).toISOString()
    const f = fake({ mode: 'live', fetch: async () => { throw new Error('down') }, copies: [copy({ confirmedAt: recent })], claimed: [claimedRun(WF_A, 1)] })
    const report = await runOpsTick(f.ports)
    expect(f.db.fires).toHaveLength(1)
    expect(f.ranRuns).toHaveLength(1)
    expect(report.problem_keys).not.toContain('copies_stale')
  })

  it('a withdrawn copy, which no served list confirms again, never holds the live tick on its own age', async () => {
    const recent = new Date(Date.parse(DB_NOW) - 60_000).toISOString()
    const longAgo = new Date(Date.parse(DB_NOW) - 3 * COPIES_STALE_AFTER_MS).toISOString()
    const f = fake({
      mode: 'live',
      copies: [copy({ confirmedAt: recent }), copy({ workflowId: WF_B, confirmedAt: longAgo, withdrawnAt: longAgo, mayStart: false })],
      claimed: [claimedRun(WF_A, 1)],
    })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).not.toContain('copies_stale')
    expect(f.ranRuns).toHaveLength(1)
  })

  it('one run whose dispatch throws stops none of the others (L73)', async () => {
    const f = fake({
      mode: 'live', claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2)],
      runReport: async (run) => { if (run.runRequestId.endsWith('1')) throw new Error('OpsInternal.run did not answer'); return { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' } },
    })
    const report = await runOpsTick(f.ports)
    expect(f.ranRuns).toHaveLength(2)
    expect(report.counts).toMatchObject({ runs_done: 1, runs_lost: 1 })
  })

  it('claims nothing when the copies could not be read, rather than ending every claimed run as of a deleted workflow', async () => {
    const f = fake({ mode: 'live', failing: { readCopies: new Error('the ops database did not answer') }, claimed: [claimedRun(WF_A, 1)] })
    await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('claimRuns')
    expect(f.db.completed).toEqual([])
  })

  it('a claim that fails is its own problem, held for three ticks, and the schedules still fire', async () => {
    const f = fake({ mode: 'live', failing: { claimRuns: new Error('lock timeout') } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('claim_failed')
    expect(OPS_TICK_PROBLEM_RULES.claim_failed).toBe('three_in_a_row')
    expect(f.db.fires).toHaveLength(1)
  })
})

describe('run outcomes counted against a rate (L77, #1950)', () => {
  const unknown: RunInvocationReport = { outcome: 'completed', end: { outcome: 'needs_human', reason: 'send_outcome_unknown', error: 'x' }, runStatus: 'needs_human' }
  const requeued: RunInvocationReport = { outcome: 'completed', end: { outcome: 'retry', error: 'step a: rate_limited' }, runStatus: 'queued' }
  const lost: RunInvocationReport = { outcome: 'claim_lost', during: 'heartbeat' }

  it('pages at once for a run whose send outcome is unknown, since a person must resolve it', async () => {
    const f = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1)], runReport: async () => unknown })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain(`run_outcome_unknown:${WF_A}`)
    expect(OPS_TICK_PROBLEM_RULES.run_outcome_unknown).toBe('at_once')
    expect(report.counts.runs_unknown).toBe(1)
  })

  it('pages, held for three ticks, when lost and requeued runs of one workflow reach the rate, and only at the minimum count', async () => {
    expect(RUN_OUTCOME_MIN_RUNS).toBe(3)
    expect(RUN_OUTCOME_FAILING_RATE).toBe(0.5)
    const reports = [lost, requeued, { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' } as RunInvocationReport]
    const f = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2), claimedRun(WF_A, 3)], runReport: async (run) => reports[Number(run.runRequestId.slice(-1)) - 1] })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain(`runs_failing:${WF_A}`)
    expect(OPS_TICK_PROBLEM_RULES.runs_failing).toBe('three_in_a_row')
    expect(report.counts).toMatchObject({ runs_lost: 1, runs_requeued: 1, runs_done: 1 })

    // Below the minimum count, the same rate is not judged (L716).
    const few = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2)], runReport: async () => lost })
    expect((await runOpsTick(few.ports)).problem_keys ?? []).not.toContain(`runs_failing:${WF_A}`)
  })

  // #2859: a step stopped at the requeue cap is its own tally, counted against
  // the same rate, and its error names the step, host and status, so a host that
  // keeps refusing is seen.
  it('counts a run stopped at the requeue cap against the rate, naming the host that kept refusing', async () => {
    const capped: RunInvocationReport = {
      outcome: 'completed',
      end: { outcome: 'suspend', reason: 'rate_limit_wait', step: 'post', status: 429, notBefore: new Date(WORKER_NOW + 60_000), error: 'step post (POST quota.example.com): rate_limited, answered 429, asked to wait until 2026-10-17T10:03:31.000Z' },
      runStatus: 'failed',
    }
    const waiting: RunInvocationReport = { ...capped, runStatus: 'suspended' }
    const done: RunInvocationReport = { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' }
    const reports = [capped, capped, done]
    const f = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2), claimedRun(WF_A, 3)], runReport: async (run) => reports[Number(run.runRequestId.slice(-1)) - 1] })
    const report = await runOpsTick(f.ports)
    expect(report.counts).toMatchObject({ runs_requeue_capped: 2, runs_done: 1 })
    expect(report.counts.runs_failed).toBeUndefined()
    expect(report.problem_keys).toContain(`runs_failing:${WF_A}`)
    expect(report.problems.join(' ')).toMatch(/2 stopped at the requeue cap/)
    expect(report.problems.join(' ')).toContain('POST quota.example.com')

    // A wait the database took is a requeue, not the cap.
    const w = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1)], runReport: async () => waiting })
    expect((await runOpsTick(w.ports)).counts).toMatchObject({ runs_requeued: 1 })
  })

  it('a resource wait the database ended past its 24 hours is counted failed, not requeued', async () => {
    const exceeded: RunInvocationReport = { outcome: 'completed', end: { outcome: 'suspend', reason: 'resource_wait', cause: 'pool_full', notBefore: new Date(WORKER_NOW) }, runStatus: 'failed' }
    const f = fake({ mode: 'live', claimed: [claimedRun(WF_A, 1)], runReport: async () => exceeded })
    const counts = (await runOpsTick(f.ports)).counts
    expect(counts.runs_failed).toBe(1)
    expect(counts.runs_requeued).toBeUndefined()
  })

  it('counts each workflow apart: one workflow failing does not page for another', async () => {
    const f = fake({
      mode: 'live',
      copies: [copy(), copy({ workflowId: WF_B, trigger: { type: 'http_webhook', config: {} } })],
      claimed: [claimedRun(WF_A, 1), claimedRun(WF_A, 2), claimedRun(WF_A, 3), claimedRun(WF_B, 4), claimedRun(WF_B, 5), claimedRun(WF_B, 6)],
      runReport: async (run) => (run.workflowId === WF_A ? lost : { outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' }),
    })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain(`runs_failing:${WF_A}`)
    expect(report.problem_keys).not.toContain(`runs_failing:${WF_B}`)
  })

  it('pages at once when the lease sweep sends a lapsed run with a send to a person', async () => {
    const f = fake({ leases: { requeued: 0, retried: 0, needsHuman: 2, dead: 0, failed: 0, more: false } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('runs_lapsed_after_send')
    expect(OPS_TICK_PROBLEM_RULES.runs_lapsed_after_send).toBe('at_once')
  })
})

describe('the frozen definition copies (#1950)', () => {
  const WF_D = '00000000-0000-4000-8000-0000000019d1'
  const missing = [{ workflowId: WF_D, organizationId: ORG, versionNumber: 3 }]

  it('asks for nothing when every current version is held', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain(`missingDefinitions:${DEFINITIONS_READ_LIMIT}`)
    expect(f.definitionRequests).toEqual([])
    expect(report.outcome).toBe('ok')
  })

  it('asks at most DEFINITIONS_PER_TICK versions a tick, in requests of MAX_DEFINITIONS_PER_REQUEST, starting where the minute says, so versions that can never be served cannot starve the rest (L778)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ workflowId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, organizationId: ORG, versionNumber: 1 }))
    const f = fake({ missingDefs: many, serveDefs: async () => ({ definitions: [], unserved: [] }) })
    await runOpsTick(f.ports)
    const asked = f.definitionRequests.flatMap((r) => r.versions.map((v) => v.workflow_id))
    expect(f.definitionRequests.every((r) => r.versions.length <= MAX_DEFINITIONS_PER_REQUEST)).toBe(true)
    expect(asked).toHaveLength(DEFINITIONS_PER_TICK)
    // The window starts at the tick's minute of the epoch times DEFINITIONS_PER_TICK, modulo the list's length, and wraps round it.
    const start = (Math.floor(WORKER_NOW / 60_000) * DEFINITIONS_PER_TICK) % many.length
    expect(asked[0]).toBe(many[start].workflowId)
    // The next minute asks the ones this minute did not reach.
    const next = fake({ missingDefs: many, serveDefs: async () => ({ definitions: [], unserved: [] }) })
    await runOpsTick({ ...next.ports, now: () => WORKER_NOW + 60_000 })
    const nextAsked = next.definitionRequests.flatMap((r) => r.versions.map((v) => v.workflow_id))
    expect(new Set([...asked, ...nextAsked]).size).toBe(many.length)
  })

  it('stops asking after a request fails, so a bidding outage costs the tick one request deadline, not one per batch', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ workflowId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, organizationId: ORG, versionNumber: 1 }))
    const f = fake({ missingDefs: many, serveDefs: async () => { throw new Error('the bidding Worker did not answer within 15 s') } })
    const report = await runOpsTick(f.ports)
    expect(f.definitionRequests).toHaveLength(1)
    expect(report.problem_keys).toContain('definitions_failed')
  })

  it('pages at once when more versions are missing than one read lists', async () => {
    const many = Array.from({ length: DEFINITIONS_READ_LIMIT }, (_, i) => ({ workflowId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, organizationId: ORG, versionNumber: 1 }))
    const report = await runOpsTick(fake({ missingDefs: many, serveDefs: async () => ({ definitions: [], unserved: [] }) }).ports)
    expect(report.problem_keys).toContain('definitions_backlog')
    expect(OPS_TICK_PROBLEM_RULES.definitions_backlog).toBe('at_once')
  })

  it('asks the bidding Worker for each version not held, and saves what it serves within the copy\'s organization', async () => {
    const f = fake({ missingDefs: missing })
    const report = await runOpsTick(f.ports)
    expect(f.definitionRequests).toEqual([{ versions: [{ workflow_id: WF_D, version_number: 3 }] }])
    expect(f.db.savedDefinitions).toEqual([{ organizationId: ORG, workflowId: WF_D, versionNumber: 3, definition: { nodes: [] } }])
    expect(report.counts.definitions_saved).toBe(1)
    expect(report.outcome).toBe('ok')
  })

  it('pages at once on a conflict, a version the bidding Worker cannot serve, and a definition served under another organization', async () => {
    const other = '7a1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f61'
    const f = fake({
      missingDefs: [...missing, { workflowId: WF_A, organizationId: ORG, versionNumber: 2 }, { workflowId: WF_B, organizationId: ORG, versionNumber: 5 }],
      serveDefs: async () => ({
        definitions: [
          { workflow_id: WF_D, organization_id: ORG, version_number: 3, definition: { nodes: [] } },
          { workflow_id: WF_B, organization_id: other, version_number: 5, definition: { nodes: [] } },
        ],
        unserved: [{ workflow_id: WF_A, version_number: 2 }],
      }),
      saveDef: () => 'conflict',
    })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toEqual(expect.arrayContaining([`definition_conflict:${WF_D}`, `definition_unserved:${WF_A}`, `definition_refused:${WF_B}`]))
    for (const k of ['definition_conflict', 'definition_unserved', 'definition_refused'] as const) expect(OPS_TICK_PROBLEM_RULES[k]).toBe('at_once')
    expect(f.db.savedDefinitions.map((s) => s.workflowId)).toEqual([WF_D])
  })

  it('a fetch that fails is held for three ticks, and stops nothing else', async () => {
    const f = fake({ missingDefs: missing, serveDefs: async () => { throw new Error('the bidding Worker did not answer') } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('definitions_failed')
    expect(OPS_TICK_PROBLEM_RULES.definitions_failed).toBe('three_in_a_row')
    expect(f.dispatched.length).toBeGreaterThan(0)
  })

  it('one save that fails is that version\'s problem, and the next is still saved', async () => {
    const f = fake({
      missingDefs: [...missing, { workflowId: WF_A, organizationId: ORG, versionNumber: 2 }],
      failing: {},
      saveDef: (wf) => { if (wf === WF_D) throw new Error('lock timeout'); return 'saved' },
    })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain(`definition_save_failed:${WF_D}`)
    expect(OPS_TICK_PROBLEM_RULES.definition_save_failed).toBe('three_in_a_row')
    expect(report.counts.definitions_saved).toBe(1)
  })
})

describe('the observation purge (#1950: schedule_fire_observations kept 30 days, purged nightly)', () => {
  // DB_NOW is 06:02 Eastern; the purge is claimed only in the 03:00 Eastern hour, on the database clock.
  const NIGHT = '2026-10-17T07:15:00.000Z' // 03:15 EDT

  it('is not claimed outside its night hour', async () => {
    const f = fake({})
    await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('claim:observation_purge')
    expect(f.db.calls).not.toContain('purgeObservations')
  })

  it('is claimed for 20 hours in the 03:00 Eastern hour, pages while there is more, and counts what it purged', async () => {
    const f = fake({ dbNow: NIGHT, observationsPurge: { purged: 1000, more: true } })
    const report = await runOpsTick(f.ports)
    expect(OBSERVATION_PURGE_EVERY_SECONDS).toBe(20 * 3600)
    expect(f.db.calls).toContain(`claim:observation_purge:${OBSERVATION_PURGE_EVERY_SECONDS}`)
    expect(f.db.calls.filter((c) => c === 'purgeObservations')).toHaveLength(10)
    expect(f.db.calls).toContain('purgeObservations:1000')
    expect(report.counts.observations_purged).toBe(10_000)
  })

  // #2339: a step's test result is kept 7 days, the same as run history; this
  // nightly sweep deletes the ones past that, by the database clock.
  it('purges step test results past 7 days in the same night, paging while there is more, and counts them', async () => {
    const f = fake({ dbNow: NIGHT, stepTestsPurge: { purged: 1000, more: true } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('purgeStepTests:1000')
    expect(f.db.calls.filter((c) => c === 'purgeStepTests')).toHaveLength(10)
    expect(report.counts.step_tests_purged).toBe(10_000)
    const quiet = fake({})
    await runOpsTick(quiet.ports)
    expect(quiet.db.calls).not.toContain('purgeStepTests')
  })

  it('a failed observation purge still lets the step test purge run that night, and is the sweep\'s problem', async () => {
    const f = fake({ dbNow: NIGHT, failing: { purgeObservations: new Error('lock timeout') }, stepTestsPurge: { purged: 3, more: false } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('purgeStepTests:1000')
    expect(report.counts.step_tests_purged).toBe(3)
    expect(report.problem_keys).toContain('sweep_failed:observation_purge')
  })

  // #2703: each step of an ops run is kept 7 days, deleted with its run, the
  // same as run history; this nightly sweep deletes the records past that.
  it('purges the step records of runs past 7 days in the same night, paging while there is more, and counts them', async () => {
    const f = fake({ dbNow: NIGHT, stepRecordsPurge: { purged: 1000, more: true } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('purgeStepRecords:1000')
    expect(f.db.calls.filter((c) => c === 'purgeStepRecords')).toHaveLength(10)
    expect(report.counts.step_records_purged).toBe(10_000)
    const quiet = fake({})
    await runOpsTick(quiet.ports)
    expect(quiet.db.calls).not.toContain('purgeStepRecords')
  })

  it('each of the three purges runs that night whatever the others did, and a failure of any is the sweep\'s problem', async () => {
    const both = fake({ dbNow: NIGHT, failing: { purgeObservations: new Error('lock timeout'), purgeStepTests: new Error('lock timeout') }, stepRecordsPurge: { purged: 4, more: false } })
    const report = await runOpsTick(both.ports)
    expect(both.db.calls).toContain('purgeStepRecords:1000')
    expect(report.counts.step_records_purged).toBe(4)
    expect(report.problem_keys).toContain('sweep_failed:observation_purge')

    const records = fake({ dbNow: NIGHT, failing: { purgeStepRecords: new Error('lock timeout') }, observationsPurge: { purged: 2, more: false }, stepTestsPurge: { purged: 1, more: false } })
    const failed = await runOpsTick(records.ports)
    expect(failed.counts.observations_purged).toBe(2)
    expect(failed.counts.step_tests_purged).toBe(1)
    expect(failed.problem_keys).toContain('sweep_failed:observation_purge')
  })

  it('a failed step test purge is the sweep\'s problem and stops nothing else', async () => {
    const f = fake({ dbNow: NIGHT, failing: { purgeStepTests: new Error('lock timeout') } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('sweep_failed:observation_purge')
    expect(f.db.calls).toEqual(expect.arrayContaining(['readCopies', 'dueQueueDepth', 'purgeTombstones']))
  })

  it('reads the hour on the Eastern clock, so 03:15 UTC is not its hour', async () => {
    const f = fake({ dbNow: '2026-10-17T03:15:00.000Z' }) // 23:15 EDT the day before
    await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('claim:observation_purge')
  })

  it('a failed purge is its own problem and stops nothing else', async () => {
    const f = fake({ dbNow: NIGHT, failing: { purgeObservations: new Error('lock timeout') } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('sweep_failed:observation_purge')
    expect(f.db.calls).toEqual(expect.arrayContaining(['readCopies', 'dueQueueDepth', 'purgeTombstones']))
  })

  it('with no database clock it is not claimed, since its hour cannot be read', async () => {
    const f = fake({ dbNow: NIGHT, failing: { now: new Error('down') } })
    await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('claim:observation_purge')
  })
})

describe('the connection storage sweeps (#2334)', () => {
  it('claims tombstone_expiry for just under an hour and counts the tombstones it purged', async () => {
    const f = fake({ tombstones: { purged: 3, more: false } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain(`claim:tombstone_expiry:${59 * 60}`)
    expect(f.db.calls.filter((c) => c.startsWith('purgeTombstones:'))).toEqual([`purgeTombstones:${500}`])
    expect(report.counts.tombstones_purged).toBe(3)
    expect(report.outcome).toBe('ok')
  })

  it('a tombstone_expiry interval another tick holds is a stand down, and nothing is purged', async () => {
    const f = fake({ sweepOwned: false, tombstones: { purged: 3, more: false } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('claim:tombstone_expiry')
    expect(f.db.calls).not.toContain('purgeTombstones')
    expect(report.counts.tombstones_purged).toBeUndefined()
  })

  it('pages the tombstone sweep while it says there is more, and stops at four pages', async () => {
    const f = fake({ tombstones: { purged: 500, more: true } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls.filter((c) => c === 'purgeTombstones')).toHaveLength(4)
    expect(report.counts.tombstones_purged).toBe(2000)
  })

  it('sweeps lapsed Salesforce leases every tick with no claim, and counts them', async () => {
    const f = fake({ sfLeases: { swept: 2, more: false } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls.filter((c) => c.startsWith('sweepSfLeases:'))).toEqual([`sweepSfLeases:${500}`])
    // claim_ops_sweep has no name for it and it needs none (TICK_SF_LEASE_SWEEP), so these are every claim a tick makes.
    expect(f.db.calls.filter((c) => /^claim:[a-z_]+$/.test(c))).toEqual([
      'claim:lease_expiry', 'claim:run_expiry', 'claim:queue_agreement', 'claim:tombstone_expiry', 'claim:sf_limits', 'claim:connection_check',
    ])
    expect(report.counts.sf_leases_swept).toBe(2)
    expect(report.outcome).toBe('ok')
  })

  it('pages the Salesforce lease sweep while it says there is more, and stops at four pages', async () => {
    const f = fake({ sfLeases: { swept: 500, more: true } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls.filter((c) => c === 'sweepSfLeases')).toHaveLength(4)
    expect(report.counts.sf_leases_swept).toBe(2000)
  })

  it('a claim that throws for one sweep stops neither the sweeps after it nor the Salesforce lease sweep', async () => {
    const f = fake()
    const claim = f.db.claimSweep.bind(f.db)
    f.db.claimSweep = async (sweep, owner, every) => {
      if (sweep === 'lease_expiry') throw new Error('connection reset')
      return claim(sweep, owner, every)
    }
    const report = await runOpsTick(f.ports)
    expect(report.problems).toEqual(['The lease_expiry sweep failed: connection reset.'])
    expect(f.db.calls).toEqual(expect.arrayContaining(['expireRuns', 'queueDisagreements', 'purgeTombstones', 'sweepSfLeases']))
  })
})

describe('the ops connections (#2335)', () => {
  it('saves the connections the bidding Worker served as last good copies, with the serve_until it set', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('ok')
    expect(f.db.savedConnections).toEqual([[expect.objectContaining({ connectionId: CONN, organizationId: ORG, generation: 1, serveUntil: '2026-10-17T17:02:31.000Z' })]])
    expect(report.counts).toMatchObject({ connections_served: 1, connection_copies_saved: 1 })
  })

  it('a bidding Worker that cannot be reached for connections is reported, saves no copy, and stops nothing else', async () => {
    const f = fake({ fetchConnections: async () => { throw new Error('the bidding Worker\'s connection list did not answer within 15 s') } })
    const report = await runOpsTick(f.ports)
    expect(f.db.savedConnections).toEqual([])
    expect(report.problems).toEqual([expect.stringMatching(/could not fetch the ops connections .*serve_until/)])
    // The workflows were saved and the schedule fired all the same.
    expect(f.db.saved).toHaveLength(1)
    expect(f.dispatched).toHaveLength(1)
  })

  it('a failed connection save is reported and the schedules still fire', async () => {
    const f = fake({ failing: { saveConnectionCopies: new OpsWriteTimeoutError('save_connection_copies passed its 9000 ms deadline and may still have committed') } })
    const report = await runOpsTick(f.ports)
    expect(report.problems).toEqual([expect.stringMatching(/could not save the connections it fetched.*save_connection_copies/)])
    expect(f.dispatched).toHaveLength(1)
  })

  it('with no database it fetches no connections, since there is nowhere to keep them', async () => {
    let asked = false
    const f = fake({ db: 'not_configured', fetchConnections: async () => { asked = true; return servedConnections() } })
    await runOpsTick(f.ports)
    expect(asked).toBe(false)
  })
})

// #2506: the bidding Worker pages a problem a passing tick would clear only once
// three ticks in a row report it, and every other problem at once. It tells the
// two apart, and one problem from another, by a key per problem: the kind of
// problem and, where there is one, what it is about (a sweep, a workflow, a
// secret), never the sentence, which carries an error's own words and figures.
describe('problem keys (#2506)', () => {
  const GONE = '00000000-0000-4000-8000-0000000023c9'
  const failsOn = (name: keyof OpsTickDb) => ({ failing: { [name]: new Error('canceling statement due to statement timeout') } })
  const cases: Array<[string, Parameters<typeof fake>[0], string[]]> = [
    ['a missed start stamp', { stampFails: true }, ['start_stamp']],
    ['an unreachable database', { db: 'not_configured' }, ['db_not_configured']],
    ['a secret found unusable', { secrets: [{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY', problem: 'the key is not set' }] }, ['not_configured:OPS_CONNECTIONS_PRIVATE_KEY']],
    ['a secrets check that throws', { secrets: new Error('the key import crashed') }, ['secrets_unchecked']],
    ['an unreadable database clock', failsOn('now'), ['db_clock']],
    ['a sweep claim that fails', failsOn('claimSweep'), [
      'sweep_claim_failed:lease_expiry', 'sweep_claim_failed:run_expiry', 'sweep_claim_failed:queue_agreement', 'sweep_claim_failed:tombstone_expiry',
      'sweep_claim_failed:sf_limits', 'sweep_claim_failed:connection_check',
    ]],
    ['a lease sweep that fails after its claim', failsOn('sweepLeases'), ['sweep_failed:lease_expiry']],
    ['a run expiry sweep that fails after its claim', failsOn('expireRuns'), ['sweep_failed:run_expiry']],
    ['an agreement check that fails after its claim', failsOn('queueDisagreements'), ['agreement_check_failed']],
    ['a disagreement the agreement check found', { disagreements: 2 }, ['queue_disagreement']],
    ['a workflow list that cannot be fetched', { fetch: async () => { throw new Error('the bidding database did not answer') } }, ['workflows_fetch_failed']],
    ['a served workflow it cannot read', { fetch: async () => served([{}, { id: 'not-a-uuid' }]) }, ['workflow_refused']],
    ['a workflow save that fails', failsOn('saveCopies'), ['workflows_save_failed']],
    ['a copies read that fails', failsOn('readCopies'), ['copies_read_failed']],
    ['a refused schedule', { copies: [copy({ trigger: schedule({ ...every5, interval_seconds: 30 }) })] }, [`schedule_refused:${WF_A}`]],
    ['a schedule with no saved version', { copies: [copy({ versionNumber: null })] }, [`schedule_no_version:${WF_A}`]],
    ['a schedule whose recording fails', failsOn('recordObservation'), [`schedule_plan_failed:${WF_A}`]],
    ['a missed slot', { copies: [copy({ scheduleKnownSince: '2026-10-17T09:00:00.000Z', lastObserved: '2026-10-17T09:30:00.000Z' })] }, [`slot_missed:${WF_A}`]],
    ['a claim depth read that fails', failsOn('dueQueueDepth'), ['claim_depth_failed']],
    ['a slot whose dispatch fails', { dispatchFails: (item) => item.kind === 'would_fire' }, [`dispatch_failed:${WF_A}`]],
    ['a probe whose dispatch fails', { copies: [copy({ trigger: { type: 'http_webhook', config: {} } })], dispatchFails: (item) => item.kind === 'probe' }, ['probe_failed']],
    ['a connection list that cannot be fetched', { fetchConnections: async () => { throw new Error('the connection list did not answer within 15 s') } }, ['connections_fetch_failed']],
    ['a connection list it cannot read', { fetchConnections: async () => ({ served_at: 'never' }) }, ['connections_list_unreadable']],
    ['a connection save that fails', failsOn('saveConnectionCopies'), ['connections_save_failed']],
    ['a login state read that fails', failsOn('connectionCheckTargets'), ['connection_logins_failed', 'write_back_check_failed', 'connection_check_failed']],
    ['a removal that cannot be recorded', {
      ...failsOn('recordConnectionTombstone'),
      fetchConnections: async () => ({ ...servedConnections(), tombstones: [{ connection_id: GONE, organization_id: ORG, generation: 1, removed_at: '2026-10-17T10:00:00.000Z' }] }),
    }, [`tombstone_record_failed:${GONE}`]],
    ['a removal of unserved measured identities that fails', failsOn('removeUnservedMeasuredIdentities'), ['unserved_identities_remove_failed']],
  ]

  it.each(cases)('keys %s', async (_label, opts, keys) => {
    const report = await runOpsTick(fake(opts).ports)
    expect(report.problem_keys).toEqual(keys)
    // One key per sentence, in the same order, so the bidding Worker pages the sentences it judged.
    expect(report.problems).toHaveLength(keys.length)
  })

  it('logs each measured identity of a connection bidding never stored by its id when a complete serve removes it, and counts them (#2573)', async () => {
    const ORPHAN = '00000000-0000-4000-8000-0000000025a1'
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    try {
      const report = await runOpsTick(fake({ unservedRemoved: [{ organizationId: ORG, connectionId: ORPHAN, generation: 1, measuredAt: '2026-10-17T09:00:00+00:00' }] }).ports)
      expect(report.problem_keys).toEqual([])
    } finally {
      spy.mockRestore()
    }
    const logged = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)
    const removed = logged.filter((l) => l.step === 'unserved_identity_removed')
    expect(removed).toEqual([expect.objectContaining({ event: 'ops_tick', organization_id: ORG, connection_id: ORPHAN, generation: 1, measured_at: '2026-10-17T09:00:00+00:00' })])
    const finished = logged.find((l) => l.step === 'finished')
    expect(finished?.connection_unserved_identities_removed).toBe(1)
  })

  it('names no key on a healthy tick', async () => {
    const report = await runOpsTick(fake().ports)
    expect(report.problem_keys).toEqual([])
  })

  it('keys every problem by a kind the bidding Worker has a rule for', async () => {
    for (const [, opts] of cases) {
      const report = await runOpsTick(fake(opts).ports)
      for (const key of report.problem_keys ?? []) expect(Object.keys(OPS_TICK_PROBLEM_RULES)).toContain(key.split(':')[0])
    }
  })
})

describe('the sf_limits sweep inside the tick (#2336)', () => {
  it('is claimed every 4 minutes through claim_ops_sweep, as one of the tick\'s sweeps', async () => {
    expect(TICK_SWEEPS.find((s) => s.sweep === 'sf_limits')?.everySeconds).toBe(SF_LIMITS_EVERY_SECONDS)
    const f = fake()
    await runOpsTick(f.ports)
    expect(f.db.calls).toContain(`claim:sf_limits:${SF_LIMITS_EVERY_SECONDS}`)
  })

  it('with no measured org (today), claims, finds nothing, stamps the job and reports nothing', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('sfLimitsTargets:10')
    expect(f.sfReads).toEqual([])
    expect(f.jobStamps.filter((j) => j.endsWith(SF_LIMITS_JOB))).toEqual([`started:${SF_LIMITS_JOB}`, `completed:${SF_LIMITS_JOB}`])
    expect(report.outcome).toBe('ok')
    expect(report.problems).toEqual([])
    expect(report.counts.sf_limits_orgs).toBe(0)
  })

  it('reads a measured org\'s limits and records its daily API remaining, the counts in the tick\'s report', async () => {
    const f = fake({ sfTargets: [sfTarget()] })
    const report = await runOpsTick(f.ports)
    expect(f.sfReads).toEqual(['https://trypennie.my.salesforce.com/services/data/v60.0/limits'])
    expect(f.db.sfReadings).toEqual([{ sfOrgId: SF_ORG, dailyApiMax: 1_680_000, dailyApiRemaining: 1_205_253 }])
    expect(report.counts).toMatchObject({ sf_limits_orgs: 1, sf_limits_recorded: 1 })
    expect(report.outcome).toBe('ok')
  })

  it('carries the sweep\'s keyed problems into the tick\'s report, each paged at once', async () => {
    const f = fake({ sfTargets: [sfTarget()], sfRead: async () => { throw new ConnectionRefusal('sf_cap_unset', 'the ops Salesforce pool answered sf_cap_unset') } })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('problems')
    expect(report.problem_keys).toEqual([`sf_limits_refused:${SF_ORG}`])
    expect(report.problems[0]).toMatch(/sf_cap_unset/)
  })

  // #2340: reported under the kind the bidding Worker counts by the sweep's
  // runs, so a young reading kept fresh by other calls cannot hide it for ever.
  it('reports a transient failure while the org\'s reading is young, to be counted by the sweep\'s runs', async () => {
    const f = fake({ sfTargets: [sfTarget()], sfRead: async () => new RequeueAt(new Date(WORKER_NOW + 60_000), 'rate_limited') })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('problems')
    expect(report.problem_keys).toEqual([`sf_limits_read_failing:${SF_ORG}`])
    expect(report.counts.sf_limits_held).toBe(1)
  })

  // #2340: the bidding Worker judges a sweep's problems by that sweep's runs, so
  // the report says which sweeps this tick ran: the ones whose claim it owned.
  it('says which sweeps the tick ran: every one whose claim it owned', async () => {
    const report = await runOpsTick(fake().ports)
    // Outside 03:00 Eastern the observation purge is not claimed (#1950).
    expect(report.sweeps_run).toEqual(TICK_SWEEPS.filter((s) => s.easternHour === undefined).map((s) => s.sweep))
    const night = await runOpsTick(fake({ dbNow: '2026-10-17T07:15:00.000Z' }).ports)
    expect(night.sweeps_run).toEqual(TICK_SWEEPS.map((s) => s.sweep))
  })

  it('names no sweep it stood down from or whose claim failed', async () => {
    expect((await runOpsTick(fake({ sweepOwned: false }).ports)).sweeps_run).toEqual([])
    const f = fake({ failing: { claimSweep: new OpsWriteTimeoutError('claim_ops_sweep did not answer within 9000 ms') } })
    expect((await runOpsTick(f.ports)).sweeps_run).toEqual([])
  })

  it('goes on, and the tick stays ok, when the job stamps fail: the heartbeat is what pages a sweep that stops stamping', async () => {
    const f = fake({ sfTargets: [sfTarget()], jobStampFails: true })
    const report = await runOpsTick(f.ports)
    expect(f.db.sfReadings).toHaveLength(1)
    expect(report.outcome).toBe('ok')
    expect(report.counts.sf_limits_stamps_failed).toBe(2)
  })

  it('reports a failed claim of sf_limits under sweep_claim_failed, which the next tick asks again', async () => {
    const f = fake({ failing: { claimSweep: new OpsWriteTimeoutError('claim_ops_sweep did not answer within 9000 ms') } })
    const report = await runOpsTick(f.ports)
    expect(report.problem_keys).toContain('sweep_claim_failed:sf_limits')
    expect(f.jobStamps).toEqual([])
  })

  it('reports a sweep that throws past its own boundaries as sf_limits_failed, and the rest of the tick still runs', async () => {
    const f = fake()
    const ports = { ...f.ports, sfLimits: undefined as unknown as OpsTickPorts['sfLimits'] }
    const report = await runOpsTick(ports)
    expect(report.problem_keys).toEqual(['sf_limits_failed'])
    expect(f.dispatched).toHaveLength(1)
  })

  it('runs beside the rest of the tick, so a slow read does not hold the schedules back', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<Response>((resolve) => { release = () => resolve(Response.json({ DailyApiRequests: { Max: 10, Remaining: 9 } })) })
    const f = fake({ sfTargets: [sfTarget()], sfRead: () => pending })
    const done = runOpsTick(f.ports)
    // Let the tick reach its dispatch while the read is still out.
    for (let i = 0; i < 50 && f.dispatched.length === 0; i++) await Promise.resolve()
    expect(f.dispatched).toHaveLength(1)
    expect(f.reports).toEqual([])
    release()
    const report = await done
    expect(report.counts.sf_limits_recorded).toBe(1)
    expect(f.reports).toHaveLength(1)
  })
})

describe('the connection_check sweep inside the tick (#2340)', () => {
  const NEEDS = '00000000-0000-4000-8000-0000000023c7'

  it('is claimed every 14 minutes through claim_ops_sweep, as one of the tick\'s sweeps', async () => {
    expect(TICK_SWEEPS.find((s) => s.sweep === 'connection_check')?.everySeconds).toBe(CONNECTION_CHECK_EVERY_SECONDS)
    const f = fake()
    await runOpsTick(f.ports)
    expect(f.db.calls).toContain(`claim:connection_check:${CONNECTION_CHECK_EVERY_SECONDS}`)
  })

  it('with no ops connection (today), claims, finds nothing, stamps the job and reports nothing, and the tick reports a complete list of no login', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    // Twice: the login states, and the sweep's own read of the same list.
    expect(f.db.calls.filter((c) => c === `connectionCheckTargets:${CONNECTION_CHECK_READ_LIMIT}`)).toHaveLength(2)
    expect(f.probes).toEqual([])
    expect(f.db.connectionChecks).toEqual([])
    expect(f.jobStamps).toEqual(expect.arrayContaining([`started:${CONNECTION_CHECK_JOB}`, `completed:${CONNECTION_CHECK_JOB}`]))
    expect(report.outcome).toBe('ok')
    expect(report.problems).toEqual([])
    expect(report.counts.connection_check_connections).toBe(0)
    expect(report.connection_logins).toEqual({ complete: true, logins: [] })
  })

  it('probes a connection\'s identity and records the passing check, the counts in the tick\'s report', async () => {
    const f = fake({ connTargets: [connTarget()] })
    const report = await runOpsTick(f.ports)
    expect(f.probes).toEqual([CONN])
    expect(f.db.connectionChecks).toEqual([{ connectionId: CONN, result: { ok: true } }])
    expect(report.counts).toMatchObject({ connection_check_connections: 1, connection_check_passed: 1 })
    expect(report.outcome).toBe('ok')
  })

  it('carries the sweep\'s keyed problems into the tick\'s report, each paged at once', async () => {
    const f = fake({ connTargets: [connTarget()], probe: async () => { throw new ConnectionRefusal('sf_cap_unset', 'the ops Salesforce pool answered sf_cap_unset') } })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('problems')
    expect(report.problem_keys).toEqual([`connection_check_refused:${CONN}`])
  })

  it('reads the login states every tick, owning the sweep or not, and lists a connection in needs_reauth', async () => {
    const f = fake({
      sweepOwned: false,
      connTargets: [connTarget({ connectionId: NEEDS, status: 'needs_reauth', needsReauthAt: '2026-10-17T10:01:00.000Z', needsReauthCause: 'login_refused: invalid_grant' })],
    })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain(`connectionCheckTargets:${CONNECTION_LOGINS_READ_LIMIT}`)
    expect(f.probes).toEqual([])
    expect(report.connection_logins).toEqual({
      complete: true,
      logins: [{ organization_id: ORG, connection_id: NEEDS, service: 'salesforce', state: 'needs_reauth', reason: 'login_refused', since: '2026-10-17T10:01:00.000Z', failures: null }],
    })
    // A login is the login signal's to page, not the tick's: the tick stays ok.
    expect(report.outcome).toBe('ok')
  })

  it('reads the login states after saving the served connections, so a withdrawal served this minute is judged', async () => {
    const f = fake()
    await runOpsTick(f.ports)
    expect(f.db.calls.indexOf('saveConnectionCopies')).toBeLessThan(f.db.calls.lastIndexOf(`connectionCheckTargets:${CONNECTION_LOGINS_READ_LIMIT}`))
  })

  it('reports no login list, never an empty one, when the read fails, and says why', async () => {
    const f = fake({ failing: { connectionCheckTargets: new OpsWriteTimeoutError('connection_check_targets did not answer within 9000 ms') } })
    const report = await runOpsTick(f.ports)
    expect(report.connection_logins).toBeNull()
    expect(report.problem_keys).toContain('connection_logins_failed')
    expect(OPS_TICK_PROBLEM_RULES.connection_logins_failed).toBe('three_in_a_row')
  })

  it('reports a login list that reached its limit as not complete, and pages that at once', async () => {
    const f = fake({ connTargetsFull: true, sweepOwned: false })
    const report = await runOpsTick(f.ports)
    expect(report.connection_logins?.complete).toBe(false)
    expect(report.problem_keys).toEqual(['connection_logins_limit'])
  })

  it('reports no login list with no database', async () => {
    const report = await runOpsTick(fake({ db: 'not_configured' }).ports)
    expect(report.connection_logins).toBeNull()
  })

  it('goes on, and the tick stays ok, when the job stamps fail: the heartbeat is what pages a sweep that stops stamping', async () => {
    const f = fake({ connTargets: [connTarget()], jobStampFails: true })
    const report = await runOpsTick(f.ports)
    expect(f.db.connectionChecks).toHaveLength(1)
    expect(report.outcome).toBe('ok')
    expect(report.counts.connection_check_stamps_failed).toBe(2)
  })

  it('reports a sweep that throws past its own boundaries as connection_check_failed, and the rest of the tick still runs', async () => {
    const f = fake()
    const ports = { ...f.ports, connectionCheck: undefined as unknown as OpsTickPorts['connectionCheck'] }
    const report = await runOpsTick(ports)
    expect(report.problem_keys).toEqual(['connection_check_failed'])
    expect(f.dispatched).toHaveLength(1)
  })

  it('runs beside the rest of the tick, so a slow probe does not hold the schedules back', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<ProbeAnswer>((resolve) => { release = () => resolve({ kind: 'measured', identity: { kind: 'salesforce', sfOrgId: '00Dst0000000001AAA', username: 'ops-one@example.com' } }) })
    const f = fake({ connTargets: [connTarget()], probe: () => pending })
    const done = runOpsTick(f.ports)
    for (let i = 0; i < 50 && f.dispatched.length === 0; i++) await Promise.resolve()
    expect(f.dispatched).toHaveLength(1)
    expect(f.reports).toEqual([])
    release()
    const report = await done
    expect(report.counts.connection_check_passed).toBe(1)
    expect(f.reports).toHaveLength(1)
  })
})

describe('the write back check inside the tick (#2340, phase 10 item 4)', () => {
  const PENDING = (sinceMs: number | null) => async () => ({ ok: true, state: 'pending', pendingSinceMs: sinceMs, attempts: 6 })

  it('with no ops connection (today), the tick owning the sweep asks no object and reports a complete list of nothing pending, and stays ok', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(f.objectReads).toEqual([])
    expect(report.write_backs).toEqual({ complete: true, pending: [] })
    expect(report.outcome).toBe('ok')
  })

  it('asks no object, and judges nothing, on a tick that does not own the sweep: the objects are not woken every minute', async () => {
    const f = fake({ sweepOwned: false, connTargets: [connTarget()], writeBack: PENDING(WORKER_NOW - 60 * 60_000) })
    const report = await runOpsTick(f.ports)
    expect(f.objectReads).toEqual([])
    expect(report.write_backs).toBeNull()
  })

  it('asks each listed connection\'s object on the tick that owns the sweep, from the list the tick already read, and lists one pending past the bound', async () => {
    const f = fake({ connTargets: [connTarget()], writeBack: PENDING(WORKER_NOW - 45 * 60_000) })
    const report = await runOpsTick(f.ports)
    expect(f.objectReads).toEqual([CONN])
    // No read of its own: the login states' read and the sweep's, as before.
    expect(f.db.calls.filter((c) => c === `connectionCheckTargets:${CONNECTION_CHECK_READ_LIMIT}`)).toHaveLength(2)
    expect(report.write_backs).toEqual({
      complete: true,
      pending: [{ organization_id: ORG, connection_id: CONN, service: 'salesforce', since: new Date(WORKER_NOW - 45 * 60_000).toISOString(), attempts: 6 }],
    })
    // The connection's organization is paged through its own signal, by the bidding Worker: the tick stays ok.
    expect(report.outcome).toBe('ok')
    expect(report.counts.write_backs_due).toBe(1)
  })

  it('an object that cannot be reached is a keyed problem paged at once, and the list is not complete', async () => {
    const f = fake({ connTargets: [connTarget()], writeBack: async () => { throw new Error('the CONNECTION_TOKENS binding is missing from this deploy') } })
    const report = await runOpsTick(f.ports)
    expect(report.write_backs).toEqual({ complete: false, pending: [] })
    expect(report.problem_keys).toEqual([`write_back_unreadable:${CONN}`])
    expect(OPS_TICK_PROBLEM_RULES.write_back_unreadable).toBe('at_once')
  })

  it('reports no list, and says so, when the tick owning the sweep could not read the connections', async () => {
    const f = fake({ failing: { connectionCheckTargets: new Error('connection_check_targets did not answer within 9000 ms') } })
    const report = await runOpsTick(f.ports)
    expect(report.write_backs).toBeNull()
    expect(report.problem_keys).toContain('write_back_check_failed')
  })

  it('reports a check that throws past its own boundaries as write_back_check_failed, and the rest of the tick still runs', async () => {
    const f = fake({ connTargets: [connTarget()] })
    const ports = { ...f.ports, writeBacks: undefined as unknown as OpsTickPorts['writeBacks'] }
    const report = await runOpsTick(ports)
    expect(report.write_backs).toBeNull()
    expect(report.problem_keys).toEqual(['write_back_check_failed'])
    expect(f.dispatched).toHaveLength(1)
  })
})

describe('the reseal watch (#2486)', () => {
  const hoursAgo = (h: number) => new Date(Date.parse(DB_NOW) - h * 3600_000).toISOString()

  it('reports the switch off, asking the database nothing, outside a rotation', async () => {
    const f = fake()
    const report = await runOpsTick(f.ports)
    expect(report.reseal).toEqual({ verdict: 'off', mode: null, since: null, nothing_left_since: null, last_run_at: null, last_run_left: null, db_now: null })
    expect(f.db.calls.filter((c) => c.startsWith('observeReseal'))).toEqual([])
    expect(report.outcome).toBe('ok')
  })

  it('observes the switch every tick it is set, and reports the verdict for the bidding Worker to page, not as a tick problem', async () => {
    const f = fake({ resealSwitch: 'apply', resealState: { modeSince: hoursAgo(3), lastRunAt: hoursAgo(0.02), lastRunNothingLeft: false, lastRunLeft: 2 } })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).toContain('observeReseal:apply:600')
    expect(report.reseal).toEqual({
      verdict: 'logins_left', mode: 'apply', since: hoursAgo(3), nothing_left_since: null, last_run_at: hoursAgo(0.02), last_run_left: 2, db_now: DB_NOW,
    })
    expect(report.outcome).toBe('ok')
    expect(report.problems).toEqual([])
  })

  it('reports a switch naming no mode as switch_unknown without asking the database', async () => {
    const f = fake({ resealSwitch: 'yes' })
    expect((await runOpsTick(f.ports)).reseal?.verdict).toBe('switch_unknown')
    expect(f.db.calls.filter((c) => c.startsWith('observeReseal'))).toEqual([])
  })

  it('reports a failed read as a problem held for three ticks and judges nothing, and the rest of the tick goes on', async () => {
    const f = fake({ resealSwitch: 'apply', failing: { observeReseal: new OpsWriteTimeoutError('observe_ops_reseal did not answer within 9000 ms') } })
    const report = await runOpsTick(f.ports)
    expect(report.reseal).toBeNull()
    expect(report.problem_keys).toEqual(['reseal_state_failed'])
    expect(OPS_TICK_PROBLEM_RULES.reseal_state_failed).toBe('three_in_a_row')
    expect(f.dispatched).toHaveLength(1)
  })

  it('judges nothing with no database, which pages as not configured', async () => {
    const report = await runOpsTick(fake({ resealSwitch: 'apply', db: 'not_configured' }).ports)
    expect(report.reseal).toBeNull()
    expect(report.outcome).toBe('not_configured')
  })
})
