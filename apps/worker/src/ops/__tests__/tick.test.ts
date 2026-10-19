/**
 * The ops minute cron's tick (#1949), in observe mode, against injected ports.
 *
 * The database functions are proven against a real Postgres in
 * supabase-ops/supabase/tests/ops_tick.test.sql, and the binding to OpsInternal
 * inside workerd in self-dispatch.workers.test.ts. These prove the tick's own
 * rules: every fire is computed on the DATABASE clock; each job, each schedule
 * and each dispatch is its own failure boundary; it plans from the copies as
 * the database holds them after its save, never from its own fetch; a missing
 * key, a lost claim, a failed fetch, a missed slot and a statement timeout are
 * each reported, never swallowed; and it runs nothing that sends anywhere.
 *
 * Every clock is injected: the worker clock is set an hour away from the
 * database clock, so a fire computed on the wrong one is visible.
 */
import { describe, expect, it } from 'vitest'
import { OPS_TICK_PROBLEM_RULES } from '../../lib/ops-gateway-contract'
import { organizationIdFrom } from '../ops-db'
import {
  OpsWriteTimeoutError, type ConnectionCopyInput, type SaveConnectionCopiesResult, type SaveCopiesResult, type ScheduleObservation, type SweepClaim, type SweepResult,
  type WorkflowCopy, type WorkflowCopyInput,
} from '../ops-writes'
import type { OpsSweep } from '../run-vocabulary'
import { ConnectionRefusal, RequeueAt } from '../connections/refusals'
import type { SfLimitsTarget } from '../ops-writes'
import { SF_LIMITS_EVERY_SECONDS } from '../sf-limits'
import { SF_LIMITS_JOB } from '../../lib/ops-gateway-contract'
import { TICK_SWEEPS, runOpsTick, type DispatchItem, type OpsTickDb, type OpsTickPorts, type UnconfiguredSecret } from '../tick'

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
    ...over,
  }
}

function served(workflows: Array<Record<string, unknown>> = [{}]) {
  return {
    served_at: '2026-10-17T11:02:31.000Z',
    complete: true,
    workflows: workflows.map((w) => ({
      id: WF_A, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.000Z', version_number: 3, trigger: schedule(), ...w,
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
  }
  dispatched: DispatchItem[]
  stamps: string[]
  reports: unknown[]
  /** The ops jobs' stamps through the gateway (#2340), as `started:<job>` and `completed:<job>`. */
  jobStamps: string[]
  sfReads: string[]
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
} = {}): Fake {
  const calls: string[] = []
  const saved: WorkflowCopyInput[][] = []
  const savedConnections: ConnectionCopyInput[][] = []
  const observations: ScheduleObservation[] = []
  const sfReadings: Array<{ sfOrgId: string; dailyApiMax: number; dailyApiRemaining: number }> = []
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
    async now() { fail('now'); return DB_NOW },
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
  }
  const dispatched: DispatchItem[] = []
  const stamps: string[] = []
  const reports: unknown[] = []
  const jobStamps: string[] = []
  const sfReads: string[] = []
  const ports: OpsTickPorts = {
    tickId: 'tick-1',
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
    dispatch: async (item) => {
      if (opts.dispatchFails?.(item)) throw new Error('OpsInternal refused: bad_signature')
      dispatched.push(item)
    },
  }
  return { ports, db, dispatched, stamps, reports, jobStamps, sfReads }
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
    expect(f.jobStamps).toEqual([])
    expect(report.counts.sweeps_stood_down).toBe(5)
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
      'claim:lease_expiry', 'claim:run_expiry', 'claim:queue_agreement', 'claim:tombstone_expiry', 'claim:sf_limits',
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
      'sweep_claim_failed:sf_limits',
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
    ['a removal that cannot be recorded', {
      ...failsOn('recordConnectionTombstone'),
      fetchConnections: async () => ({ ...servedConnections(), tombstones: [{ connection_id: GONE, organization_id: ORG, generation: 1, removed_at: '2026-10-17T10:00:00.000Z' }] }),
    }, [`tombstone_record_failed:${GONE}`]],
  ]

  it.each(cases)('keys %s', async (_label, opts, keys) => {
    const report = await runOpsTick(fake(opts).ports)
    expect(report.problem_keys).toEqual(keys)
    // One key per sentence, in the same order, so the bidding Worker pages the sentences it judged.
    expect(report.problems).toHaveLength(keys.length)
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
    expect(f.jobStamps).toEqual([`started:${SF_LIMITS_JOB}`, `completed:${SF_LIMITS_JOB}`])
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

  it('holds a transient failure while the org\'s reading is young, and the tick stays ok', async () => {
    const f = fake({ sfTargets: [sfTarget()], sfRead: async () => new RequeueAt(new Date(WORKER_NOW + 60_000), 'rate_limited') })
    const report = await runOpsTick(f.ports)
    expect(report.outcome).toBe('ok')
    expect(report.counts.sf_limits_held).toBe(1)
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
