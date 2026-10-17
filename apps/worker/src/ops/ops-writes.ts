/**
 * The ops write choke point, Worker side (#1948, track B1 of #1698).
 *
 * Every write to the ops database is one of its SECURITY DEFINER functions
 * (supabase-ops/supabase/migrations/20261016200000_run_engine_1948.sql), and the
 * database enforces that: service_role holds only SELECT on the run engine's
 * tables, so an insert, update or delete from here is refused there whatever
 * this code does. This module is the Worker's half:
 *
 *  - callOpsRpc is the ONE `.rpc(` on the ops client.
 *    apps/web/src/lib/__guards__/worker/ops-reads-through-helper.test.ts fails on
 *    any other `.rpc(`, `.from(` or `.schema(` against it, as it already did for
 *    reads outside readOpsRows;
 *  - it refuses a function not classified in ops-rpcs.ts, and an organization
 *    scoped call whose organization is not a uuid (L18: the functions match the
 *    organization they are given, so it must be the right one);
 *  - it gives every call a deadline (L110). PostgREST requests on the ops project
 *    stop at the authenticator's 8 s statement timeout (docs/ops-ceilings-spike.md
 *    P8), so the default deadline is just past it: a statement still running is
 *    cancelled, and rolled back, by the database first. A deadline that does fire
 *    is reported as possibly committed, never as not done, because a call that
 *    timed out may still have landed;
 *  - each typed wrapper checks the shape of what came back and throws by name on
 *    anything else, rather than handing a caller undefined fields.
 *
 * Every write is safe to repeat (assume it runs twice): enqueue answers a repeat
 * as a duplicate, start and complete recognise their own earlier success, an
 * intent repeat returns the same ledger row, and the claim's only cost when its
 * answer is lost is a lease that lapses and is swept.
 *
 * The minute cron (#1949, tick.ts) calls the sweeps, the copies, the observation
 * and the clock; run invocation (#1950) calls the rest.
 *
 * The ops connections' and Salesforce pool's wrappers (#2334, supabase-ops
 * migration 20261017220000) are at the end. Nothing calls them in the deploy
 * that adds them: the OpsConnections entrypoint, connectionFetch and the tick's
 * new sweeps (Phases 5, 6 and 10 of #1689) are their callers.
 */
import {
  CONNECTION_COPY_STATES, LEDGER_METHODS, OBSERVATION_OUTCOMES, OBSERVATION_REASONS, OPS_SWEEPS, OVERLAP_RULES, SF_BUDGET_SOURCES,
  SF_LEASE_OUTCOMES, SF_LEASE_PURPOSES, TRIGGER_KINDS,
  type ConnectionCopyState, type LedgerMethod, type ObservationOutcome, type OpsSweep, type OverlapRule, type SfBudgetSource,
  type SfLeaseOutcome, type SfLeasePurpose, type TriggerKind,
} from './run-vocabulary'
import {
  OPS_LANE_READ_ONLY_RPCS, OPS_LANE_RPCS, OPS_MUTATING_RPCS, OPS_ORGANIZATION_READ_ONLY_RPCS, OPS_ORGANIZATION_RPCS, OPS_READ_ONLY_RPCS,
  type OpsRpcName,
} from './ops-rpcs'
import { organizationIdFrom, type OpsSupabaseClient, type OrganizationId } from './ops-db'

/** Past the ops project's 8 s statement timeout, so the database gives up first. */
export const OPS_RPC_DEADLINE_MS = 9_000

/** A refused or failed ops write. Carries the function and the database's code, never a row. */
export class OpsWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsWriteError'
  }
}

/** The call passed its deadline. It may still have committed, so the caller must not assume it did nothing. */
export class OpsWriteTimeoutError extends OpsWriteError {
  constructor(message: string) {
    super(message)
    this.name = 'OpsWriteTimeoutError'
  }
}

/** The run is not held by this claim any more (another holder, or swept): stop, and send nothing. */
export class OpsClaimLostError extends OpsWriteError {
  constructor(message: string) {
    super(message)
    this.name = 'OpsClaimLostError'
  }
}

const KNOWN: ReadonlySet<string> = new Set<string>([...OPS_MUTATING_RPCS, ...OPS_READ_ONLY_RPCS])
const ORGANIZATION_SCOPED: ReadonlySet<string> = new Set<string>([...OPS_ORGANIZATION_RPCS, ...OPS_ORGANIZATION_READ_ONLY_RPCS])
const LANE_WIDE: ReadonlySet<string> = new Set<string>([...OPS_LANE_RPCS, ...OPS_LANE_READ_ONLY_RPCS])

export interface OpsRpcOptions {
  /** Defaults to OPS_RPC_DEADLINE_MS. */
  deadlineMs?: number
}

/**
 * The only call of an ops database function. Throws OpsWriteError on a database
 * error, OpsWriteTimeoutError past the deadline, and refuses an unlisted name or
 * an organization scoped call without a valid organization before sending.
 */
export async function callOpsRpc(
  client: OpsSupabaseClient,
  name: OpsRpcName,
  args: Record<string, unknown>,
  options: OpsRpcOptions = {},
): Promise<unknown> {
  if (!KNOWN.has(name)) throw new OpsWriteError(`${String(name)} is not an ops database function classified in ops-rpcs.ts`)
  if (ORGANIZATION_SCOPED.has(name)) {
    try {
      organizationIdFrom(args.p_organization_id)
    } catch {
      throw new OpsWriteError(`${name} acts within one organization, and its p_organization_id is not a uuid`)
    }
  } else if (LANE_WIDE.has(name) && 'p_organization_id' in args) {
    throw new OpsWriteError(`${name} is lane wide and takes no organization`)
  }

  const deadlineMs = options.deadlineMs ?? OPS_RPC_DEADLINE_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  try {
    const response = await client.rpc(name, args).abortSignal(controller.signal)
    const data: unknown = response.data
    const error = response.error
    if (controller.signal.aborted) {
      throw new OpsWriteTimeoutError(`${name} passed its ${deadlineMs} ms deadline and may still have committed`)
    }
    if (error) throw new OpsWriteError(`${name} failed (${error.code ?? 'no code'}): ${error.message}`)
    return data
  } catch (err) {
    if (err instanceof OpsWriteError) throw err
    if (controller.signal.aborted) {
      throw new OpsWriteTimeoutError(`${name} passed its ${deadlineMs} ms deadline and may still have committed`)
    }
    throw new OpsWriteError(`${name} could not be called: ${err instanceof Error ? err.message : 'unknown error'}`)
  } finally {
    clearTimeout(timer)
  }
}

