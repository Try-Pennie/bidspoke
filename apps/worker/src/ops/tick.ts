/**
 * The ops minute cron's tick (#1949, track B2 of the #1698 run engine), in
 * observe mode: it computes and records what it would run, and runs nothing
 * that sends anywhere.
 *
 * One tick, each job inside its own failure boundary (#1698 1.4, L73), so a
 * throw in one never cancels another:
 *
 *  1. Stamp started with the bidding Worker (lib/ops-gateway.ts), which keeps the
 *     heartbeat. The watchdog lives there, not here (L71). Then check the
 *     secrets: an unset ops database secret, or an ops private key that is
 *     unset, will not import, or does not match the committed public key
 *     (#2333, connection-key.ts), makes the report
 *     not_configured and names each secret, so the page names its remedy.
 *  2. Read the DATABASE clock (#1698 D8, L736). Every fire is computed against
 *     it, never against this Worker's clock, and without it nothing is planned.
 *  3. The maintenance sweeps (lease expiry, run expiry, the queue agreement
 *     check, and since #2334 the connection tombstone expiry), each with one
 *     owner per interval (claim_ops_sweep: a try advisory lock then a timestamp
 *     compare and set), because Cloudflare overlaps and retries crons: a tick
 *     that loses the claim stands down and says so. Then the Salesforce lease
 *     sweep, which needs no claim (TICK_SF_LEASE_SWEEP says why).
 *  4. The workflows (decision 4, 2026-10-16): fetch the ops workflows' state from
 *     the bidding Worker over the service binding, save it as the last good
 *     copy, then read the copies back. The tick plans from what the database
 *     holds AFTER its save, never from its own fetch, which may be the older of
 *     two overlapping ticks' (save_workflow_copies refuses an older copy, and a
 *     copy not newer than the last known switch off may not start). A failed
 *     fetch plans from the saved copies and says so; with none, it plans nothing.
 *     Then the ops connections the same way (#2335, connection-serve.ts): saved
 *     through save_connection_copies, each with the serve_until the bidding
 *     Worker set; a failed fetch saves none, so each copy expires on time.
 *  5. The schedules, each inside its own boundary: planFires (packages/
 *     workflow-definition) with the database clock, the floor and the last slot
 *     observed; each fire recorded in schedule_fire_observations, whose UNIQUE
 *     slot key means a doubled tick records, and dispatches, a slot once. A miss
 *     is recorded and reported: a missing expected run is a problem (#1949).
 *  6. The claim, observed: what a claim of up to TICK_CLAIM_PER_WORKFLOW runs a
 *     workflow (k) would find, read without claiming. Live claiming starts with
 *     run invocation (#1950), which builds the run a claim hands over.
 *  7. Dispatch, each item inside its own boundary: every newly recorded fire is
 *     handed to OpsInternal.observe through the SELF binding, signed (dispatch-
 *     auth.ts), and awaited, because a dispatched call dies with the tick that
 *     made it (spike P4). With nothing due, one probe goes, so the path is proven
 *     every minute (L142: observe must exercise the path, short of the forward).
 *  8. Stamp completed with the report, which the bidding Worker judges every
 *     minute and pages on (lib/ops-gateway.ts runOpsTickReportCheck), except a
 *     missed start stamp that is the report's only problem and the first in a
 *     row, which it holds for one tick (#2410).
 *
 * Every port is injected, so the tests set both clocks (tick.test.ts); the live
 * ports are tick-live.ts.
 */
import { planFires, scheduleFloorMs, scheduleFromTrigger, validateSchedule, type MissedReason, type PlannedFire, type ScheduleConfig } from '@bidspoke/workflow-definition'
import {
  capProblems, parseServedOpsWorkflows, type OpsTickMode, type OpsTickOutcome, type OpsTickReport,
} from '../lib/ops-gateway-contract'
import { formatErr } from '../lib/format-error'
import { saveServedConnections, type ConnectionServeDb } from './connection-serve'
import type { OrganizationId } from './ops-db'
import {
  MAX_COPIES_PER_SAVE, type QueueDisagreement, type SaveCopiesResult, type ScheduleObservation, type SweepClaim, type SweepResult,
  type WorkflowCopy, type WorkflowCopyInput,
} from './ops-writes'
import { OBSERVATION_REASONS, type OpsSweep } from './run-vocabulary'

