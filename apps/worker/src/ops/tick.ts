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
 *     Since #1950 the observation_purge sweep, which keeps
 *     schedule_fire_observations to 30 days, and since #2339 step_test_results
 *     to 7 days, and is claimed only while the database clock reads the 03:00
 *     Eastern hour (OBSERVATION_PURGE_EVERY_SECONDS).
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
 *     bidding Worker to page through the ops-connection-login signal. On the
 *     tick that owns the connection_check claim, the same list's
 *     ConnectionTokenObjects are asked whether a rotated login waits for its
 *     write back (#2340 phase 10 item 4, write-back-check.ts), beside the rest
 *     of the tick, and those pending past the bound are carried in the report's
 *     write_backs for the ops-connection-write-back signal.
 *     Then, every tick and in either mode (#1950), the frozen definition copies
 *     (copyDefinitions): each current version the ops database does not hold
 *     yet is asked of the bidding Worker and saved, so a run executes the
 *     version it started on through a bidding outage. A conflict, an unserved
 *     version or a refused row pages at once; a failed request or save is
 *     asked again next tick.
 *  5. The schedules, each inside its own boundary: planFires (packages/
 *     workflow-definition) with the database clock, the floor and the last slot
 *     observed; each fire recorded in schedule_fire_observations, whose UNIQUE
 *     slot key means a doubled tick records, and dispatches, a slot once. A miss
 *     is recorded and reported: a missing expected run is a problem (#1949).
 *  6. The claim, observed: what a claim of up to TICK_CLAIM_PER_WORKFLOW runs a
 *     workflow (k) would find, read without claiming.
 *
 * LIVE MODE (#1950, OPS_TICK_MODE=live; observe as deployed). Step 5 records
 * each fire for real (record_schedule_fire: its fire row and its run in one
 * transaction), planning from the later of the last real fire and the last
 * observed slot. Step 6 claims (claim_run_requests, k per workflow, the run
 * lease) instead of reading the depth. Step 7 hands each claimed run to
 * OpsInternal.run, signed and awaited, each in its own boundary; a run of a
 * workflow its copy says is switched off or deleted is ended dead unrun. With
 * the copies last confirmed more than COPIES_STALE_AFTER_MS ago nothing fires
 * or is claimed, and copies_stale pages. The runs' outcomes are counted per
 * workflow against a rate (judgeRunOutcomes, L77).
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
import { easternParts } from '@bidspoke/buyer-profile'
import { planFires, scheduleFloorMs, scheduleFromTrigger, validateSchedule, type MissedReason, type PlannedFire, type ScheduleConfig } from '@bidspoke/workflow-definition'
import {
  CONNECTION_CHECK_JOB, MAX_DEFINITIONS_PER_REQUEST, SF_LIMITS_JOB, capTickProblems, parseServedOpsDefinitions, parseServedOpsWorkflows, tickProblem,
  type ConnectionLoginsReport, type OpsDefinitionRequest, type OpsGatewayJob, type OpsJobReport,
  type OpsTickMode, type OpsTickOutcome, type OpsTickProblemKind, type OpsTickReport, type TickProblem, type WriteBacksReport,
} from '../lib/ops-gateway-contract'
import { runWriteBackCheck, type WriteBackCheckDeps } from './write-back-check'
import { SF_LIMITS_EVERY_SECONDS, SF_LIMITS_MAX_ORGS, runSfLimitsSweep, type SfLimitsSweepDeps, type SfLimitsSweepResult } from './sf-limits'
import {
  CONNECTION_CHECK_EVERY_SECONDS, CONNECTION_CHECK_MAX_CONNECTIONS, CONNECTION_LOGINS_READ_LIMIT, judgeConnectionLogins, runConnectionCheckSweep,
  type ConnectionCheckSweepDeps, type ConnectionCheckSweepResult,
} from './connection-check'
import { formatErr } from '../lib/format-error'
import { saveServedConnections, type ConnectionServeDb } from './connection-serve'
import type { OrganizationId } from './ops-db'
import { RUN_LEASE_SECONDS, type RunInvocationReport } from './run-invocation'
import {
  MAX_COPIES_PER_SAVE, type ClaimRunRequests, type ClaimedRun, type CompleteOutcome, type CompletedRun, type ScheduleFire, type ScheduleFireResult, type ConnectionCheckTarget, type QueueDisagreement, type SaveCopiesResult, type ScheduleObservation, type SfLimitsTarget, type SweepClaim,
  type SweepResult, type WorkflowCopy, type WorkflowCopyInput,
} from './ops-writes'
import { OBSERVATION_REASONS, type OpsSweep, type OverlapRule } from './run-vocabulary'


/** k, the most runs of one workflow a claim takes (#1698 D1): the fair claim measured at k 5 (spike P9). */
export const TICK_CLAIM_PER_WORKFLOW = 5
/** The most runs one tick would claim: 40 concurrent dispatches from one tick were measured to work (spike P4). */
export const TICK_CLAIM_LIMIT = 40

/** The versions not held yet that one tick lists (L24: within PostgREST's 1,000 rows), and how many of them it asks the bidding Worker for. */
export const DEFINITIONS_READ_LIMIT = 1000
export const DEFINITIONS_PER_TICK = 30

/**
 * In live mode, how old the saved workflow copies may be and still start runs
 * (Dan, 2026-10-22, on #1950): within it, ported workflows keep running through
 * a bidding outage from their last confirmed copies; past it, the tick fires no
 * schedule and claims no run, and pages (copies_stale), so a long outage cannot
 * run a workflow on a stale on or off state. Judged on the database clock.
 */
export const COPIES_STALE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * The rate at which one workflow's runs, in one tick, ending lost (a claim
 * lost, a start or complete that failed, a dispatch that failed) or requeued
 * (a retry or a wait) pages, held for three ticks in a row (L77): an outcome
 * each run treats as expected is still counted, so a systemic failure is not
 * read as ordinary noise. Judged only from RUN_OUTCOME_MIN_RUNS runs of the
 * workflow in the tick (L716), so one unlucky run of a quiet workflow never pages.
 * Both are first settings, to be re-measured once live runs exist (L316).
 */
export const RUN_OUTCOME_MIN_RUNS = 3
export const RUN_OUTCOME_FAILING_RATE = 0.5

/** The copies one tick reads: every ops workflow, within PostgREST's 1,000 rows (L24). */
const COPIES_READ_LIMIT = 1000

/** The sweeps the tick claims: every one claim_ops_sweep names (#2340 brought connection_check, #1950 observation_purge). */
export type TickSweep = OpsSweep

/**
 * The observation purge (#1950): schedule_fire_observations is kept 30 days
 * (Dan, 2026-10-22), and purge_schedule_observations holds that window itself.
 * It runs once a night: claimed only while the DATABASE clock reads the 03:00
 * Eastern hour (the shared Eastern clock, packages/buyer-profile, L655), and
 * for 20 hours, so a second tick inside that hour stands down and the next
 * night's claim is free. Up to 10 pages of 1,000 rows a night, far past the
 * rows a day of every ops schedule adds; a backlog drains over the nights that
 * follow, and only rows past 30 days wait for it. The same sweep deletes the
 * step test results tested more than 7 days ago (#2339, Dan, 2026-10-23;
 * purge_step_test_results holds that window), and their reader serves none
 * older than 7 days whether or not the purge has run; and the step records of
 * run attempts started more than 7 days ago (#2703, Dan, 2026-10-24;
 * purge_ops_step_records holds that window, and run_step_context serves none
 * older). A run's own purge takes its step records with it.
 */
export const OBSERVATION_PURGE_EVERY_SECONDS = 20 * 3600
export const OBSERVATION_PURGE_EASTERN_HOUR = 3

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
 * keyed problems the bidding Worker judges by this sweep's runs, not the
 * tick's (OPS_TICK_PROBLEM_SWEEPS, #2340), which is why the report names the
 * sweeps each tick ran (sweeps_run).
 *
 * connection_check (#2340, connection-check.ts) proves each ops connection's
 * login every 14 to 15 minutes (connection-check.ts THE INTERVAL says why), and
 * runs beside the rest of the tick in the same way and for the same reason: its
 * probes go to the services, bounded at 30 s each and 55 s a sweep. It stamps its own heartbeat
 * (CONNECTION_CHECK_JOB) only when it owns the claim, and holds a transient
 * failure itself, by the age of the connection's last passing check.
 */
export const TICK_SWEEPS: ReadonlyArray<{ sweep: TickSweep; everySeconds: number; pageLimit: number; maxPages: number; easternHour?: number }> = [
  { sweep: 'lease_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'run_expiry', everySeconds: 50, pageLimit: 500, maxPages: 4 },
  { sweep: 'queue_agreement', everySeconds: 14 * 60, pageLimit: 100, maxPages: 1 },
  { sweep: 'tombstone_expiry', everySeconds: 59 * 60, pageLimit: 500, maxPages: 4 },
  { sweep: 'sf_limits', everySeconds: SF_LIMITS_EVERY_SECONDS, pageLimit: SF_LIMITS_MAX_ORGS, maxPages: 1 },
  { sweep: 'connection_check', everySeconds: CONNECTION_CHECK_EVERY_SECONDS, pageLimit: CONNECTION_CHECK_MAX_CONNECTIONS, maxPages: 1 },
  { sweep: 'observation_purge', everySeconds: OBSERVATION_PURGE_EVERY_SECONDS, pageLimit: 1000, maxPages: 10, easternHour: OBSERVATION_PURGE_EASTERN_HOUR },
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
  /** The observation_purge sweep (purge_schedule_observations, #1950). */
  purgeObservations(limit: number): Promise<{ purged: number; more: boolean }>
  /** Also the observation_purge sweep: step test results past 7 days (purge_step_test_results, #2339). */
  purgeStepTests(limit: number): Promise<{ purged: number; more: boolean }>
  /** Also the observation_purge sweep: the step records of run attempts past 7 days (purge_ops_step_records, #2703). */
  purgeStepRecords(limit: number): Promise<{ purged: number; more: boolean }>
  /** The saved copies whose current version has no frozen definition yet (missing_workflow_definitions, #1950). */
  missingDefinitions(limit: number): Promise<{ missing: Array<{ workflowId: string; organizationId: OrganizationId; versionNumber: number }>; reachedLimit: boolean }>
  /** A slot fired for real in live mode: its fire row and its run in one transaction (record_schedule_fire, #1950). */
  recordFire(organizationId: OrganizationId, fire: ScheduleFire): Promise<ScheduleFireResult>
  /** The live claim (claim_run_requests, #1950). */
  claimRuns(claim: ClaimRunRequests): Promise<ClaimedRun[]>
  /** Ends a claimed run without running it (complete_run_request): a workflow switched off or deleted. */
  completeRun(run: ClaimedRun, end: CompleteOutcome): Promise<CompletedRun>
  /** One version's frozen definition (save_workflow_definition, #1950). */
  saveDefinition(organizationId: OrganizationId, workflowId: string, versionNumber: number, definition: Record<string, unknown>): Promise<'saved' | 'already_saved' | 'conflict' | 'no_copy'>
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
  /** A claimed run for OpsInternal.run (#1950). Its claim token is its nonce: start_run_execution takes a claim once. */
  | { kind: 'run'; run: ClaimedRun }

export interface OpsTickPorts {
  /** observe (the deployed default) or live (#1950), from OPS_TICK_MODE. */
  mode: OpsTickMode
  /**
   * One claimed run handed to OpsInternal.run through the SELF binding, signed,
   * and awaited (a dispatched call dies with the tick that made it, spike P4).
   * Throws when the call is refused or fails.
   */
  dispatchRun(run: ClaimedRun): Promise<RunInvocationReport>
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
    /** The definitions of the versions named, served by the bidding Worker (#1950). */
    fetchDefinitions(request: OpsDefinitionRequest): Promise<unknown>
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
  /** The write back check's read of one connection's ConnectionTokenObject (#2340 phase 10 item 4): the CONNECTION_TOKENS binding, in tick-live.ts. */
  writeBacks: Pick<WriteBackCheckDeps, 'read' | 'sleep'>
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

/** The write back check's result as the tick carries it: a list, or null when nothing was judged. */
interface WriteBacksRun {
  report: WriteBacksReport | null
  problems: TickProblem[]
  counts: Record<string, number>
}

/**
 * The write back check wired to the tick's ports, on the list the tick already
 * read. Never rejects: a throw past the check's own boundaries is reported as
 * write_back_check_failed with no list, so it is unjudged, never all landed.
 */
function startWriteBacks(ports: OpsTickPorts, list: Parameters<typeof runWriteBackCheck>[1]): Promise<WriteBacksRun> {
  return (async (): Promise<WriteBacksRun> => {
    // Read at once, so a port this deploy lacks is this check's failure by name.
    const { read, sleep } = ports.writeBacks
    return runWriteBackCheck({ read, sleep, now: ports.now }, list)
  })().catch((err: unknown) => ({
    report: null,
    problems: [tickProblem('write_back_check_failed', `The write back check failed (${formatErr(err)}), so whether a new login of a person bound connection is waiting to be saved back to Bidspoke was not judged; it runs again with the connection check.`)],
    counts: {},
  }))
}

/**
 * The frozen definition copies (#1950, Dan's decision recorded on #1950,
 * 2026-10-22): each saved copy's current version not held yet is asked of the
 * bidding Worker and saved under the organization the copy places it in. A
 * version never changes, so once held it is never asked for again; one that
 * differs from the copy held is a conflict the database keeps the first of,
 * and pages. A failed list, request or answer is held for three ticks (every
 * version not held is asked again next tick); each save has its own boundary.
 *
 * WHICH ARE ASKED. Up to DEFINITIONS_READ_LIMIT missing versions are listed,
 * and DEFINITIONS_PER_TICK of them asked, in requests of
 * MAX_DEFINITIONS_PER_REQUEST, from a window that moves along the list every
 * minute. So a version that can never be served (it pages at once each time it
 * is asked) cannot stand at the front of the list and starve every version
 * behind it (L778): each listed version is asked within a few minutes.
 */
async function copyDefinitions(
  ports: OpsTickPorts, db: OpsTickDb, problem: (kind: OpsTickProblemKind, text: string, subject?: string) => void, counts: Record<string, number>,
): Promise<void> {
  let listed: Awaited<ReturnType<OpsTickDb['missingDefinitions']>>
  try {
    listed = await db.missingDefinitions(DEFINITIONS_READ_LIMIT)
  } catch (err) {
    problem('definitions_failed', `The ops tick could not list the workflow versions it does not hold yet (${formatErr(err)}); it asks again next minute.`)
    return
  }
  if (listed.missing.length === 0) return
  bump(counts, 'definitions_missing', listed.missing.length)
  if (listed.reachedLimit) {
    problem('definitions_backlog', `More than ${DEFINITIONS_READ_LIMIT} ops workflow versions are not held yet, so some are not even listed to ask the bidding Worker for; runs of them will wait for their definition.`)
  }
  const all = listed.missing
  const start = (Math.floor(ports.now() / 60_000) * DEFINITIONS_PER_TICK) % all.length
  const window = Array.from({ length: Math.min(DEFINITIONS_PER_TICK, all.length) }, (_, i) => all[(start + i) % all.length])
  for (let at = 0; at < window.length; at += MAX_DEFINITIONS_PER_REQUEST) {
    // A request that fails ends this tick's asking: with the bidding Worker down,
    // each further batch would wait out its own gateway deadline before the
    // schedules run, so the next minute asks again instead.
    if (!(await copyDefinitionBatch(ports, db, window.slice(at, at + MAX_DEFINITIONS_PER_REQUEST), problem, counts))) return
  }
}

/** One request's worth of versions, its own boundary. False when the request itself failed. */
async function copyDefinitionBatch(
  ports: OpsTickPorts, db: OpsTickDb, missing: Awaited<ReturnType<OpsTickDb['missingDefinitions']>>['missing'],
  problem: (kind: OpsTickProblemKind, text: string, subject?: string) => void, counts: Record<string, number>,
): Promise<boolean> {
  let served: ReturnType<typeof parseServedOpsDefinitions>
  try {
    served = parseServedOpsDefinitions(
      await ports.gateway.fetchDefinitions({ versions: missing.map((m) => ({ workflow_id: m.workflowId, version_number: m.versionNumber })) }),
      missing,
    )
  } catch (err) {
    problem('definitions_failed', `The ops tick could not copy the definitions of the workflow versions it does not hold yet (${formatErr(err)}); it asks again next minute.`)
    return false
  }
  for (const r of served.refused) problem('definition_refused', r.text, r.workflowId ?? undefined)
  for (const u of served.unserved) {
    problem('definition_unserved', `The bidding Worker holds no ops lane version ${u.versionNumber} of workflow ${u.workflowId}, which the ops copy names, so no run can execute it.`, u.workflowId)
  }
  for (const def of served.definitions) {
    const want = missing.find((m) => m.workflowId === def.workflowId && m.versionNumber === def.versionNumber)
    if (want === undefined) continue
    if (def.organizationId !== want.organizationId) {
      problem('definition_refused', `The bidding Worker served version ${def.versionNumber} of workflow ${def.workflowId} under another organization than its ops copy, so it was not saved.`, def.workflowId)
      continue
    }
    try {
      const outcome = await db.saveDefinition(want.organizationId, def.workflowId, def.versionNumber, def.definition)
      if (outcome === 'saved') bump(counts, 'definitions_saved')
      else if (outcome === 'already_saved') bump(counts, 'definitions_already_saved')
      else if (outcome === 'no_copy') bump(counts, 'definitions_no_copy')
      else {
        problem('definition_conflict', `Version ${def.versionNumber} of workflow ${def.workflowId} as the bidding Worker serves it now differs from the copy ops froze, so a saved version changed; ops keeps its copy and a person must decide which is right.`, def.workflowId)
      }
    } catch (err) {
      problem('definition_save_failed', `The ops tick could not save version ${def.versionNumber} of workflow ${def.workflowId} (${formatErr(err)}); it asks again next minute.`, def.workflowId)
    }
  }
  return true
}

/** The last slot a schedule served: observed (observe mode), or the later of fired and observed (live). */
function lastServedMs(c: WorkflowCopy, live: boolean): number | null {
  const observed = c.lastObserved === null ? null : Date.parse(c.lastObserved)
  if (!live) return observed
  const fired = c.lastServed === null ? null : Date.parse(c.lastServed)
  if (observed === null) return fired
  if (fired === null) return observed
  return Math.max(observed, fired)
}

/**
 * How one claimed run ended, as the tick counts it (L77): lost covers a lost
 * claim, a start or complete that failed and a dispatch that failed (each
 * leaves the run to the lease sweep); requeued a retry or a wait; ended a run
 * of a workflow switched off or deleted, ended without running.
 */
export type RunTally = 'done' | 'lost' | 'unknown' | 'requeued' | 'failed' | 'ended'

function tallyOf(report: RunInvocationReport): RunTally {
  if (report.outcome !== 'completed') return 'lost'
  switch (report.end.outcome) {
    case 'done': return 'done'
    case 'retry':
    case 'suspend': return 'requeued'
    case 'needs_human': return report.end.reason === 'send_outcome_unknown' ? 'unknown' : 'lost'
    case 'failed':
    case 'dead': return 'failed'
  }
}

/**
 * One claimed run, in its own boundary (L73: a throw here never stops a
 * sibling). A run of a workflow its copy says is deleted or switched off, or
 * that no copy names, is ended dead without running (the claim re-checks the
 * workflow, #1698 1.3); any other is handed to OpsInternal.run and awaited.
 */
async function dispatchOneRun(ports: OpsTickPorts, db: OpsTickDb | null, copies: readonly WorkflowCopy[], run: ClaimedRun): Promise<{ workflowId: string; tally: RunTally; error?: string }> {
  const copy = copies.find((c) => c.workflowId === run.workflowId)
  try {
    if (copy === undefined || copy.deletedAt !== null || copy.withdrawnAt !== null || !copy.mayStart) {
      const reason = copy === undefined || copy.deletedAt !== null || copy.withdrawnAt !== null ? 'workflow_deleted' : 'workflow_inactive'
      if (db === null) throw new Error('no ops database to end the run in')
      await db.completeRun(run, { outcome: 'dead', reason })
      return { workflowId: run.workflowId, tally: 'ended' }
    }
    return { workflowId: run.workflowId, tally: tallyOf(await ports.dispatchRun(run)) }
  } catch (err) {
    return { workflowId: run.workflowId, tally: 'lost', error: formatErr(err) }
  }
}

/**
 * The runs' outcomes counted against a rate, per workflow (L77, #1950). Every
 * unknown send pages at once: the run waits for a person. Lost and requeued runs
 * page, held for three ticks, once they reach RUN_OUTCOME_FAILING_RATE of at
 * least RUN_OUTCOME_MIN_RUNS runs of one workflow in the tick.
 */
function judgeRunOutcomes(
  results: ReadonlyArray<{ workflowId: string; tally: RunTally; error?: string }>,
  problem: (kind: OpsTickProblemKind, text: string, subject?: string) => void,
  counts: Record<string, number>,
): void {
  const byWorkflow = new Map<string, Record<RunTally, number> & { runs: number; errors: string[] }>()
  for (const r of results) {
    bump(counts, `runs_${r.tally}`)
    const w = byWorkflow.get(r.workflowId) ?? { runs: 0, done: 0, lost: 0, unknown: 0, requeued: 0, failed: 0, ended: 0, errors: [] }
    w.runs++
    w[r.tally]++
    if (r.error) w.errors.push(r.error)
    byWorkflow.set(r.workflowId, w)
  }
  for (const [workflowId, w] of byWorkflow) {
    if (w.unknown > 0) {
      problem('run_outcome_unknown', `${w.unknown} ${w.unknown === 1 ? 'run' : 'runs'} of workflow ${workflowId} made a send whose outcome is unknown (no answer, a dropped connection, or a 503 to a send that cannot be repeated), so ${w.unknown === 1 ? 'it waits' : 'they wait'} for a person (needs_human, send_outcome_unknown).`, workflowId)
    }
    const failing = w.lost + w.requeued
    if (w.runs >= RUN_OUTCOME_MIN_RUNS && failing / w.runs >= RUN_OUTCOME_FAILING_RATE) {
      const first = w.errors[0] ? ` The first error: ${w.errors[0]}.` : ''
      problem('runs_failing', `${failing} of the ${w.runs} runs of workflow ${workflowId} this tick were lost (${w.lost}) or requeued (${w.requeued}).${first}`, workflowId)
    }
  }
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
  /** Each sweep whose claim this tick owned, for the report (#2340: the bidding Worker judges a sweep's problems by its runs). */
  const sweepsRun: TickSweep[] = []
  let connectionCheckRun: Promise<ConnectionCheckSweepResult> | null = null
  let connectionLogins: ConnectionLoginsReport | null = null
  let writeBacksRun: Promise<WriteBacksRun> | null = null

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
      // A sweep held to an Eastern hour is claimed only in it, read on the database
      // clock; with no clock its hour is unknown, so it waits for a tick that has one.
      if (s.easternHour !== undefined && (dbNow === null || Math.floor(easternParts(Date.parse(dbNow)).minuteOfDay / 60) !== s.easternHour)) continue
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
        sweepsRun.push(s.sweep)
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
              // Each kind of lapse counted apart (L77): the runs lost to a lease expiry.
              if (r.requeued > 0) bump(counts, 'leases_lapsed_requeued', r.requeued)
              if (r.retried > 0) bump(counts, 'leases_lapsed_retried', r.retried)
              if (r.needsHuman > 0) bump(counts, 'leases_lapsed_needs_human', r.needsHuman)
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
            case 'observation_purge': {
              // Three purges in one sweep, each run whatever the others did, so a
              // failing one never keeps another's rows past their time: the
              // observations (30 days), the step test results (7 days, #2339,
              // Dan's decision of 2026-10-23) and the step records of runs (7
              // days, #2703, Dan's decision of 2026-10-24). A failure of any is the sweep's.
              let more = false
              let failure: { error: unknown } | null = null
              const purges: Array<[() => Promise<{ purged: number; more: boolean }>, string]> = [
                [() => db.purgeObservations(s.pageLimit), 'observations_purged'],
                [() => db.purgeStepTests(s.pageLimit), 'step_tests_purged'],
                [() => db.purgeStepRecords(s.pageLimit), 'step_records_purged'],
              ]
              for (const [purge, count] of purges) {
                try {
                  const r = await purge()
                  bump(counts, count, r.purged)
                  more ||= r.more
                } catch (error) {
                  failure ??= { error }
                }
              }
              if (failure) throw failure.error
              return more
            }
          }
        })
      } catch (err) {
        if (s.sweep === 'queue_agreement') problem('agreement_check_failed', `The ${s.sweep} sweep failed: ${formatErr(err)}.`)
        else problem('sweep_failed', `The ${s.sweep} sweep failed: ${formatErr(err)}.`, s.sweep)
      }
    }

    // A run whose lease lapsed after a send not declared idempotent waits for a
    // person (lease_expired_after_send): paged at once, since nothing retries it.
    const lapsedAfterSend = counts.leases_lapsed_needs_human ?? 0
    if (lapsedAfterSend > 0) {
      problem('runs_lapsed_after_send', `${lapsedAfterSend} ops ${lapsedAfterSend === 1 ? 'run' : 'runs'} lost ${lapsedAfterSend === 1 ? 'its' : 'their'} lease after a send that cannot safely be repeated, so ${lapsedAfterSend === 1 ? 'it waits' : 'they wait'} for a person (needs_human, lease_expired_after_send).`)
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
  /** The copies were read: a claimed run is judged against them, so with none read nothing is claimed. */
  let copiesRead = false
  if (db) {
    try {
      const read = await db.readCopies(COPIES_READ_LIMIT)
      copies = read.copies
      copiesRead = true
      if (read.reachedLimit) problem('copies_read_limit', `The ops tick read ${COPIES_READ_LIMIT} workflow copies, its limit, so any past it were not planned.`)
    } catch (err) {
      problem('copies_read_failed', `The ops tick could not read the saved workflow copies (${formatErr(err)}), so it planned no fires.`)
    }
  }
  if (fetchError !== null) {
    if (copies.length > 0) {
      bump(counts, 'copies_used_saved')
      // A withdrawn copy is confirmed by no list, so its age says nothing about the others.
      const named = copies.filter((c) => c.withdrawnAt === null)
      const oldest = Math.min(...(named.length > 0 ? named : copies).map((c) => Date.parse(c.confirmedAt)))
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
      const listed = await db.connectionCheckTargets(CONNECTION_LOGINS_READ_LIMIT)
      connectionLogins = judgeConnectionLogins(listed)
      // 4d. The write backs (#2340 phase 10 item 4), only on the tick that owns
      // the connection_check claim, so each object is asked once an interval,
      // never every minute; beside the rest of the tick, awaited before the report.
      if (connectionCheckRun !== null) writeBacksRun = startWriteBacks(ports, listed)
      bump(counts, 'connection_logins_due', connectionLogins.logins.length)
      if (!connectionLogins.complete) {
        problem('connection_logins_limit', `The ops tick read more ops connections, or found more logins to page about, than one report carries (${CONNECTION_LOGINS_READ_LIMIT} connections, ${connectionLogins.logins.length} logins), so a login past them was not judged and no all clear is sent for it.`)
      }
    } catch (err) {
      problem('connection_logins_failed', `The ops tick could not read the ops connections' login states (${formatErr(err)}), so no login was judged this minute.`)
      if (connectionCheckRun !== null) {
        problem('write_back_check_failed', `The ops tick could not read the ops connections (${formatErr(err)}) on the minute it owns the connection check, so whether a new login of a person bound connection is waiting to be saved back to Bidspoke was not judged; it is asked again with the next connection check.`)
      }
    }
  }

  // 4e. The frozen definition copies (#1950), their own boundary, in every mode,
  // so the path is proven before live runs need it (L142).
  if (db) await copyDefinitions(ports, db, problem, counts)

  // 4f. In live mode, copies last confirmed more than 6 hours ago start nothing
  // (Dan, 2026-10-22): no fire, no claim, and a page. One served list confirms
  // every copy it names, so the oldest stands for them all; a withdrawn copy is
  // in no list, so nothing confirms it again, and it may start nothing anyway.
  const live = ports.mode === 'live'
  let liveHeld = false
  const confirmable = copies.filter((c) => c.withdrawnAt === null)
  if (live && dbNow !== null && confirmable.length > 0) {
    const oldest = Math.min(...confirmable.map((c) => Date.parse(c.confirmedAt)))
    if (!(Date.parse(dbNow) - oldest <= COPIES_STALE_AFTER_MS)) {
      liveHeld = true
      problem('copies_stale', `The saved ops workflow copies were last confirmed ${slotLabel(oldest)}, more than 6 hours ago, so the tick fired no schedule and started no run; they start again once the bidding Worker serves the workflows.`)
    }
  }

  // 5. The schedules, each its own boundary.
  if (dbNow !== null && db && !liveHeld) {
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
          // Observe mode serves nothing, so what it observed is what it would have
          // served. Live mode serves from the later of its last real fire and its
          // last observed slot, so going live never re-fires a slot observe passed.
          lastServedMs: lastServedMs(c, live),
        })
        for (const fire of plan.fires) {
          if (live) {
            // The schedule's overlap rule is the run engine's own vocabulary (OverlapRule): a type check, not a cast.
            const overlap: OverlapRule = config.overlap
            const fired = await db.recordFire(c.organizationId, {
              workflowId: c.workflowId, workflowVersion: c.versionNumber, scheduledFor: new Date(fire.scheduled_for),
              previousScheduledFor: fire.previous_scheduled_for === null ? null : new Date(fire.previous_scheduled_for),
              overlap,
              // A fixed per workflow jitter (#1698 D7) holds the run back until its dispatch time.
              ...(fire.dispatch_at > fire.scheduled_for ? { notBefore: new Date(fire.dispatch_at) } : {}),
            })
            bump(counts, `fires_${fired.outcome}`)
            continue
          }
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

  // 6. The claim: observed (what a claim would find), or in live mode taken.
  let claimed: ClaimedRun[] = []
  if (db && !live) {
    try {
      const depth = await db.dueQueueDepth()
      bump(counts, 'due_runs', depth.dueRuns)
      bump(counts, 'would_claim', Math.min(depth.dueRuns, TICK_CLAIM_LIMIT, depth.dueWorkflows * TICK_CLAIM_PER_WORKFLOW))
    } catch (err) {
      problem('claim_depth_failed', `The ops tick could not read what a claim would find: ${formatErr(err)}.`)
    }
  } else if (db && live && !liveHeld && dbNow !== null && copiesRead) {
    try {
      claimed = await db.claimRuns({ worker: ports.tickId, limit: TICK_CLAIM_LIMIT, perWorkflow: TICK_CLAIM_PER_WORKFLOW, leaseSeconds: RUN_LEASE_SECONDS })
      if (claimed.length > 0) bump(counts, 'runs_claimed', claimed.length)
    } catch (err) {
      problem('claim_failed', `The ops tick could not claim runs (${formatErr(err)}); every queued run waits for the next tick.`)
    }
  }

  // 7. Dispatch, each its own boundary, all awaited: the runs (live), the observed
  // fires, and with neither, one probe so the path is proven every minute.
  const runsDone = Promise.all(claimed.map((run) => dispatchOneRun(ports, db, copies, run)))
  const toSend: DispatchItem[] = items.length > 0 ? items : claimed.length > 0 ? [] : [{ kind: 'probe' }]
  const sent = await Promise.allSettled(toSend.map((item) => ports.dispatch(item)))
  judgeRunOutcomes(await runsDone, problem, counts)
  sent.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      bump(counts, 'dispatched')
      return
    }
    bump(counts, 'dispatch_failed')
    const item = toSend[i]
    if (item.kind === 'probe') problem('probe_failed', `The probe through the dispatch path failed: ${formatErr(r.reason)}.`)
    else if (item.kind === 'would_fire') problem('dispatch_failed', `The dispatch of workflow ${item.workflowId}'s ${slotLabel(Date.parse(item.scheduledFor))} slot failed: ${formatErr(r.reason)}.`, item.workflowId)
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

  // 7d. The write back check, if this tick owns the connection check, the same way.
  let writeBacks: WriteBacksReport | null = null
  if (writeBacksRun !== null) {
    const wb = await writeBacksRun
    writeBacks = wb.report
    problems.push(...wb.problems)
    for (const [key, n] of Object.entries(wb.counts)) bump(counts, key, n)
  }

  // 8. Completed.
  const outcome: OpsTickOutcome = notConfigured ? 'not_configured' : problems.length > 0 ? 'problems' : 'ok'
  const capped = capTickProblems(problems)
  const report: OpsTickReport = {
    tick_id: ports.tickId,
    mode: ports.mode,
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
    write_backs: writeBacks,
    sweeps_run: sweepsRun,
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