// ── result checking ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function rows(name: string, data: unknown): Row[] {
  if (!Array.isArray(data) || data.some((r) => typeof r !== 'object' || r === null)) {
    throw new OpsWriteError(`${name} returned something other than rows`)
  }
  return data as Row[]
}

function oneRow(name: string, data: unknown): Row {
  const all = rows(name, data)
  if (all.length !== 1) throw new OpsWriteError(`${name} returned ${all.length} rows, expected 1`)
  return all[0]
}

function field<T>(name: string, row: Row, key: string, ok: (v: unknown) => v is T, what: string): T {
  const v = row[key]
  if (!ok(v)) throw new OpsWriteError(`${name} returned ${key} that is not ${what}`)
  return v
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v)
const iso = (d: Date | undefined) => (d === undefined ? undefined : d.toISOString())

/** A run status, or 'purged' for a duplicate whose row is gone. One this Worker does not know is kept as text, never thrown (#1698 R3). */
function runStatus(name: string, row: Row, key: string): string | null {
  return field(name, row, key, isStringOrNull, 'text or null')
}

function withoutUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
}

// ── enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueRunRequest {
  workflowId: string
  workflowVersion: number
  triggerKind: TriggerKind
  /** One attempt of the caller's: the Idempotency-Key header, or a fresh id (#1698 R18). */
  dedupKey: string
  payload?: unknown
  payloadRef?: string
  notBefore?: Date
  expiresAt?: Date
  maxAttempts?: number
  overlap?: OverlapRule
  concurrencyLimit?: number
  /** A UUIDv7 minted by the caller (packages/uuidv7), so a retried enqueue can carry the same id. */
  id?: string
}

export interface EnqueueResult {
  outcome: 'inserted' | 'skipped' | 'duplicate' | 'neither'
  runRequestId: string | null
  runStatus: string | null
}

export async function enqueueRunRequest(client: OpsSupabaseClient, organizationId: OrganizationId, run: EnqueueRunRequest, options?: OpsRpcOptions): Promise<EnqueueResult> {
  if (!(TRIGGER_KINDS as readonly string[]).includes(run.triggerKind)) throw new OpsWriteError(`enqueue_run_request: ${run.triggerKind} is not a trigger kind`)
  if (run.overlap !== undefined && !(OVERLAP_RULES as readonly string[]).includes(run.overlap)) throw new OpsWriteError(`enqueue_run_request: ${run.overlap} is not an overlap rule`)
  const name = 'enqueue_run_request'
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId,
    p_workflow_id: run.workflowId,
    p_workflow_version: run.workflowVersion,
    p_trigger_kind: run.triggerKind,
    p_dedup_key: run.dedupKey,
    p_payload: run.payload,
    p_payload_ref: run.payloadRef,
    p_not_before: iso(run.notBefore),
    p_expires_at: iso(run.expiresAt),
    p_max_attempts: run.maxAttempts,
    p_overlap: run.overlap,
    p_concurrency_limit: run.concurrencyLimit,
    p_id: run.id,
  }), options))
  return {
    outcome: field(name, row, 'outcome', oneOf(['inserted', 'skipped', 'duplicate', 'neither'] as const), 'an enqueue outcome'),
    runRequestId: field(name, row, 'run_request_id', isStringOrNull, 'an id or null'),
    runStatus: runStatus(name, row, 'run_status'),
  }
}

// ── claim ───────────────────────────────────────────────────────────────────

export interface ClaimRunRequests {
  /** Names the tick, recorded on each claimed run. */
  worker: string
  /** 1 to 1000. */
  limit: number
  /** k, the most of any one workflow in this call (#1698 D1). */
  perWorkflow: number
  /** 10 to 300; renewed by extendRunLease. */
  leaseSeconds: number
}

export interface ClaimedRun {
  runRequestId: string
  organizationId: OrganizationId
  workflowId: string
  workflowVersion: number
  triggerKind: string
  claimToken: string
  claimExpiresAt: string
  stateVersion: number
  attempts: number
  maxAttempts: number
  resumeReason: string | null
  executionChainId: string
  resumedFromExecutionId: string | null
  payload: unknown
  payloadRef: string | null
}