/** The only mode this tick has (#1949). */
export const OPS_TICK_MODE: OpsTickMode = 'observe'

/** k, the most runs of one workflow a claim takes (#1698 D1): the fair claim measured at k 5 (spike P9). */
export const TICK_CLAIM_PER_WORKFLOW = 5
/** The most runs one tick would claim: 40 concurrent dispatches from one tick were measured to work (spike P4). */
export const TICK_CLAIM_LIMIT = 40

/** The copies one tick reads: every ops workflow, within PostgREST's 1,000 rows (L24). */
const COPIES_READ_LIMIT = 1000

/**
 * The sweeps the tick claims. connection_check (Phase 10) and sf_limits (Phase 6)
 * are claimable but arrive with the code that runs them, so naming either here
 * is a compile error in runOpsTick until it is handled there.
 */
export type TickSweep = Exclude<OpsSweep, 'connection_check' | 'sf_limits'>

/**
 * The sweeps, each with the interval its owner claims. A minute sweep claims 50 s,
 * not 60: the tick's start moves by a second or so between minutes (scheduledTime
 * lands at :48, spike #1946), and a 60 s interval would make every other minute
 * stand down. An hourly one claims 59 minutes for the same reason. Each pages a
 * bounded number of times, then leaves the rest to its next interval.
 *
 * tombstone_expiry (#2334) deletes connection tombstones past their expires_at,
 * which is 7 hours after the removal. An expired tombstone guards nothing (every
 * copy it covered is past its serve_until), so an hour's delay costs only the row.
 */
export const TICK_SWEEPS: ReadonlyArray<{ sweep: TickSweep; everySeconds: number; pageLimit: number; maxPages: number }> = [
  { sweep: 'lease_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'run_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'queue_agreement', everySeconds: 14 * 60, pageLimit: 100, maxPages: 1 },
  { sweep: 'tombstone_expiry', everySeconds: 59 * 60, pageLimit: 500, maxPages: 4 },
]

/**
 * The Salesforce lease sweep (#2334, sweep_sf_leases), which runs every tick and
 * takes no claim. claim_ops_sweep has no name for it, and it needs none: it
 * deletes only leases already past expires_at, FOR UPDATE SKIP LOCKED, and a
 * lapsed lease stopped counting toward any pool the moment it lapsed (L409). So
 * two overlapping ticks each delete different rows and neither changes what an
 * acquire sees, and a claim would cost the same one call a minute the sweep
 * does. It only keeps sf_leases small.
 */
export const TICK_SF_LEASE_SWEEP = { sweep: 'sf_lease_expiry', pageLimit: 500, maxPages: 4 } as const

/** Pages a sweep until it says there is no more, at most maxPages times. */
async function drain(maxPages: number, page: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < maxPages; n++) {
    if (!(await page())) return
  }
}

// planFires' reasons are the observation vocabulary's (run-vocabulary.ts, and
// through it the database's CHECK): each line fails to compile when they differ.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const fireReasonsAgree: Same<PlannedFire['reason'], (typeof OBSERVATION_REASONS.would_fire)[number]> = true
const missReasonsAgree: Same<MissedReason, (typeof OBSERVATION_REASONS.missed)[number]> = true
void fireReasonsAgree
void missReasonsAgree

