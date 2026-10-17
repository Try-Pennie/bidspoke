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
import { organizationIdFrom } from '../ops-db'
import { OpsWriteTimeoutError, type SaveCopiesResult, type ScheduleObservation, type SweepClaim, type WorkflowCopy, type WorkflowCopyInput } from '../ops-writes'
import type { OpsSweep } from '../run-vocabulary'
import { runOpsTick, type DispatchItem, type OpsTickDb, type OpsTickPorts } from '../tick'

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

interface Fake {
  ports: OpsTickPorts
  db: OpsTickDb & { calls: string[]; saved: WorkflowCopyInput[][]; observations: ScheduleObservation[] }
  dispatched: DispatchItem[]
  stamps: string[]
  reports: unknown[]
}

function fake(opts: {
  copies?: WorkflowCopy[]
  fetch?: () => Promise<unknown>
  sweepOwned?: boolean
  failing?: Partial<Record<keyof OpsTickDb, Error>>
  observed?: (o: ScheduleObservation) => 'recorded' | 'already_recorded'
  dispatchFails?: (item: DispatchItem) => boolean
  disagreements?: number
  dueRuns?: number
  db?: 'not_configured'
  stampFails?: boolean
} = {}): Fake {
  const calls: string[] = []
  const saved: WorkflowCopyInput[][] = []
  const observations: ScheduleObservation[] = []
  const fail = (name: keyof OpsTickDb) => {
    calls.push(name)
    const e = opts.failing?.[name]
    if (e) throw e
  }
  const db = {
    calls,
    saved,
    observations,
    async now() { fail('now'); return DB_NOW },
    async claimSweep(sweep: OpsSweep): Promise<SweepClaim> { fail('claimSweep'); calls.push(`claim:${sweep}`); return { owned: opts.sweepOwned ?? true, lastStartedAt: null, lastOwner: 'another-tick' } },
    async sweepLeases() { fail('sweepLeases'); return { requeued: 0, retried: 0, needsHuman: 0, dead: 0, more: false } },
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
  }
  const dispatched: DispatchItem[] = []
  const stamps: string[] = []
  const reports: unknown[] = []
  const ports: OpsTickPorts = {
    tickId: 'tick-1',
    scheduledTime: Date.parse('2026-10-17T11:02:48.004Z'),
    now: () => WORKER_NOW,
    db: opts.db === 'not_configured' ? { notConfigured: 'OPS_SUPABASE_SECRET_KEY is not set, so the ops database cannot be reached' } : db,
    gateway: {
      fetchWorkflows: opts.fetch ?? (async () => served()),
      started: async () => { stamps.push('started'); if (opts.stampFails) throw new Error('the gateway is not deployed') },
      completed: async (r) => { stamps.push('completed'); reports.push(r); if (opts.stampFails) throw new Error('the gateway is not deployed') },
    },
    dispatch: async (item) => {
      if (opts.dispatchFails?.(item)) throw new Error('OpsInternal refused: bad_signature')
      dispatched.push(item)
    },
  }
  return { ports, db, dispatched, stamps, reports }
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
  })

  it('a sweep claimed by another tick stands down, recorded and not a problem', async () => {
    const f = fake({ sweepOwned: false })
    const report = await runOpsTick(f.ports)
    expect(f.db.calls).not.toContain('sweepLeases')
    expect(f.db.calls).not.toContain('expireRuns')
    expect(f.db.calls).not.toContain('queueDisagreements')
    expect(report.counts.sweeps_stood_down).toBe(3)
    expect(report.outcome).toBe('ok')
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
    expect(f.db.observations).toHaveLength(1)
    expect(report.problems.join(' ')).toMatch(/lease_expiry sweep failed: lock timeout/)
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