export async function claimRunRequests(client: OpsSupabaseClient, claim: ClaimRunRequests, options?: OpsRpcOptions): Promise<ClaimedRun[]> {
  const name = 'claim_run_requests'
  const data = await callOpsRpc(client, name, {
    p_worker: claim.worker,
    p_limit: claim.limit,
    p_per_workflow: claim.perWorkflow,
    p_lease_seconds: claim.leaseSeconds,
  }, options)
  return rows(name, data).map((row) => {
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a run whose organization is not a uuid`)
    }
    return {
      runRequestId: field(name, row, 'run_request_id', isString, 'an id'),
      organizationId,
      workflowId: field(name, row, 'workflow_id', isString, 'an id'),
      workflowVersion: field(name, row, 'workflow_version', isInt, 'a whole number'),
      triggerKind: field(name, row, 'trigger_kind', isString, 'text'),
      claimToken: field(name, row, 'claim_token', isString, 'a token'),
      claimExpiresAt: field(name, row, 'claim_expires_at', isString, 'a time'),
      stateVersion: field(name, row, 'state_version', isInt, 'a whole number'),
      attempts: field(name, row, 'attempts', isInt, 'a whole number'),
      maxAttempts: field(name, row, 'max_attempts', isInt, 'a whole number'),
      resumeReason: field(name, row, 'resume_reason', isStringOrNull, 'text or null'),
      executionChainId: field(name, row, 'execution_chain_id', isString, 'an id'),
      resumedFromExecutionId: field(name, row, 'resumed_from_execution_id', isStringOrNull, 'an id or null'),
      payload: row.payload ?? null,
      payloadRef: field(name, row, 'payload_ref', isStringOrNull, 'text or null'),
    }
  })
}

// ── start, extend, complete ─────────────────────────────────────────────────

export interface StartedRun {
  outcome: 'started' | 'already_started'
  /** The version every send intent of this attempt is fenced with. */
  stateVersion: number
  attempt: number
}

/** Throws OpsClaimLostError when the claim is no longer this caller's. */
export async function startRunExecution(
  client: OpsSupabaseClient, organizationId: OrganizationId, runRequestId: string, claimToken: string, executionId: string, options?: OpsRpcOptions,
): Promise<StartedRun> {
  const name = 'start_run_execution'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: runRequestId, p_claim_token: claimToken, p_execution_id: executionId,
  }, options))
  const outcome = field(name, row, 'outcome', oneOf(['started', 'already_started', 'claim_lost'] as const), 'a start outcome')
  if (outcome === 'claim_lost') throw new OpsClaimLostError(`${name}: run ${runRequestId} is not held by this claim`)
  return { outcome, stateVersion: field(name, row, 'state_version', isInt, 'a whole number'), attempt: field(name, row, 'attempt', isInt, 'a whole number') }
}

/** False means the claim was lost: stop before the next send (#1698 D3). */
export async function extendRunLease(
  client: OpsSupabaseClient, organizationId: OrganizationId, runRequestId: string, claimToken: string, leaseSeconds: number, options?: OpsRpcOptions,
): Promise<boolean> {
  const name = 'extend_run_lease'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: runRequestId, p_claim_token: claimToken, p_lease_seconds: leaseSeconds,
  }, options)
  if (!isBool(data)) throw new OpsWriteError(`${name} returned something other than true or false`)
  return data
}

export type CompleteOutcome =
  | { outcome: 'done' }
  | { outcome: 'failed'; reason?: 'max_compute_exceeded' | 'max_steps_exceeded' | 'max_state_exceeded'; error?: string }
  | { outcome: 'retry'; error?: string; notBefore?: Date }
  | { outcome: 'suspend'; reason: 'continue' | 'wake'; notBefore: Date }
  | { outcome: 'needs_human'; reason: 'lease_expired_after_send' | 'send_outcome_unknown'; error?: string }
  | { outcome: 'dead'; reason: 'workflow_inactive' | 'workflow_deleted' | 'halted_by_rule' }

export interface CompletedRun {
  outcome: 'completed' | 'already_completed'
  runStatus: string | null
}

/**
 * Ends the claim. The database answers one row whatever happens; a run that is
 * not this claim's (claim_lost, or not_found in this organization) throws
 * OpsClaimLostError, the error #1698 1.3 asks for where it says zero rows.
 */
export async function completeRunRequest(
  client: OpsSupabaseClient, organizationId: OrganizationId, runRequestId: string, claimToken: string, end: CompleteOutcome, options?: OpsRpcOptions,
): Promise<CompletedRun> {
  const name = 'complete_run_request'
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId,
    p_run_request_id: runRequestId,
    p_claim_token: claimToken,
    p_outcome: end.outcome,
    p_reason: 'reason' in end ? end.reason : undefined,
    p_error: 'error' in end ? end.error : undefined,
    p_not_before: 'notBefore' in end ? iso(end.notBefore) : undefined,
  }), options))
  const outcome = field(name, row, 'outcome', oneOf(['completed', 'already_completed', 'claim_lost', 'not_found'] as const), 'a complete outcome')
  if (outcome === 'claim_lost' || outcome === 'not_found') {
    throw new OpsClaimLostError(`${name}: run ${runRequestId} is not held by this claim (${outcome})`)
  }
  return { outcome, runStatus: runStatus(name, row, 'run_status') }
}

// ── sweeps and purges (lane wide) ───────────────────────────────────────────

export interface SweepResult {
  requeued: number
  retried: number
  needsHuman: number
  dead: number
  /** A full page was taken: call again until false. */
  more: boolean
}

export async function sweepExpiredLeases(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<SweepResult> {
  const name = 'sweep_expired_leases'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return {
    requeued: field(name, row, 'requeued', isInt, 'a count'),
    retried: field(name, row, 'retried', isInt, 'a count'),
    needsHuman: field(name, row, 'needs_human', isInt, 'a count'),
    dead: field(name, row, 'dead', isInt, 'a count'),
    more: field(name, row, 'more', isBool, 'true or false'),
  }
}

export async function expireOverdueRunRequests(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ expired: number; more: boolean }> {
  const name = 'expire_overdue_run_requests'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { expired: field(name, row, 'expired', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

/** Nothing schedules this: how long runs are kept is Dan's decision (#1945 decision 1). */
export async function purgeTerminalRunRequests(
  client: OpsSupabaseClient, terminalBefore: Date, limit: number, options?: OpsRpcOptions,
): Promise<{ purged: number; tombstoned: number; more: boolean }> {
  const name = 'purge_terminal_run_requests'
  const row = oneRow(name, await callOpsRpc(client, name, { p_terminal_before: terminalBefore.toISOString(), p_limit: limit }, options))
  return {
    purged: field(name, row, 'purged', isInt, 'a count'),
    tombstoned: field(name, row, 'tombstoned', isInt, 'a count'),
    more: field(name, row, 'more', isBool, 'true or false'),
  }
}

export async function purgeExpiredDedupTombstones(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_expired_dedup_tombstones'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

// ── the send ledger ─────────────────────────────────────────────────────────

export interface SendIntent {
  runRequestId: string
  claimToken: string
  /** The version startRunExecution returned. */
  stateVersion: number
  nodeId: string
  seq: number
  method: LedgerMethod
  host: string
  /** The node declared an attempt scoped key the partner honours. */
  idempotent: boolean
  attemptKey?: string
}

export interface SendIntentResult {
  /** stale: this caller no longer holds the run at its version, and must not send. */
  outcome: 'recorded' | 'duplicate' | 'stale'
  ledgerId: string | null
  ledgerStatus: string | null
}

/** Written BEFORE the send (L33). Send only on recorded, or on a duplicate whose status is still intent. */
export async function recordSendIntent(client: OpsSupabaseClient, organizationId: OrganizationId, intent: SendIntent, options?: OpsRpcOptions): Promise<SendIntentResult> {
  if (!(LEDGER_METHODS as readonly string[]).includes(intent.method)) throw new OpsWriteError(`record_send_intent: ${intent.method} is not a ledger method`)
  const name = 'record_send_intent'
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId,
    p_run_request_id: intent.runRequestId,
    p_claim_token: intent.claimToken,
    p_state_version: intent.stateVersion,
    p_node_id: intent.nodeId,
    p_seq: intent.seq,
    p_method: intent.method,
    p_host: intent.host,
    p_idempotent: intent.idempotent,
    p_attempt_key: intent.attemptKey,
  }), options))
  return {
    outcome: field(name, row, 'outcome', oneOf(['recorded', 'duplicate', 'stale'] as const), 'an intent outcome'),
    ledgerId: field(name, row, 'ledger_id', isStringOrNull, 'an id or null'),
    ledgerStatus: field(name, row, 'ledger_status', isStringOrNull, 'text or null'),
  }
}

export async function recordSendResult(
  client: OpsSupabaseClient,
  organizationId: OrganizationId,
  ledgerId: string,
  result: { status: 'forwarded' | 'failed'; responseStatus?: number; responseRef?: string },
  options?: OpsRpcOptions,
): Promise<'recorded' | 'already_recorded' | 'not_found'> {
  const name = 'record_send_result'
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId, p_ledger_id: ledgerId, p_status: result.status,
    p_response_status: result.responseStatus, p_response_ref: result.responseRef,
  }), options))
  return field(name, row, 'outcome', oneOf(['recorded', 'already_recorded', 'not_found'] as const), 'a result outcome')
}

// ── schedule fires ──────────────────────────────────────────────────────────

export interface ScheduleFire {
  workflowId: string
  workflowVersion: number
  scheduledFor: Date
  previousScheduledFor: Date | null
  overlap?: OverlapRule
  concurrencyLimit?: number
  notBefore?: Date
  expiresAt?: Date
  maxAttempts?: number
}

export interface ScheduleFireResult {
  outcome: 'enqueued' | 'skipped_overlap' | 'duplicate' | 'already_recorded'
  fireId: string | null
  runRequestId: string | null
  runStatus: string | null
}

export async function recordScheduleFire(client: OpsSupabaseClient, organizationId: OrganizationId, fire: ScheduleFire, options?: OpsRpcOptions): Promise<ScheduleFireResult> {
  const name = 'record_schedule_fire'
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId,
    p_workflow_id: fire.workflowId,
    p_workflow_version: fire.workflowVersion,
    p_scheduled_for: fire.scheduledFor.toISOString(),
    p_previous_scheduled_for: fire.previousScheduledFor === null ? null : fire.previousScheduledFor.toISOString(),
    p_overlap: fire.overlap,
    p_concurrency_limit: fire.concurrencyLimit,
    p_not_before: iso(fire.notBefore),
    p_expires_at: iso(fire.expiresAt),
    p_max_attempts: fire.maxAttempts,
  }), options))
  return {
    outcome: field(name, row, 'outcome', oneOf(['enqueued', 'skipped_overlap', 'duplicate', 'already_recorded'] as const), 'a fire outcome'),
    fireId: field(name, row, 'fire_id', isStringOrNull, 'an id or null'),
    runRequestId: field(name, row, 'run_request_id', isStringOrNull, 'an id or null'),
    runStatus: runStatus(name, row, 'run_status'),
  }
}

// ── keep (a person's action, audited in the database) ────────────────────────

export async function setRunRequestKept(
  client: OpsSupabaseClient,
  organizationId: OrganizationId,
  runRequestId: string,
  kept: boolean,
  actor: { id: string; email: string | null },
  options?: OpsRpcOptions,
): Promise<'changed' | 'unchanged' | 'not_found'> {
  const name = 'set_run_request_kept'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: runRequestId, p_kept: kept, p_actor_id: actor.id, p_actor_email: actor.email,
  }, options))
  return field(name, row, 'outcome', oneOf(['changed', 'unchanged', 'not_found'] as const), 'a keep outcome')
}

// ── the agreement check's read ──────────────────────────────────────────────

export interface QueueDisagreement {
  /** queue_row_without_waiting_run or waiting_run_without_queue_row; kept as text so a newer kind is shown, not thrown. */
  kind: string
  runRequestId: string
  organizationId: string
}

/** Every row is a defect to report: every write keeps the queue and the runs in one transaction. */
export async function runQueueDisagreements(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<QueueDisagreement[]> {
  const name = 'run_queue_disagreements'
  return rows(name, await callOpsRpc(client, name, { p_limit: limit }, options)).map((row) => ({
    kind: field(name, row, 'kind', isString, 'text'),
    runRequestId: field(name, row, 'run_request_id', isString, 'an id'),
    organizationId: field(name, row, 'organization_id', isString, 'an id'),
  }))
}

// ── the minute cron (#1949) ─────────────────────────────────────────────────

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const isTimeOrNull = (v: unknown): v is string | null => v === null || isTime(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isIntOrNull = (v: unknown): v is number | null => v === null || isInt(v)

/** The database's clock: every fire is computed against it, never the Worker's (#1698 D8, L736). */
export async function opsNow(client: OpsSupabaseClient, options?: OpsRpcOptions): Promise<string> {
  const name = 'ops_now'
  const data = await callOpsRpc(client, name, {}, options)
  if (!isTime(data)) throw new OpsWriteError(`${name} returned something other than a time`)
  return data
}

export interface SweepClaim {
  /** False is a stand down: another tick holds this sweep's interval. */
  owned: boolean
  lastStartedAt: string | null
  lastOwner: string | null
}

/** One owner per sweep interval (#1698 1.4): a try advisory lock, then a timestamp compare and set. */
export async function claimOpsSweep(
  client: OpsSupabaseClient, sweep: OpsSweep, owner: string, everySeconds: number, options?: OpsRpcOptions,
): Promise<SweepClaim> {
  if (!(OPS_SWEEPS as readonly string[]).includes(sweep)) throw new OpsWriteError(`claim_ops_sweep: ${sweep} is not a sweep`)
  const name = 'claim_ops_sweep'
  const row = oneRow(name, await callOpsRpc(client, name, { p_sweep: sweep, p_owner: owner, p_every_seconds: everySeconds }, options))
  return {
    owned: field(name, row, 'owned', isBool, 'true or false'),
    lastStartedAt: field(name, row, 'last_started_at', isTimeOrNull, 'a time or null'),
    lastOwner: field(name, row, 'last_owner', isStringOrNull, 'text or null'),
  }
}

/** One ops workflow's state as the bidding Worker served it (decision 4 on #1949). */
export interface WorkflowCopyInput {
  workflowId: string
  organizationId: string
  isActive: boolean
  deletedAt: string | null
  /** The bidding row's updated_at: the order no save may go back on. */
  rowUpdatedAt: string
  versionNumber: number | null
  trigger: unknown
}

export interface SaveCopiesResult {
  inserted: number
  updated: number
  confirmed: number
  /** Copies older than the one stored, refused: the fetch was the older of two. */
  refusedOlder: number
  withdrawn: number
}

/** The most copies one save carries; the database refuses more rather than truncating. */
export const MAX_COPIES_PER_SAVE = 1000

export async function saveWorkflowCopies(
  client: OpsSupabaseClient, servedAt: string, complete: boolean, copies: readonly WorkflowCopyInput[], options?: OpsRpcOptions,
): Promise<SaveCopiesResult> {
  if (copies.length > MAX_COPIES_PER_SAVE) throw new OpsWriteError(`save_workflow_copies: ${copies.length} copies is more than one save carries (${MAX_COPIES_PER_SAVE})`)
  const name = 'save_workflow_copies'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_served_at: servedAt,
    p_complete: complete,
    p_copies: copies.map((c) => ({
      workflow_id: c.workflowId,
      organization_id: c.organizationId,
      is_active: c.isActive,
      deleted_at: c.deletedAt,
      row_updated_at: c.rowUpdatedAt,
      version_number: c.versionNumber,
      trigger: c.trigger ?? null,
    })),
  }, options))
  return {
    inserted: field(name, row, 'inserted', isCount, 'a count'),
    updated: field(name, row, 'updated', isCount, 'a count'),
    confirmed: field(name, row, 'confirmed', isCount, 'a count'),
    refusedOlder: field(name, row, 'refused_older', isCount, 'a count'),
    withdrawn: field(name, row, 'withdrawn', isCount, 'a count'),
  }
}

/** A saved copy, with what a tick plans from. */
export interface WorkflowCopy {
  workflowId: string
  organizationId: OrganizationId
  isActive: boolean
  deletedAt: string | null
  withdrawnAt: string | null
  rowUpdatedAt: string
  versionNumber: number | null
  trigger: unknown
  scheduleKnownSince: string | null
  switchedOffAt: string | null
  /** When this database first held this copy, which is how old a copy used in an outage is. */
  receivedAt: string
  /** When a served list last named it. */
  confirmedAt: string
  /** On, not deleted, not withdrawn, and newer than the last known switch off: the one rule a run starts by. */
  mayStart: boolean
  lastServed: string | null
  lastObserved: string | null
  dbNow: string
}

export async function readWorkflowCopies(
  client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions,
): Promise<{ copies: WorkflowCopy[]; reachedLimit: boolean }> {
  const name = 'workflow_copies'
  const all = rows(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  const copies = all.map((row): WorkflowCopy => {
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a copy whose organization is not a uuid`)
    }
    return {
      workflowId: field(name, row, 'workflow_id', isString, 'an id'),
      organizationId,
      isActive: field(name, row, 'is_active', isBool, 'true or false'),
      deletedAt: field(name, row, 'deleted_at', isTimeOrNull, 'a time or null'),
      withdrawnAt: field(name, row, 'withdrawn_at', isTimeOrNull, 'a time or null'),
      rowUpdatedAt: field(name, row, 'row_updated_at', isTime, 'a time'),
      versionNumber: field(name, row, 'version_number', isIntOrNull, 'a whole number or null'),
      trigger: row.trigger ?? null,
      scheduleKnownSince: field(name, row, 'schedule_known_since', isTimeOrNull, 'a time or null'),
      switchedOffAt: field(name, row, 'switched_off_at', isTimeOrNull, 'a time or null'),
      receivedAt: field(name, row, 'received_at', isTime, 'a time'),
      confirmedAt: field(name, row, 'confirmed_at', isTime, 'a time'),
      mayStart: field(name, row, 'may_start', isBool, 'true or false'),
      lastServed: field(name, row, 'last_served', isTimeOrNull, 'a time or null'),
      lastObserved: field(name, row, 'last_observed', isTimeOrNull, 'a time or null'),
      dbNow: field(name, row, 'db_now', isTime, 'a time'),
    }
  })
  return { copies, reachedLimit: copies.length === limit }
}