/** The ops database, as the tick uses it. The live one is ops-writes.ts through tick-live.ts. */
export interface OpsTickDb extends ConnectionServeDb {
  now(): Promise<string>
  claimSweep(sweep: OpsSweep, owner: string, everySeconds: number): Promise<SweepClaim>
  sweepLeases(limit: number): Promise<SweepResult>
  expireRuns(limit: number): Promise<{ expired: number; more: boolean }>
  /** The tombstone_expiry sweep (purge_expired_connection_tombstones). */
  purgeTombstones(limit: number): Promise<{ purged: number; more: boolean }>
  /** The Salesforce lease sweep (sweep_sf_leases). */
  sweepSfLeases(limit: number): Promise<{ swept: number; more: boolean }>
  queueDisagreements(limit: number): Promise<QueueDisagreement[]>
  saveCopies(servedAt: string, complete: boolean, copies: readonly WorkflowCopyInput[]): Promise<SaveCopiesResult>
  readCopies(limit: number): Promise<{ copies: WorkflowCopy[]; reachedLimit: boolean }>
  recordObservation(organizationId: OrganizationId, obs: ScheduleObservation): Promise<'recorded' | 'already_recorded'>
  dueQueueDepth(): Promise<{ dueRuns: number; dueWorkflows: number; oldestDue: string | null }>
}

/**
 * A secret the tick found unset or unusable (#2333), and the sentence saying so.
 * The name travels in the report, so the bidding Worker pages with that secret's
 * remedy rather than another's.
 */
export interface UnconfiguredSecret {
  secret: string
  problem: string
}

/** One thing handed to OpsInternal.observe. */
export type DispatchItem =
  | { kind: 'would_fire'; workflowId: string; organizationId: string; scheduledFor: string; dispatchAt: string }
  | { kind: 'probe' }

export interface OpsTickPorts {
  tickId: string
  /** The cron's scheduledTime, reported as received; nothing keys on it. */
  scheduledTime: number | null
  /** This Worker's clock: only the report's start and finish read it. */
  now: () => number
  /** The ops database, or why it cannot be reached and the secrets that would reach it, by name. */
  db: OpsTickDb | { notConfigured: string; secrets: string[] }
  /**
   * The secrets the tick needs beyond its database, each one found unset or
   * unusable (#2333: the ops private key). Throws when it cannot check.
   */
  checkSecrets(): Promise<UnconfiguredSecret[]>
  gateway: {
    fetchWorkflows(): Promise<unknown>
    /** The ops connections, served by the bidding Worker (#2335). */
    fetchConnections(): Promise<unknown>
    started(): Promise<void>
    completed(report: OpsTickReport): Promise<void>
  }
  /** Throws when the call is refused or fails. */
  dispatch(item: DispatchItem): Promise<void>
}

const isDb = (db: OpsTickPorts['db']): db is OpsTickDb => !('notConfigured' in db)

/** A slot in the words an alert uses: Eastern time, as Dan reads every time (L118). */
const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const slotLabel = (ms: number): string => `${EASTERN.format(ms)} ET`

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by
}

/** The ops Worker's own log line for the tick: an outcome and counts, never a payload (L658). */
function log(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ event: 'ops_tick', step: event, ...fields }))
}

