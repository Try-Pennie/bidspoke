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
 *     sweep, which needs no claim (TICK_SF_LEASE_SWEEP says why). Since #2336
 *     the sf_limits sweep too (sf-limits.ts), which reads each measured
 *     Salesforce org's limits beside the rest of the tick and is awaited before
 *     step 8, stamping its own heartbeat (SF_LIMITS_JOB) through the gateway.
 *     Since #2340 the connection_check sweep (connection-check.ts) the same way,
 *     which proves each ops connection's login and stamps CONNECTION_CHECK_JOB.
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
 *     Then, every tick, the connections' login states (#2340,
 *     connection-check.ts judgeConnectionLogins), read after that save so a
 *     withdrawal served this minute is judged, and carried in the report for the
 *     bidding Worker to page through the ops-connection-login signal.
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
 *     minute and pages on (lib/ops-gateway.ts runOpsTickReportCheck). Each
 *     problem carries a key, its kind and subject (#2506): a kind a passing tick
 *     would clear pages only once three ticks in a row report it, and every
 *     other kind at once (OPS_TICK_PROBLEM_RULES in lib/ops-gateway-contract.ts).
 *
 * Every port is injected, so the tests set both clocks (tick.test.ts); the live
 * ports are tick-live.ts.
 */
import { planFires, scheduleFloorMs, scheduleFromTrigger, validateSchedule, type MissedReason, type PlannedFire, type ScheduleConfig } from '@bidspoke/workflow-definition'
import {
  CONNECTION_CHECK_JOB, SF_LIMITS_JOB, capTickProblems, parseServedOpsWorkflows, tickProblem, type ConnectionLoginsReport, type OpsGatewayJob, type OpsJobReport,
  type OpsTickMode, type OpsTickOutcome, type OpsTickProblemKind, type OpsTickReport, type TickProblem,
} from '../lib/ops-gateway-contract'
import { SF_LIMITS_EVERY_SECONDS, SF_LIMITS_MAX_ORGS, runSfLimitsSweep, type SfLimitsSweepDeps, type SfLimitsSweepResult } from './sf-limits'
import {
  CONNECTION_CHECK_EVERY_SECONDS, CONNECTION_CHECK_MAX_CONNECTIONS, CONNECTION_LOGINS_READ_LIMIT, judgeConnectionLogins, runConnectionCheckSweep,
  type ConnectionCheckSweepDeps, type ConnectionCheckSweepResult,
} from './connection-check'
import { formatErr } from '../lib/format-error'
import { saveServedConnections, type ConnectionServeDb } from './connection-serve'
import type { OrganizationId } from './ops-db'
import {
  MAX_COPIES_PER_SAVE, type ConnectionCheckTarget, type QueueDisagreement, type SaveCopiesResult, type ScheduleObservation, type SfLimitsTarget, type SweepClaim,
  type SweepResult, type WorkflowCopy, type WorkflowCopyInput,
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

/** The sweeps the tick claims: every one claim_ops_sweep names (#2340 brought the last, connection_check). */
export type TickSweep = OpsSweep

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
 *
 * sf_limits (#2336, sf-limits.ts) reads each measured Salesforce org's /limits
 * and writes its budget reading, every 4 to 5 minutes (sf-limits.ts THE
 * INTERVAL says why). Unlike the others it runs BESIDE the rest of the tick,
 * awaited before the report: its reads go to Salesforce and are bounded at 45 s
 * each, which must not hold the schedules back. It stamps its own heartbeat
 * (SF_LIMITS_JOB) only when it owns the claim, and reports its failures as
 * keyed problems that each page at once, since it can never be reported by
 * three ticks in a row (it holds a transient one itself, by its reading's age).
 *
 * connection_check (#2340, connection-check.ts) proves each ops connection's
 * login every 14 to 15 minutes (connection-check.ts THE INTERVAL says why), and
 * runs beside the rest of the tick in the same way and for the same reason: its
 * probes go to the services, bounded at 30 s each and 55 s a sweep. It stamps its own heartbeat
 * (CONNECTION_CHECK_JOB) only when it owns the claim, and holds a transient
 * failure itself, by the age of the connection's last passing check.
 */
export const TICK_SWEEPS: ReadonlyArray<{ sweep: TickSweep; everySeconds: number; pageLimit: number; maxPages: number }> = [
  { sweep: 'lease_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'run_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'queue_agreement', everySeconds: 14 * 60, pageLimit: 100, maxPages: 1 },
  { sweep: 'tombstone_expiry', everySeconds: 59 * 60, pageLimit: 500, maxPages: 4 },
  { sweep: 'sf_limits', everySeconds: SF_LIMITS_EVERY_SECONDS, pageLimit: SF_LIMITS_MAX_ORGS, maxPages: 1 },
  { sweep: 'connection_check', everySeconds: CONNECTION_CHECK_EVERY_SECONDS, pageLimit: CONNECTION_CHECK_MAX_CONNECTIONS, maxPages: 1 },
]

/**
 * The Salesforce lease sweep (#2334, sweep_sf_leases), which runs every tick and
 * takes no claim. claim_ops_sweep has no name for it, and it needs none: it
 * deletes only leases already past expires_at, FOR UPDATE SKIP LOCKED, and a
 * lapsed lease stopped counting toward any pool the moment it lapsed, since
 * acquire_sf_lease counts only leases whose expires_at is still ahead. So
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
  /** The sf_limits sweep's measured orgs (sf_limits_targets, #2336). */
  sfLimitsTargets(limit: number): Promise<{ targets: SfLimitsTarget[]; reachedLimit: boolean }>
  /** A measured org's reading from its /limits read (record_sf_budget_reading, source limits). */
  recordSfLimitsReading(sfOrgId: string, reading: { dailyApiMax: number; dailyApiRemaining: number }): Promise<'recorded'>
  /** Every ops connection with its login state (connection_check_targets, #2340): the sweep's list and the tick's login states. */
  connectionCheckTargets(limit: number): Promise<{ targets: ConnectionCheckTarget[]; reachedLimit: boolean }>
  /** A connection check's result (record_connection_check): the last_check_* columns only. */
  recordConnectionCheck(organizationId: OrganizationId, connectionId: string, result: { ok: true } | { ok: false; cause: string }): Promise<'recorded' | 'connection_removed'>
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
    /** An ops job's heartbeat stamps (OpsGateway.opsJobStarted and opsJobCompleted, #2340). */
    jobStarted(job: OpsGatewayJob): Promise<void>
    jobCompleted(job: OpsGatewayJob, report: OpsJobReport): Promise<void>
  }
  /** The sf_limits sweep's read of one org's /limits (#2336): connectionFetch, purpose sf_limits, in tick-live.ts. */
  sfLimits: Pick<SfLimitsSweepDeps, 'read' | 'sleep' | 'log'>
  /** The connection_check sweep's identity probe of one connection (#2340): connectionFetch, purpose connection_check, in tick-live.ts. */
  connectionCheck: Pick<ConnectionCheckSweepDeps, 'probe' | 'sleep' | 'log'>
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

/**
 * The sf_limits sweep wired to the tick's ports. Never rejects: a throw past
 * the sweep's own boundaries is reported as sf_limits_failed, so the tick's
 * report still goes.
 */
function startSfLimits(ports: OpsTickPorts, db: OpsTickDb): Promise<SfLimitsSweepResult> {
  const job: OpsGatewayJob = SF_LIMITS_JOB
  return (async () => {
    // Read at once, so a port this deploy lacks is this sweep's failure by name.
    const { read, sleep, log } = ports.sfLimits
    return runSfLimitsSweep({
      targets: (limit) => db.sfLimitsTargets(limit),
      read,
      record: (sfOrgId, reading) => db.recordSfLimitsReading(sfOrgId, reading),
      started: () => ports.gateway.jobStarted(job),
      completed: (report) => ports.gateway.jobCompleted(job, report),
      now: ports.now,
      sleep,
      log,
    })
  })().catch((err: unknown) => ({
    problems: [tickProblem('sf_limits_failed', `The sf_limits sweep failed: ${formatErr(err)}.`)],
    counts: {},
  }))
}

/**
 * The connection_check sweep wired to the tick's ports. Never rejects: a throw
 * past the sweep's own boundaries is reported as connection_check_failed, so the
 * tick's report still goes.
 */
function startConnectionCheck(ports: OpsTickPorts, db: OpsTickDb): Promise<ConnectionCheckSweepResult> {
  const job: OpsGatewayJob = CONNECTION_CHECK_JOB
  return (async () => {
    // Read at once, so a port this deploy lacks is this sweep's failure by name.
    const { probe, sleep, log } = ports.connectionCheck
    return runConnectionCheckSweep({
      targets: (limit) => db.connectionCheckTargets(limit),
      probe,
      record: (target, result) => db.recordConnectionCheck(target.organizationId, target.connectionId, result),
      started: () => ports.gateway.jobStarted(job),
      completed: (report) => ports.gateway.jobCompleted(job, report),
      now: ports.now,
      sleep,
      log,
    })
  })().catch((err: unknown) => ({
    problems: [tickProblem('connection_check_failed', `The connection check failed: ${formatErr(err)}.`)],
    counts: {},
  }))
}

export async function runOpsTick(ports: OpsTickPorts): Promise<OpsTickReport> {
  const startedAt = new Date(ports.now()).toISOString()
  // Each problem keyed by its kind (#2506), so the bidding Worker can hold one a
  // passing tick would clear until three ticks in a row report it.
  const problems: TickProblem[] = []
  const problem = (kind: OpsTickProblemKind, text: string, subject?: string) => { problems.push(tickProblem(kind, text, subject)) }
  const counts: Record<string, number> = {}
  let notConfigured = false
  const notConfiguredSecrets: string[] = []
  const unconfigured = (secrets: readonly string[]) => {
    notConfigured = true
    for (const s of secrets) if (!notConfiguredSecrets.includes(s)) notConfiguredSecrets.push(s)
  }
  let dbNow: string | null = null
  const items: DispatchItem[] = []
  let sfLimitsRun: Promise<SfLimitsSweepResult> | null = null
  let connectionCheckRun: Promise<ConnectionCheckSweepResult> | null = null
  let connectionLogins: ConnectionLoginsReport | null = null

  // 1. Started. A miss is reported under start_stamp, which the bidding Worker
  // holds until three ticks in a row miss (#2506), and flagged as before (#2410).
  let startStampFailed = false
  try {
    await ports.gateway.started()
  } catch (err) {
    startStampFailed = true
    problem('start_stamp', `The ops tick could not stamp its start with the bidding Worker (${formatErr(err)}).`)
  }

  const db = isDb(ports.db) ? ports.db : null
  if (!isDb(ports.db)) {
    unconfigured(ports.db.secrets)
    problem('db_not_configured', `The ops tick cannot reach its database: ${ports.db.notConfigured}. It planned and swept nothing.`)
  }

  // The other secrets, inside their own boundary. Nothing the observe tick does
  // below needs them yet, so a missing one is reported and stops nothing.
  try {
    for (const found of await ports.checkSecrets()) {
      unconfigured([found.secret])
      problem('not_configured', found.problem, found.secret)
    }
  } catch (err) {
    problem('secrets_unchecked', `The ops tick could not check its secrets (${formatErr(err)}), so whether those secrets, the ops private key among them, are usable is not known.`)
  }

  // 2. The database clock.
  if (db) {
    try {
      dbNow = await db.now()
    } catch (err) {
      problem('db_clock', `The ops tick could not read the database clock (${formatErr(err)}), so it planned no fires: none may be computed on the Worker's clock.`)
    }
  }

  // 3. Sweeps, each its own boundary.
  if (db) {
    for (const s of TICK_SWEEPS) {
      // The claim in its own boundary (#2506): a claim that failed is asked again
      // on the next tick, for every sweep, while a sweep that failed after its
      // claim is next tried when its interval comes round.
      let claim: SweepClaim
      try {
        claim = await db.claimSweep(s.sweep, ports.tickId, s.everySeconds)
      } catch (err) {
        problem('sweep_claim_failed', `The ${s.sweep} sweep failed: ${formatErr(err)}.`, s.sweep)
        continue
      }
      try {
        if (!claim.owned) {
          bump(counts, 'sweeps_stood_down')
          continue
        }
        bump(counts, 'sweeps_run')
        if (s.sweep === 'sf_limits') {
          // Beside the rest of the tick, awaited before the report (TICK_SWEEPS says why).
          sfLimitsRun = startSfLimits(ports, db)
          continue
        }
        if (s.sweep === 'connection_check') {
          // Beside the rest of the tick, awaited before the report, as sf_limits is.
          connectionCheckRun = startConnectionCheck(ports, db)
          continue
        }
        if (s.sweep === 'queue_agreement') {
          const rows = await db.queueDisagreements(s.pageLimit)
          if (rows.length > 0) {
            const kinds = [...new Set(rows.map((r) => r.kind))].join(', ')
            problem('queue_disagreement', `The agreement check found ${rows.length}${rows.length === s.pageLimit ? ' or more' : ''} runs where the run queue and the runs disagree (${kinds}); every write keeps the two together, so each is a defect to look into.`)
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
        if (s.sweep === 'queue_agreement') problem('agreement_check_failed', `The ${s.sweep} sweep failed: ${formatErr(err)}.`)
        else problem('sweep_failed', `The ${s.sweep} sweep failed: ${formatErr(err)}.`, s.sweep)
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
      problem('sweep_failed', `The ${sf.sweep} sweep failed: ${formatErr(err)}.`, sf.sweep)
    }
  }

  // 4. The workflows: fetch, save, read back.
  let fetched: ReturnType<typeof parseServedOpsWorkflows> | null = null
  let fetchError: string | null = null
  try {
    fetched = parseServedOpsWorkflows(await ports.gateway.fetchWorkflows())
    for (const text of fetched.refused) problem('workflow_refused', text)
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
    if (!oneSave) problem('workflows_too_many', `The bidding Worker served ${inputs.length} ops workflows, more than one save carries, so workflows it no longer names were not withdrawn.`)
    for (let at = 0; at < inputs.length || at === 0; at += MAX_COPIES_PER_SAVE) {
      try {
        const saved = await db.saveCopies(list.served_at, list.complete && oneSave, inputs.slice(at, at + MAX_COPIES_PER_SAVE))
        bump(counts, 'copies_refused_older', saved.refusedOlder)
        bump(counts, 'copies_withdrawn', saved.withdrawn)
      } catch (err) {
        problem('workflows_save_failed', `The ops tick could not save the workflows it fetched (${formatErr(err)}); it planned from the copies as they were.`)
      }
      if (inputs.length === 0) break
    }
  }

  let copies: WorkflowCopy[] = []
  if (db) {
    try {
      const read = await db.readCopies(COPIES_READ_LIMIT)
      copies = read.copies
      if (read.reachedLimit) problem('copies_read_limit', `The ops tick read ${COPIES_READ_LIMIT} workflow copies, its limit, so any past it were not planned.`)
    } catch (err) {
      problem('copies_read_failed', `The ops tick could not read the saved workflow copies (${formatErr(err)}), so it planned no fires.`)
    }
  }
  if (fetchError !== null) {
    if (copies.length > 0) {
      bump(counts, 'copies_used_saved')
      const oldest = Math.min(...copies.map((c) => Date.parse(c.confirmedAt)))
      problem('workflows_fetch_failed', `The ops tick could not fetch the ops workflows from the bidding Worker (${fetchError}), so it planned from the saved copies, the oldest last confirmed ${slotLabel(oldest)}.`)
    } else {
      problem('workflows_fetch_failed', `The ops tick could not fetch the ops workflows from the bidding Worker (${fetchError}) and has no saved copy, so it planned nothing.`)
    }
  }

  // 4b. The connections (#2335), their own boundary.
  if (db) {
    try {
      const saved = await saveServedConnections(db, () => ports.gateway.fetchConnections())
      problems.push(...saved.problems)
      for (const [key, n] of Object.entries(saved.counts)) bump(counts, key, n)
    } catch (err) {
      problem('connections_step_failed', `The ops tick could not save the ops connections: ${formatErr(err)}.`)
    }
  }

  // 4c. The connections' login states (#2340), every tick, their own boundary.
  // A failed read reports no list at all, which the bidding Worker reads as
  // unjudged, never as every login cleared.
  if (db) {
    try {
      connectionLogins = judgeConnectionLogins(await db.connectionCheckTargets(CONNECTION_LOGINS_READ_LIMIT))
      bump(counts, 'connection_logins_due', connectionLogins.logins.length)
      if (!connectionLogins.complete) {
        problem('connection_logins_limit', `The ops tick read more ops connections, or found more logins to page about, than one report carries (${CONNECTION_LOGINS_READ_LIMIT} connections, ${connectionLogins.logins.length} logins), so a login past them was not judged and no all clear is sent for it.`)
      }
    } catch (err) {
      problem('connection_logins_failed', `The ops tick could not read the ops connections' login states (${formatErr(err)}), so no login was judged this minute.`)
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
          problem('schedule_refused', `The schedule of workflow ${c.workflowId} is refused: ${found.map((p) => p.message).join('; ')}. It was kept and not fired.`, c.workflowId)
          continue
        }
        if (c.versionNumber === null) {
          bump(counts, 'schedules_refused')
          problem('schedule_no_version', `Workflow ${c.workflowId} has a schedule but has no saved version, so there is nothing to run; it was not fired.`, c.workflowId)
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
            problem('slot_missed', `Workflow ${c.workflowId} missed its ${slotLabel(plan.missed.scheduled_for)} slot (${plan.missed.reason}): the tick did not see it inside its five minute window.`, c.workflowId)
          }
        }
      } catch (err) {
        problem('schedule_plan_failed', `The schedule of workflow ${c.workflowId} could not be planned: ${formatErr(err)}.`, c.workflowId)
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
      problem('claim_depth_failed', `The ops tick could not read what a claim would find: ${formatErr(err)}.`)
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
    if (item.kind === 'probe') problem('probe_failed', `The probe through the dispatch path failed: ${formatErr(r.reason)}.`)
    else problem('dispatch_failed', `The dispatch of workflow ${item.workflowId}'s ${slotLabel(Date.parse(item.scheduledFor))} slot failed: ${formatErr(r.reason)}.`, item.workflowId)
  })

  // 7b. The sf_limits sweep, if this tick owns it, settled before the report carries its problems.
  if (sfLimitsRun !== null) {
    const sf = await sfLimitsRun
    problems.push(...sf.problems)
    for (const [key, n] of Object.entries(sf.counts)) bump(counts, key, n)
  }
  // 7c. The connection_check sweep, the same way.
  if (connectionCheckRun !== null) {
    const cc = await connectionCheckRun
    problems.push(...cc.problems)
    for (const [key, n] of Object.entries(cc.counts)) bump(counts, key, n)
  }

  // 8. Completed.
  const outcome: OpsTickOutcome = notConfigured ? 'not_configured' : problems.length > 0 ? 'problems' : 'ok'
  const capped = capTickProblems(problems)
  const report: OpsTickReport = {
    tick_id: ports.tickId,
    mode: OPS_TICK_MODE,
    scheduled_time: ports.scheduledTime === null ? null : new Date(ports.scheduledTime).toISOString(),
    started_at: startedAt,
    finished_at: new Date(ports.now()).toISOString(),
    db_now: dbNow,
    outcome,
    problems: capped.problems,
    counts,
    not_configured_secrets: notConfiguredSecrets,
    start_stamp_failed: startStampFailed,
    problem_keys: capped.problem_keys,
    connection_logins: connectionLogins,
  }
  log('finished', { tick_id: ports.tickId, outcome, problems: problems.length, ...counts })
  for (const p of problems) log('problem', { tick_id: ports.tickId, key: p.key, problem: p.text })
  try {
    await ports.gateway.completed(report)
  } catch (err) {
    // Nothing else can carry it now; the heartbeat reads this tick as never finishing.
    console.error(JSON.stringify({ event: 'ops_tick', step: 'completed_stamp_failed', tick_id: ports.tickId, error: formatErr(err) }))
  }
  return report
}