export interface ScheduleObservation {
  workflowId: string
  workflowVersion: number
  scheduledFor: Date
  outcome: ObservationOutcome
  reason: string
  /** A fire's slot plus its jitter; null for a miss. */
  dispatchAt: Date | null
  previousScheduledFor: Date | null
  tickId: string
}

/** already_recorded: an overlapping or doubled tick got there first, so this one does not dispatch it. */
export async function recordScheduleObservation(
  client: OpsSupabaseClient, organizationId: OrganizationId, obs: ScheduleObservation, options?: OpsRpcOptions,
): Promise<'recorded' | 'already_recorded'> {
  if (!(OBSERVATION_OUTCOMES as readonly string[]).includes(obs.outcome)) throw new OpsWriteError(`record_schedule_observation: ${obs.outcome} is not an observation outcome`)
  if (!(OBSERVATION_REASONS[obs.outcome] as readonly string[]).includes(obs.reason)) {
    throw new OpsWriteError(`record_schedule_observation: ${obs.reason} is not a reason for ${obs.outcome}`)
  }
  const name = 'record_schedule_observation'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId,
    p_workflow_id: obs.workflowId,
    p_workflow_version: obs.workflowVersion,
    p_scheduled_for: obs.scheduledFor.toISOString(),
    p_outcome: obs.outcome,
    p_reason: obs.reason,
    p_dispatch_at: obs.dispatchAt === null ? null : obs.dispatchAt.toISOString(),
    p_previous_scheduled_for: obs.previousScheduledFor === null ? null : obs.previousScheduledFor.toISOString(),
    p_tick_id: obs.tickId,
  }, options))
  return field(name, row, 'outcome', oneOf(['recorded', 'already_recorded'] as const), 'an observation outcome')
}

