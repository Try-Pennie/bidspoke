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
 * Nothing calls these yet: the tick (#1949) and run invocation (#1950) do.
 */
import { LEDGER_METHODS, OVERLAP_RULES, TRIGGER_KINDS, type LedgerMethod, type OverlapRule, type TriggerKind } from './run-vocabulary'
import { OPS_LANE_RPCS, OPS_MUTATING_RPCS, OPS_ORGANIZATION_RPCS, OPS_READ_ONLY_RPCS, type OpsRpcName } from './ops-rpcs'
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
const ORGANIZATION_SCOPED: ReadonlySet<string> = new Set<string>(OPS_ORGANIZATION_RPCS)
const LANE_WIDE: ReadonlySet<string> = new Set<string>([...OPS_LANE_RPCS, ...OPS_READ_ONLY_RPCS])

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

/** Ends the claim. Zero rows is an error (#1698 1.3): throws OpsClaimLostError when the run is not this claim's. */
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