export async function runOpsTick(ports: OpsTickPorts): Promise<OpsTickReport> {
  const startedAt = new Date(ports.now()).toISOString()
  const problems: string[] = []
  const counts: Record<string, number> = {}
  let notConfigured = false
  const notConfiguredSecrets: string[] = []
  const unconfigured = (secrets: readonly string[]) => {
    notConfigured = true
    for (const s of secrets) if (!notConfiguredSecrets.includes(s)) notConfiguredSecrets.push(s)
  }
  let dbNow: string | null = null
  const items: DispatchItem[] = []

  // 1. Started. A miss is reported, and flagged so the bidding Worker can hold a
  // lone one for a tick (#2410): it judges whether the next tick missed too.
  let startStampFailed = false
  try {
    await ports.gateway.started()
  } catch (err) {
    startStampFailed = true
    problems.push(`The ops tick could not stamp its start with the bidding Worker (${formatErr(err)}).`)
  }

  const db = isDb(ports.db) ? ports.db : null
  if (!isDb(ports.db)) {
    unconfigured(ports.db.secrets)
    problems.push(`The ops tick cannot reach its database: ${ports.db.notConfigured}. It planned and swept nothing.`)
  }

  // The other secrets, inside their own boundary. Nothing the observe tick does
  // below needs them yet, so a missing one is reported and stops nothing.
  try {
    for (const found of await ports.checkSecrets()) {
      unconfigured([found.secret])
      problems.push(found.problem)
    }
  } catch (err) {
    problems.push(`The ops tick could not check its secrets (${formatErr(err)}), so whether those secrets, the ops private key among them, are usable is not known.`)
  }

  // 2. The database clock.
  if (db) {
    try {
      dbNow = await db.now()
    } catch (err) {
      problems.push(`The ops tick could not read the database clock (${formatErr(err)}), so it planned no fires: none may be computed on the Worker's clock.`)
    }
  }

  // 3. Sweeps, each its own boundary.
  if (db) {
    for (const s of TICK_SWEEPS) {
      try {
        const claim = await db.claimSweep(s.sweep, ports.tickId, s.everySeconds)
        if (!claim.owned) {
          bump(counts, 'sweeps_stood_down')
          continue
        }
        bump(counts, 'sweeps_run')
        if (s.sweep === 'queue_agreement') {
          const rows = await db.queueDisagreements(s.pageLimit)
          if (rows.length > 0) {
            const kinds = [...new Set(rows.map((r) => r.kind))].join(', ')
            problems.push(`The agreement check found ${rows.length}${rows.length === s.pageLimit ? ' or more' : ''} runs where the run queue and the runs disagree (${kinds}); every write keeps the two together, so each is a defect to look into.`)
          }
          continue
        }
        const sweep = s.sweep
        await drain(s.maxPages, async () => {
          switch (sweep) {
            case 'lease_expiry': {
              const r = await db.sweepLeases(s.pageLimit)
              bump(counts, 'leases_swept', r.requeued + r.retried + r.needsHuman + r.dead + r.failed)
              return r.more
            }
            case 'run_expiry': {
              const r = await db.expireRuns(s.pageLimit)
              bump(counts, 'runs_expired', r.expired)
              return r.more
            }
            case 'tombstone_expiry': {
              const r = await db.purgeTombstones(s.pageLimit)
              bump(counts, 'tombstones_purged', r.purged)
              return r.more
            }
          }
        })
      } catch (err) {
        problems.push(`The ${s.sweep} sweep failed: ${formatErr(err)}.`)
      }
    }

    // The Salesforce lease sweep, every tick, unclaimed (TICK_SF_LEASE_SWEEP), its own boundary.
    const sf = TICK_SF_LEASE_SWEEP
    try {
      bump(counts, 'sweeps_run')
      await drain(sf.maxPages, async () => {
        const r = await db.sweepSfLeases(sf.pageLimit)
        bump(counts, 'sf_leases_swept', r.swept)
        return r.more
      })
    } catch (err) {
      problems.push(`The ${sf.sweep} sweep failed: ${formatErr(err)}.`)
    }
  }

  // 4. The workflows: fetch, save, read back.
  let fetched: ReturnType<typeof parseServedOpsWorkflows> | null = null
  let fetchError: string | null = null
  try {
    fetched = parseServedOpsWorkflows(await ports.gateway.fetchWorkflows())
    problems.push(...fetched.refused)
    bump(counts, 'workflows_served', fetched.list.workflows.length)
  } catch (err) {
    fetchError = formatErr(err)
  }
  if (db && fetched) {
    const { list } = fetched
    const inputs: WorkflowCopyInput[] = list.workflows.map((w) => ({
      workflowId: w.id, organizationId: w.organization_id, isActive: w.is_active, deletedAt: w.deleted_at,
      rowUpdatedAt: w.updated_at, versionNumber: w.version_number, trigger: w.trigger,
    }))
    // A list too long for one save is saved in parts and withdraws nothing, since
    // no one part is the complete list.
    const oneSave = inputs.length <= MAX_COPIES_PER_SAVE
    if (!oneSave) problems.push(`The bidding Worker served ${inputs.length} ops workflows, more than one save carries, so workflows it no longer names were not withdrawn.`)
    for (let at = 0; at < inputs.length || at === 0; at += MAX_COPIES_PER_SAVE) {
      try {
        const saved = await db.saveCopies(list.served_at, list.complete && oneSave, inputs.slice(at, at + MAX_COPIES_PER_SAVE))
        bump(counts, 'copies_refused_older', saved.refusedOlder)
        bump(counts, 'copies_withdrawn', saved.withdrawn)
      } catch (err) {
        problems.push(`The ops tick could not save the workflows it fetched (${formatErr(err)}); it planned from the copies as they were.`)
      }
      if (inputs.length === 0) break
    }
  }

  let copies: WorkflowCopy[] = []
  if (db) {
    try {
      const read = await db.readCopies(COPIES_READ_LIMIT)
      copies = read.copies
      if (read.reachedLimit) problems.push(`The ops tick read ${COPIES_READ_LIMIT} workflow copies, its limit, so any past it were not planned.`)
    } catch (err) {
      problems.push(`The ops tick could not read the saved workflow copies (${formatErr(err)}), so it planned no fires.`)
    }
  }
  if (fetchError !== null) {
    if (copies.length > 0) {
      bump(counts, 'copies_used_saved')
      const oldest = Math.min(...copies.map((c) => Date.parse(c.confirmedAt)))
      problems.push(`The ops tick could not fetch the ops workflows from the bidding Worker (${fetchError}), so it planned from the saved copies, the oldest last confirmed ${slotLabel(oldest)}.`)
    } else {
      problems.push(`The ops tick could not fetch the ops workflows from the bidding Worker (${fetchError}) and has no saved copy, so it planned nothing.`)
    }
  }

  // 4b. The connections (#2335), their own boundary.
  if (db) {
    try {
      const saved = await saveServedConnections(db, () => ports.gateway.fetchConnections())
      problems.push(...saved.problems)
      for (const [key, n] of Object.entries(saved.counts)) bump(counts, key, n)
    } catch (err) {
      problems.push(`The ops tick could not save the ops connections: ${formatErr(err)}.`)
    }
  }

  // 5. The schedules, each its own boundary.
  if (dbNow !== null && db) {
    const dbNowMs = Date.parse(dbNow)
    for (const c of copies) {
      const sched = scheduleFromTrigger(c.trigger)
      if (sched.kind === 'none') continue
      bump(counts, 'schedules')
      try {
        if (!c.mayStart) {
          bump(counts, 'schedules_not_startable')
          continue
        }
        const found = validateSchedule(sched.config)
        if (found.length > 0) {
          bump(counts, 'schedules_refused')
          problems.push(`The schedule of workflow ${c.workflowId} is refused: ${found.map((p) => p.message).join('; ')}. It was kept and not fired.`)
          continue
        }
        if (c.versionNumber === null) {
          bump(counts, 'schedules_refused')
          problems.push(`Workflow ${c.workflowId} has a schedule but has no saved version, so there is nothing to run; it was not fired.`)
          continue
        }
        if (c.scheduleKnownSince === null) throw new Error('its copy has a schedule but no floor')
        const config = sched.config as ScheduleConfig
        const plan = planFires({
          workflowId: c.workflowId,
          schedule: config,
          dbNowMs,
          floorMs: scheduleFloorMs({ knownSinceMs: Date.parse(c.scheduleKnownSince) }),
          // Observe mode serves nothing, so what it observed is what it would have served.
          lastServedMs: c.lastObserved === null ? null : Date.parse(c.lastObserved),
        })
        for (const fire of plan.fires) {
          const outcome = await db.recordObservation(c.organizationId, {
            workflowId: c.workflowId, workflowVersion: c.versionNumber, scheduledFor: new Date(fire.scheduled_for), outcome: 'would_fire',
            reason: fire.reason, dispatchAt: new Date(fire.dispatch_at),
            previousScheduledFor: fire.previous_scheduled_for === null ? null : new Date(fire.previous_scheduled_for), tickId: ports.tickId,
          })
          if (outcome === 'already_recorded') {
            bump(counts, 'slots_already_recorded')
            continue
          }
          bump(counts, 'fires_observed')
          items.push({
            kind: 'would_fire', workflowId: c.workflowId, organizationId: c.organizationId,
            scheduledFor: new Date(fire.scheduled_for).toISOString(), dispatchAt: new Date(fire.dispatch_at).toISOString(),
          })
        }
        if (plan.missed) {
          const outcome = await db.recordObservation(c.organizationId, {
            workflowId: c.workflowId, workflowVersion: c.versionNumber, scheduledFor: new Date(plan.missed.scheduled_for), outcome: 'missed',
            reason: plan.missed.reason, dispatchAt: null, previousScheduledFor: null, tickId: ports.tickId,
          })
          if (outcome === 'recorded') {
            bump(counts, 'slots_missed')
            problems.push(`Workflow ${c.workflowId} missed its ${slotLabel(plan.missed.scheduled_for)} slot (${plan.missed.reason}): the tick did not see it inside its five minute window.`)
          }
        }
      } catch (err) {
        problems.push(`The schedule of workflow ${c.workflowId} could not be planned: ${formatErr(err)}.`)
      }
    }
  }

  // 6. The claim, observed.
  if (db) {
    try {
      const depth = await db.dueQueueDepth()
      bump(counts, 'due_runs', depth.dueRuns)
      bump(counts, 'would_claim', Math.min(depth.dueRuns, TICK_CLAIM_LIMIT, depth.dueWorkflows * TICK_CLAIM_PER_WORKFLOW))
    } catch (err) {
      problems.push(`The ops tick could not read what a claim would find: ${formatErr(err)}.`)
    }
  }

  // 7. Dispatch, each its own boundary, all awaited.
  const toSend: DispatchItem[] = items.length > 0 ? items : [{ kind: 'probe' }]
  const sent = await Promise.allSettled(toSend.map((item) => ports.dispatch(item)))
  sent.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      bump(counts, 'dispatched')
      return
    }
    bump(counts, 'dispatch_failed')
    const item = toSend[i]
    problems.push(item.kind === 'probe'
      ? `The probe through the dispatch path failed: ${formatErr(r.reason)}.`
      : `The dispatch of workflow ${item.workflowId}'s ${slotLabel(Date.parse(item.scheduledFor))} slot failed: ${formatErr(r.reason)}.`)
  })

  // 8. Completed.
  const outcome: OpsTickOutcome = notConfigured ? 'not_configured' : problems.length > 0 ? 'problems' : 'ok'
  const report: OpsTickReport = {
    tick_id: ports.tickId,
    mode: OPS_TICK_MODE,
    scheduled_time: ports.scheduledTime === null ? null : new Date(ports.scheduledTime).toISOString(),
    started_at: startedAt,
    finished_at: new Date(ports.now()).toISOString(),
    db_now: dbNow,
    outcome,
    problems: capProblems(problems),
    counts,
    not_configured_secrets: notConfiguredSecrets,
    start_stamp_failed: startStampFailed,
  }
  log('finished', { tick_id: ports.tickId, outcome, problems: problems.length, ...counts })
  for (const p of problems) log('problem', { tick_id: ports.tickId, problem: p })
  try {
    await ports.gateway.completed(report)
  } catch (err) {
    // Nothing else can carry it now; the heartbeat reads this tick as never finishing.
    console.error(JSON.stringify({ event: 'ops_tick', step: 'completed_stamp_failed', tick_id: ports.tickId, error: formatErr(err) }))
  }
  return report
}