/** What a claim would find now: observe mode records this in place of claiming. */
export async function dueQueueDepth(client: OpsSupabaseClient, options?: OpsRpcOptions): Promise<{ dueRuns: number; dueWorkflows: number; oldestDue: string | null }> {
  const name = 'due_queue_depth'
  const row = oneRow(name, await callOpsRpc(client, name, {}, options))
  return {
    dueRuns: field(name, row, 'due_runs', isCount, 'a count'),
    dueWorkflows: field(name, row, 'due_workflows', isCount, 'a count'),
    oldestDue: field(name, row, 'oldest_due', isTimeOrNull, 'a time or null'),
  }
}

// ── ops connections (#2334) ─────────────────────────────────────────────────

/**
 * How long a served copy may be used: Dan's decision 3 (2026-10-17, discussion
 * #2329). The database refuses a longer one too (connection_copies_serve_window);
 * this refuses it before sending, so the error names the rule.
 */
export const CONNECTION_SERVE_WINDOW_MS = 6 * 60 * 60 * 1000

/** One ops connection as the bidding Worker serves it: ciphertext and public config only, never a plaintext login. */
export interface ConnectionCopyInput {
  connectionId: string
  organizationId: string
  service: string
  /** credential_generation on the bidding row. A lower one than stored is refused. */
  generation: number
  /** The seal's envelope, {v, kid, wrapped_key, iv, ct}, as stored in service_connections.credential_enc. */
  envelope: unknown
  publicConfig: unknown
  target: unknown
  /** At most CONNECTION_SERVE_WINDOW_MS after the list's served_at. */
  serveUntil: string
}

export interface SaveConnectionCopiesResult {
  inserted: number
  updated: number
  confirmed: number
  /** A lower generation than the one stored. */
  refusedOlder: number
  /** Already past serve_until when it arrived. */
  refusedExpired: number
  /** A tombstone covers its generation: a late list cannot restore a removed connection (L625). */
  refusedRemoved: number
  withdrawn: number
}

export async function saveConnectionCopies(
  client: OpsSupabaseClient, servedAt: string, complete: boolean, copies: readonly ConnectionCopyInput[], options?: OpsRpcOptions,
): Promise<SaveConnectionCopiesResult> {
  if (copies.length > MAX_COPIES_PER_SAVE) throw new OpsWriteError(`save_connection_copies: ${copies.length} copies is more than one save carries (${MAX_COPIES_PER_SAVE})`)
  const served = Date.parse(servedAt)
  if (!Number.isFinite(served)) throw new OpsWriteError('save_connection_copies: served_at is not a time')
  for (const c of copies) {
    const until = Date.parse(c.serveUntil)
    if (!Number.isFinite(until) || until <= served || until - served > CONNECTION_SERVE_WINDOW_MS) {
      throw new OpsWriteError(`save_connection_copies: connection ${c.connectionId} has a serve_until more than 6 hours after it was served, or not after it`)
    }
  }
  const name = 'save_connection_copies'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_served_at: servedAt,
    p_complete: complete,
    p_copies: copies.map((c) => ({
      connection_id: c.connectionId,
      organization_id: c.organizationId,
      service: c.service,
      generation: c.generation,
      envelope: c.envelope,
      public_config: c.publicConfig,
      target: c.target ?? null,
      serve_until: c.serveUntil,
    })),
  }, options))
  return {
    inserted: field(name, row, 'inserted', isCount, 'a count'),
    updated: field(name, row, 'updated', isCount, 'a count'),
    confirmed: field(name, row, 'confirmed', isCount, 'a count'),
    refusedOlder: field(name, row, 'refused_older', isCount, 'a count'),
    refusedExpired: field(name, row, 'refused_expired', isCount, 'a count'),
    refusedRemoved: field(name, row, 'refused_removed', isCount, 'a count'),
    withdrawn: field(name, row, 'withdrawn', isCount, 'a count'),
  }
}

export interface ConnectionCopy {
  /** usable is the one state the envelope comes back in. */
  state: ConnectionCopyState
  connectionId: string
  service: string | null
  generation: number | null
  envelope: unknown
  publicConfig: unknown
  target: unknown
  servedAt: string | null
  serveUntil: string | null
  dbNow: string
}

/**
 * One connection's copy and whether it may be used now. Fails closed: a state
 * this Worker does not know, or an envelope returned with any state but
 * usable, is an error, never a usable copy.
 */
export async function readConnectionCopy(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, options?: OpsRpcOptions,
): Promise<ConnectionCopy> {
  const name = 'connection_copy'
  const row = oneRow(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_connection_id: connectionId }, options))
  const state = field(name, row, 'state', oneOf(CONNECTION_COPY_STATES), 'a copy state')
  const envelope = row.envelope ?? null
  if ((state === 'usable') !== (envelope !== null)) throw new OpsWriteError(`${name} returned ${envelope === null ? 'no envelope' : 'an envelope'} with the state ${state}`)
  return {
    state,
    connectionId: field(name, row, 'connection_id', isString, 'an id'),
    service: field(name, row, 'service', isStringOrNull, 'text or null'),
    generation: field(name, row, 'generation', isIntOrNull, 'a whole number or null'),
    envelope,
    publicConfig: row.public_config ?? null,
    target: row.target ?? null,
    servedAt: field(name, row, 'served_at', isTimeOrNull, 'a time or null'),
    serveUntil: field(name, row, 'serve_until', isTimeOrNull, 'a time or null'),
    dbNow: field(name, row, 'db_now', isTime, 'a time'),
  }
}

/** A removal: deletes the copies, measured identities and health it covers on ops at once. */
export async function recordConnectionTombstone(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, generation: number, removedAt: Date, options?: OpsRpcOptions,
): Promise<{ outcome: 'recorded' | 'already_recorded'; copiesRemoved: number }> {
  const name = 'record_connection_tombstone'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_connection_id: connectionId, p_generation: generation, p_removed_at: removedAt.toISOString(),
  }, options))
  return {
    outcome: field(name, row, 'outcome', oneOf(['recorded', 'already_recorded'] as const), 'a tombstone outcome'),
    copiesRemoved: field(name, row, 'copies_removed', isCount, 'a count'),
  }
}

/** The tombstone_expiry sweep: deletes only tombstones past their expiry. */
export async function purgeExpiredConnectionTombstones(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_expired_connection_tombstones'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isCount, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

const HEALTH_OUTCOMES = ['recorded', 'connection_removed'] as const
type HealthOutcome = (typeof HEALTH_OUTCOMES)[number]

function healthOutcome(name: string, data: unknown): HealthOutcome {
  if (!oneOf(HEALTH_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned something that is not a health outcome`)
  return data
}

/** The still valid cron's writer: a passing check, or a failed one with its cause. */
export async function recordConnectionCheck(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, result: { ok: true } | { ok: false; cause: string }, options?: OpsRpcOptions,
): Promise<HealthOutcome> {
  const name = 'record_connection_check'
  return healthOutcome(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_connection_id: connectionId, p_ok: result.ok, p_cause: result.ok ? null : result.cause,
  }, options))
}

/** A mint or refresh failure's writer. Only Reconnect clears what it writes. */
export async function recordConnectionNeedsReauth(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, cause: string, options?: OpsRpcOptions,
): Promise<HealthOutcome> {
  const name = 'record_connection_needs_reauth'
  return healthOutcome(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_connection_id: connectionId, p_cause: cause }, options))
}

/** Reconnect's writer, the only one that clears needs_reauth. */
export async function recordConnectionReauthCleared(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, options?: OpsRpcOptions,
): Promise<HealthOutcome> {
  const name = 'record_connection_reauth_cleared'
  return healthOutcome(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_connection_id: connectionId }, options))
}

export interface ConnectionHealthStatus {
  connectionId: string
  service: string
  generation: number
  /** One of CONNECTION_STATUSES; a status this Worker does not know is kept as text, shown rather than thrown (#1698 R3). */
  status: string
  lastCheckOkAt: string | null
  lastCheckFailedAt: string | null
  lastCheckCause: string | null
  needsReauthAt: string | null
  needsReauthCause: string | null
  reauthClearedAt: string | null
}

/** One organization's connections with their derived status, at most limit of them. */
export async function readConnectionStatus(
  client: OpsSupabaseClient, organizationId: OrganizationId, limit: number, options?: OpsRpcOptions,
): Promise<{ connections: ConnectionHealthStatus[]; reachedLimit: boolean }> {
  const name = 'connection_status'
  const connections = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_limit: limit }, options)).map((row) => ({
    connectionId: field(name, row, 'connection_id', isString, 'an id'),
    service: field(name, row, 'service', isString, 'text'),
    generation: field(name, row, 'generation', isInt, 'a whole number'),
    status: field(name, row, 'status', isString, 'text'),
    lastCheckOkAt: field(name, row, 'last_check_ok_at', isTimeOrNull, 'a time or null'),
    lastCheckFailedAt: field(name, row, 'last_check_failed_at', isTimeOrNull, 'a time or null'),
    lastCheckCause: field(name, row, 'last_check_cause', isStringOrNull, 'text or null'),
    needsReauthAt: field(name, row, 'needs_reauth_at', isTimeOrNull, 'a time or null'),
    needsReauthCause: field(name, row, 'needs_reauth_cause', isStringOrNull, 'text or null'),
    reauthClearedAt: field(name, row, 'reauth_cleared_at', isTimeOrNull, 'a time or null'),
  }))
  return { connections, reachedLimit: connections.length === limit }
}

// ── the ops Salesforce pool (#2334) ─────────────────────────────────────────

/** The 18 character org id userinfo answers; the 15 character form of the same org would key a second pool. */
const SF_ORG_ID = /^00D[A-Za-z0-9]{15}$/

/**
 * Written only by verify, from /services/oauth2/userinfo, never from the
 * declared target (L83). identity_changed writes nothing: the same generation
 * measured another org.
 */
export async function recordMeasuredIdentity(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, generation: number,
  identity: { sfOrgId: string; username: string }, options?: OpsRpcOptions,
): Promise<'recorded' | 'confirmed' | 'identity_changed' | 'connection_removed'> {
  if (!SF_ORG_ID.test(identity.sfOrgId)) throw new OpsWriteError('record_measured_identity: the measured org id is not an 18 character Salesforce org id')
  const name = 'record_measured_identity'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_connection_id: connectionId, p_generation: generation, p_sf_org_id: identity.sfOrgId, p_username: identity.username,
  }, options)
  const outcomes = ['recorded', 'confirmed', 'identity_changed', 'connection_removed'] as const
  if (!oneOf(outcomes)(data)) throw new OpsWriteError(`${name} returned something that is not an identity outcome`)
  return data
}

export interface AcquireSfLease {
  connectionId: string
  generation: number
  purpose: SfLeasePurpose
  /** A step's workflow; no other purpose names one. */
  workflowId?: string
  /** One holder holds one lease; asking again returns it. Released by holder. */
  holder: string
  /** 5 to 300 seconds. */
  ttlSeconds: number
  /** The declared instance_url host, given only by verify: the bootstrap slot before the connection is measured. */
  bootstrapHost?: string
}

export type SfLeaseAnswer =
  | { outcome: 'granted'; leaseId: string; expiresAt: string; pool: 'org' | 'bootstrap' }
  | { outcome: Exclude<SfLeaseOutcome, 'granted'>; retryAt: string | null }

/**
 * One Salesforce call's slot. Fails closed: an answer this Worker does not
 * know, or a grant with no lease, is an error and never a grant.
 */
export async function acquireSfLease(client: OpsSupabaseClient, organizationId: OrganizationId, ask: AcquireSfLease, options?: OpsRpcOptions): Promise<SfLeaseAnswer> {
  if (!(SF_LEASE_PURPOSES as readonly string[]).includes(ask.purpose)) throw new OpsWriteError(`acquire_sf_lease: ${String(ask.purpose)} is not a purpose`)
  if ((ask.purpose === 'step') !== (ask.workflowId !== undefined)) throw new OpsWriteError('acquire_sf_lease: a step names its workflow, and no other purpose does')
  if (ask.bootstrapHost !== undefined && ask.purpose !== 'verify') throw new OpsWriteError('acquire_sf_lease: only verify takes the bootstrap slot')
  const name = 'acquire_sf_lease'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId,
    p_connection_id: ask.connectionId,
    p_generation: ask.generation,
    p_purpose: ask.purpose,
    p_workflow_id: ask.workflowId ?? null,
    p_holder: ask.holder,
    p_ttl_seconds: ask.ttlSeconds,
    p_bootstrap_host: ask.bootstrapHost ?? null,
  }, options))
  const outcome = field(name, row, 'outcome', oneOf(SF_LEASE_OUTCOMES), 'a lease outcome')
  if (outcome === 'granted') {
    return {
      outcome,
      leaseId: field(name, row, 'lease_id', isString, 'an id'),
      expiresAt: field(name, row, 'expires_at', isTime, 'a time'),
      pool: field(name, row, 'pool', oneOf(['org', 'bootstrap'] as const), 'a pool'),
    }
  }
  return { outcome, retryAt: field(name, row, 'retry_at', isTimeOrNull, 'a time or null') }
}

/** Idempotent by holder: run it in a finally after every call. */
export async function releaseSfLease(client: OpsSupabaseClient, organizationId: OrganizationId, holder: string, options?: OpsRpcOptions): Promise<'released' | 'not_held'> {
  const name = 'release_sf_lease'
  const data = await callOpsRpc(client, name, { p_organization_id: organizationId, p_holder: holder }, options)
  if (!oneOf(['released', 'not_held'] as const)(data)) throw new OpsWriteError(`${name} returned something that is not a release outcome`)
  return data
}

/** Deletes leases whose holder died. They stopped counting when they lapsed (L409). */
export async function sweepSfLeases(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ swept: number; more: boolean }> {
  const name = 'sweep_sf_leases'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { swept: field(name, row, 'swept', isCount, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

/** A Salesforce org's daily API allocation and what is left of it. Remaining may be below zero. */
export async function recordSfBudgetReading(
  client: OpsSupabaseClient, sfOrgId: string, reading: { dailyApiMax: number; dailyApiRemaining: number; source: SfBudgetSource }, options?: OpsRpcOptions,
): Promise<'recorded'> {
  if (!(SF_BUDGET_SOURCES as readonly string[]).includes(reading.source)) throw new OpsWriteError(`record_sf_budget_reading: ${String(reading.source)} is not a reading source`)
  if (!SF_ORG_ID.test(sfOrgId)) throw new OpsWriteError('record_sf_budget_reading: the org id is not an 18 character Salesforce org id')
  const name = 'record_sf_budget_reading'
  const data = await callOpsRpc(client, name, {
    p_sf_org_id: sfOrgId, p_daily_api_max: reading.dailyApiMax, p_daily_api_remaining: reading.dailyApiRemaining, p_source: reading.source,
  }, options)
  if (data !== 'recorded') throw new OpsWriteError(`${name} returned something other than recorded`)
  return data
}
