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
 * migration 20261017220000) are at the end. Since #2335 the minute tick calls
 * saveConnectionCopies and recordConnectionTombstone every minute, saving what
 * the bidding Worker serves (connection-serve.ts). The OpsConnections
 * entrypoint's live wiring (ops-connections-live.ts, #2335 PR 8) calls the copy
 * read, the health writers and reader, the measured identity, the pool, the
 * tombstone and the lookup allowance, and since #2336 readMeasuredSfOrg and
 * recordSfBudgetReading, for the budget reading a Salesforce response carries
 * (connections/sf-budget-reading.ts). Since #2340 the tick also calls
 * readConnectionCheckTargets every minute (the login states) and, from its
 * connection_check sweep, recordConnectionCheck.
 */
import {
  CONNECTION_COPY_STATES, DELEGATION_ADD_OUTCOMES, DELEGATION_CHECK_OUTCOMES, DELEGATION_KINDS, DELEGATION_REMOVE_OUTCOMES, LEDGER_METHODS, OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS, OPS_SWEEPS, OVERLAP_RULES, REFRESH_OUTCOMES, RESOURCE_WAIT_CAUSES, SF_BUDGET_SOURCES, SF_LEASE_OUTCOMES, SF_LEASE_PURPOSES, TRIGGER_KINDS,
  type ConnectionCopyState, type DelegationAddOutcome, type DelegationCheckOutcome, type DelegationKind, type DelegationRemoveOutcome, type HolderFailedReason, type RefreshOutcome, type LedgerMethod, type ObservationOutcome, type OpsSweep, type OverlapRule,
  type ResourceWaitCause, type SfBudgetSource, type SfLeaseOutcome, type SfLeasePurpose, type TriggerKind,
  STEP_TEST_STATUSES, type StepTestStatus,
  OPS_STEP_RECORD_OUTCOMES, OPS_STEP_RECORD_STATUSES, type OpsStepRecordOutcome, type OpsStepRecordStatus,
  CHECKPOINT_ACK_OUTCOMES, type CheckpointAckOutcome,
  UNCHARGED_RESUME_REASONS,
  UNSTARTED_RETURN_CAUSES, type UnstartedReturnCause,
} from './run-vocabulary'
import {
  OPS_LANE_READ_ONLY_RPCS, OPS_LANE_RPCS, OPS_MUTATING_RPCS, OPS_ORGANIZATION_READ_ONLY_RPCS, OPS_ORGANIZATION_RPCS, OPS_READ_ONLY_RPCS,
  type OpsRpcName,
} from './ops-rpcs'
import {
  OPS_STATEMENT_DEADLINE_MS, organizationIdFrom, readOpsRows, sendWithinOpsDeadline, type OpsDeadlineOptions, type OpsSupabaseClient, type OrganizationId,
} from './ops-db'
import { CONNECTION_SERVE_WINDOW_MS } from '../lib/ops-gateway-contract'
import { DELEGATION_LIST_LIMIT } from '../lib/ops-connections-contract'
import { ENV_KEY } from '../lib/definition-env-references'
import { parseRunVariablesRecord, recordRow, type RunVariablesRecord } from './run-variables'

/** Past the ops project's 8 s statement timeout, so the database gives up first: the one deadline every ops request has (ops-db.ts). */
export const OPS_RPC_DEADLINE_MS = OPS_STATEMENT_DEADLINE_MS

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

/** deadlineMs defaults to OPS_RPC_DEADLINE_MS; delay is the timer seam readOpsRows takes too. */
export type OpsRpcOptions = OpsDeadlineOptions

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

  const sent = await sendWithinOpsDeadline((signal) => client.rpc(name, args).abortSignal(signal), options)
  if (sent.kind === 'timed_out') {
    throw new OpsWriteTimeoutError(`${name} passed its ${sent.deadlineMs} ms deadline and may still have committed`)
  }
  if (sent.kind === 'threw') {
    throw new OpsWriteError(`${name} could not be called: ${sent.error instanceof Error ? sent.error.message : 'unknown error'}`)
  }
  const data: unknown = sent.value.data
  const error = sent.value.error
  if (error) throw new OpsWriteError(`${name} failed (${error.code ?? 'no code'}): ${error.message}`)
  return data
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
  /** Every start so far. Each execution's identity, so it rises on every start, charged or not. */
  attempts: number
  /**
   * The starts so far not charged against maxAttempts: one resumed from a wait
   * on a resource (resource_wait) and one a lapse refunded (#2334). Always
   * answered since ops migration 20261018140000; a claim without it is refused,
   * never read as 0 (#2336).
   */
  unchargedAttempts: number
  /** Judged against the CHARGED count (chargedAttempts), never against attempts. */
  maxAttempts: number
  resumeReason: string | null
  executionChainId: string
  resumedFromExecutionId: string | null
  payload: unknown
  payloadRef: string | null
}

/** The starts so far charged against maxAttempts, as the database counts them. */
export function chargedAttempts(run: Pick<ClaimedRun, 'attempts' | 'unchargedAttempts'>): number {
  return run.attempts - run.unchargedAttempts
}

/**
 * Whether a retry after this claim's start ends the run dead at max_attempts,
 * the judgement complete_run_request makes (#2336). The start adds one attempt,
 * charged unless the run resumes from a wait or continues (UNCHARGED_RESUME_REASONS:
 * a resource wait, a rate limit wait since #2859, a continuation since #1951), so it is the run's last
 * charged attempt when attempts + 1 - unchargedAttempts - (1 if resumed from a
 * wait) reaches maxAttempts. supabase-ops/supabase/tests/
 * claim_uncharged_attempts.test.sql checks the same rule against the database.
 */
export function lastChargedAttempt(run: Pick<ClaimedRun, 'attempts' | 'unchargedAttempts' | 'maxAttempts' | 'resumeReason'>): boolean {
  return chargedAttemptsWithThisStart(run) >= run.maxAttempts
}

/**
 * The run's charged attempts once this claim's start is counted: the charged
 * count so far, plus this start unless it resumes from a wait or continues
 * (UNCHARGED_RESUME_REASONS). The count lastChargedAttempt judges and the wait
 * before a retry (#1693, run-invocation.ts) grows by.
 */
export function chargedAttemptsWithThisStart(run: Pick<ClaimedRun, 'attempts' | 'unchargedAttempts' | 'resumeReason'>): number {
  const thisStart = (UNCHARGED_RESUME_REASONS as readonly (string | null)[]).includes(run.resumeReason) ? 0 : 1
  return chargedAttempts(run) + thisStart
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
    const attempts = field(name, row, 'attempts', isInt, 'a whole number')
    // Required since ops migration 20261018140000 is applied (#2336). Its absence
    // is refused by name, never read as 0: that would judge max_attempts by every
    // start rather than the charged ones.
    if (!('uncharged_attempts' in row)) throw new OpsWriteError(`${name} returned no uncharged_attempts`)
    const isUncharged = (v: unknown): v is number => isInt(v) && v >= 0 && v <= attempts
    const unchargedAttempts = field(name, row, 'uncharged_attempts', isUncharged, 'a whole number from 0 to attempts')
    return {
      runRequestId: field(name, row, 'run_request_id', isString, 'an id'),
      organizationId,
      workflowId: field(name, row, 'workflow_id', isString, 'an id'),
      workflowVersion: field(name, row, 'workflow_version', isInt, 'a whole number'),
      triggerKind: field(name, row, 'trigger_kind', isString, 'text'),
      claimToken: field(name, row, 'claim_token', isString, 'a token'),
      claimExpiresAt: field(name, row, 'claim_expires_at', isString, 'a time'),
      stateVersion: field(name, row, 'state_version', isInt, 'a whole number'),
      attempts,
      unchargedAttempts,
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
  /**
   * How many times the run has been suspended to continue (#1951, ops
   * migration 20261028220000). Above 0, the attempt resumes from the
   * checkpoint the run names, never from its first step.
   */
  continuations: number
  /**
   * The variables the run recorded at its first start (#2998, ops migration
   * 20261029180000): this start's when it is the first, otherwise the first
   * start's, which every retry and continued slice runs with. Null when no
   * start sent any. Never a secret's value.
   */
  runVariables: RunVariablesRecord | null
}

/**
 * Starts the claimed run. variables is what it records at its first start
 * (#2998), kept only then: start_run_execution answers the record the run
 * holds. retryDisabled is whether the run's workflow is set not to retry, as
 * read from the run's version (run-live.ts), sent on every start and kept on
 * the run (#3046), so the lease sweep ends a lapsed no-retry run failed rather
 * than requeuing it. Throws OpsClaimLostError when the claim is no longer this
 * caller's.
 */
export async function startRunExecution(
  client: OpsSupabaseClient, organizationId: OrganizationId, runRequestId: string, claimToken: string, executionId: string,
  variables: RunVariablesRecord | null, retryDisabled: boolean, options?: OpsRpcOptions,
): Promise<StartedRun> {
  const name = 'start_run_execution'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: runRequestId, p_claim_token: claimToken, p_execution_id: executionId,
    p_variables: variables === null ? null : recordRow(variables),
    p_retry_disabled: retryDisabled,
  }, options))
  const outcome = field(name, row, 'outcome', oneOf(['started', 'already_started', 'claim_lost'] as const), 'a start outcome')
  if (outcome === 'claim_lost') throw new OpsClaimLostError(`${name}: run ${runRequestId} is not held by this claim`)
  // Required once ops migration 20261028220000 is applied (#1951). Its absence is
  // refused by name, never read as 0: a continued run read as never continued
  // would be walked again from its first step, repeating its earlier slices' sends.
  if (!('continuations' in row)) throw new OpsWriteError(`${name} returned no continuations`)
  const isCount = (v: unknown): v is number => isInt(v) && v >= 0
  // Required once ops migration 20261029180000 is applied (#2998). Its absence is
  // refused by name, never read as no record: a run would then refuse every variable.
  if (!('run_variables' in row)) throw new OpsWriteError(`${name} returned no run_variables`)
  let runVariables: RunVariablesRecord | null
  try {
    runVariables = parseRunVariablesRecord(row.run_variables)
  } catch (err) {
    throw new OpsWriteError(`${name}: ${err instanceof Error ? err.message : 'run_variables could not be read'}`)
  }
  return {
    outcome,
    stateVersion: field(name, row, 'state_version', isInt, 'a whole number'),
    attempt: field(name, row, 'attempt', isInt, 'a whole number'),
    continuations: field(name, row, 'continuations', isCount, 'a whole number from 0'),
    runVariables,
  }
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

/**
 * How a holder ends its claim. A resource_wait suspend (#2334) names what it
 * waited on, sent as p_error; the database ends the run failed with
 * resource_wait_exceeded instead once the wait is past 24 hours, so read
 * runStatus rather than assuming suspended. A rate_limit_wait suspend (#2859)
 * names its step (p_step, the key the requeue cap counts by), the HTTP status
 * that asked for it (p_status, null when no request was made) and what was
 * asked (p_error); the database ends the run failed with requeue_cap_reached
 * instead once that step reaches the requeue cap (OPS_STEP_REQUEUE_MAX waits,
 * or OPS_STEP_REQUEUE_WAIT_MAX_MS after its first). A holder cannot fail a run
 * for an engine only reason (ENGINE_FAILED_REASONS, finding F122). A retry of
 * a run not yet started (a return unstarted, #3023) names why it could not
 * start (unstartedCause, sent as p_reason, #3039); the database ends the run
 * failed with unstarted_wait_exceeded instead once it has waited
 * OPS_UNSTARTED_WAIT_MAX_MS to start, so read runStatus rather than assuming
 * queued.
 */
export type CompleteOutcome =
  | { outcome: 'done' }
  | { outcome: 'failed'; reason?: HolderFailedReason; error?: string }
  | { outcome: 'retry'; error?: string; notBefore?: Date; unstartedCause?: UnstartedReturnCause }
  | { outcome: 'suspend'; reason: 'continue' | 'wake'; notBefore: Date }
  | { outcome: 'suspend'; reason: 'resource_wait'; cause: ResourceWaitCause; notBefore: Date }
  | { outcome: 'suspend'; reason: 'rate_limit_wait'; step: string; status: number | null; notBefore: Date; error: string }
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
  if ('cause' in end && !(RESOURCE_WAIT_CAUSES as readonly string[]).includes(end.cause)) {
    throw new OpsWriteError(`${name}: ${end.cause} is not a resource wait cause`)
  }
  if ('unstartedCause' in end && end.unstartedCause !== undefined && !(UNSTARTED_RETURN_CAUSES as readonly string[]).includes(end.unstartedCause)) {
    throw new OpsWriteError(`${name}: ${end.unstartedCause} is not a cause a run is returned unstarted for`)
  }
  const row = oneRow(name, await callOpsRpc(client, name, withoutUndefined({
    p_organization_id: organizationId,
    p_run_request_id: runRequestId,
    p_claim_token: claimToken,
    p_outcome: end.outcome,
    p_reason: 'reason' in end ? end.reason : 'unstartedCause' in end ? end.unstartedCause : undefined,
    p_error: 'cause' in end ? end.cause : 'error' in end ? end.error : undefined,
    p_not_before: 'notBefore' in end ? iso(end.notBefore) : undefined,
    // Sent only for a rate limit wait, so every other outcome's call is the one it always was.
    ...('step' in end ? { p_step: end.step, p_status: end.status } : {}),
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
  /**
   * Ended failed: a fourth lapse with no send, lease_lapsed_repeatedly (#2334),
   * or a lapse of a run set not to retry, lease_lapsed_no_retry (#3046).
   */
  failed: number
  /** A full page was taken: call again until false. */
  more: boolean
  /**
   * The workflow of each run ended lease_lapsed_no_retry (#3046), once per run,
   * so the tick can page the live ones. Required once ops migration
   * 20261030160000 is applied: its absence is refused by name, never read as
   * none, which would let such a run end without a page.
   */
  noRetryWorkflowIds: string[]
}

const isUuidList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && UUID_SHAPE.test(x))

export async function sweepExpiredLeases(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<SweepResult> {
  const name = 'sweep_expired_leases'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return {
    requeued: field(name, row, 'requeued', isInt, 'a count'),
    retried: field(name, row, 'retried', isInt, 'a count'),
    needsHuman: field(name, row, 'needs_human', isInt, 'a count'),
    dead: field(name, row, 'dead', isInt, 'a count'),
    failed: field(name, row, 'failed', isInt, 'a count'),
    more: field(name, row, 'more', isBool, 'true or false'),
    noRetryWorkflowIds: field(name, row, 'no_retry_workflow_ids', isUuidList, 'a list of workflow ids'),
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
const isUuidOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))

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
  /** What its schedule's floor is taken from (#1952), as served; saved under its own order, by served_at. */
  porting: CopyPorting
}

/** A copy's porting facts (#1952): ServedOpsWorkflowPorting, as the ops Worker names it. */
export interface CopyPorting {
  ported: boolean
  cutoverAt: string | null
  replaces: string[]
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
      porting: { ported: c.porting.ported, cutover_at: c.porting.cutoverAt, replaces: c.porting.replaces },
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
  /**
   * The porting facts as the list that served them said (#1952), with that
   * list's served_at; null for a copy never told them (saved by an ops release
   * before #1952), whose floor is unknown.
   */
  porting: (CopyPorting & { servedAt: string }) | null
  /** The latest slot fired or observed by any workflow it replaces, within its organization. */
  replacedLastSlot: string | null
}

/** A copy's porting facts as workflow_copies answers them: all four columns null, or all told. */
function copyPorting(name: string, row: Row): WorkflowCopy['porting'] {
  const servedAt = field(name, row, 'porting_served_at', isTimeOrNull, 'a time or null')
  const ported = field(name, row, 'ported', (v): v is boolean | null => v === null || isBool(v), 'true, false or null')
  const replaces = field(name, row, 'replaces', (v): v is string[] | null => v === null || (Array.isArray(v) && v.every(isString)), 'a list of workflow ids or null')
  const cutoverAt = field(name, row, 'cutover_at', isTimeOrNull, 'a time or null')
  if (servedAt === null && ported === null && replaces === null && cutoverAt === null) return null
  if (servedAt === null || ported === null || replaces === null) {
    throw new OpsWriteError(`${name} returned porting facts for workflow ${String(row.workflow_id)} that are only partly told`)
  }
  return { ported, cutoverAt, replaces, servedAt }
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
      porting: copyPorting(name, row),
      replacedLastSlot: field(name, row, 'replaced_last_slot', isTimeOrNull, 'a time or null'),
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
 * #2329). Defined once, in the contract both Workers import, since the bidding
 * Worker sets serve_until by it (#2335). The database refuses a longer one too
 * (connection_copies_serve_window); this refuses it before sending, so the
 * error names the rule.
 */
export { CONNECTION_SERVE_WINDOW_MS }

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
  /** The users.id a person bound connection acts as, or null (#2339). */
  ownerUserId: string | null
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
      owner_user_id: c.ownerUserId,
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
  /**
   * The users.id a person bound connection acts as, or null: a company
   * connection, or an ops database or bidding Worker older than #2339, which
   * the executor reads as an own account owning nobody, so it refuses the step.
   */
  ownerUserId: string | null
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
    ownerUserId: row.owner_user_id === undefined ? null : field(name, row, 'owner_user_id', isUuidOrNull, 'a uuid or null'),
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

/** One measured identity remove_unserved_measured_identities removed (#2573). */
export interface UnservedIdentityRemoved {
  organizationId: string
  connectionId: string
  generation: number
  measuredAt: string
}

/**
 * The measured identities of connections bidding never stored (#2573, supabase-ops
 * migration 20261027180000): a Salesforce verify for a new connection records
 * one before bidding inserts the row, and a create whose insert failed and
 * whose revoke failed too leaves it with nothing to remove it. Called only
 * after a complete list was saved in one save, with that list's served_at and
 * every connection id it names; the database removes a measurement more than
 * an hour older than the list, of a connection the list does not name and ops
 * never held a copy of, and answers each row removed. Lane wide, like
 * save_connection_copies.
 */
export async function removeUnservedMeasuredIdentities(
  client: OpsSupabaseClient, servedAt: string, named: readonly string[], options?: OpsRpcOptions,
): Promise<UnservedIdentityRemoved[]> {
  const name = 'remove_unserved_measured_identities'
  if (!Number.isFinite(Date.parse(servedAt))) throw new OpsWriteError(`${name}: served_at is not a time`)
  if (named.length > MAX_COPIES_PER_SAVE) throw new OpsWriteError(`${name}: ${named.length} named connections is more than one save carries (${MAX_COPIES_PER_SAVE})`)
  const all = rows(name, await callOpsRpc(client, name, { p_served_at: servedAt, p_named: [...named] }, options))
  return all.map((row) => {
    const organizationId = field(name, row, 'organization_id', isString, 'an id')
    const connectionId = field(name, row, 'connection_id', isString, 'an id')
    if (!UUID_SHAPE.test(organizationId) || !UUID_SHAPE.test(connectionId)) throw new OpsWriteError(`${name} returned a connection id that is not a uuid`)
    const generation = field(name, row, 'generation', isInt, 'a whole number')
    if (generation < 1) throw new OpsWriteError(`${name} returned a generation below 1`)
    return { organizationId, connectionId, generation, measuredAt: field(name, row, 'measured_at', isTime, 'a time') }
  })
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

/**
 * A login's outcome on a committed connection (Dan's decision 2, #2335):
 * a token endpoint that timed out or answered 5xx adds to the refresh streak,
 * and the failure that takes the streak past its bound (5 failures, the first
 * 15 minutes old) writes needs_reauth through its one writer; a login that
 * worked ends the streak. A provider's refusal of the login is not this: it is
 * recordConnectionNeedsReauth, at once.
 */
export async function recordConnectionRefresh(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, result: { ok: true } | { ok: false; cause: string }, options?: OpsRpcOptions,
): Promise<RefreshOutcome> {
  const name = 'record_connection_refresh'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_connection_id: connectionId, p_ok: result.ok, p_cause: result.ok ? null : result.cause,
  }, options)
  if (!oneOf(REFRESH_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned something that is not a refresh outcome`)
  return data
}

/**
 * Whether a Google connection may act as this mailbox and name these shared
 * drives (finding F129): allowed only when the organization's own list names
 * each. Read on every Google authorize, before a token is minted or reused.
 */
export async function googleDelegationCheck(
  client: OpsSupabaseClient, organizationId: OrganizationId, mailbox: string, drives: readonly string[], options?: OpsRpcOptions,
): Promise<DelegationCheckOutcome> {
  const name = 'google_delegation_check'
  const data = await callOpsRpc(client, name, { p_organization_id: organizationId, p_mailbox: mailbox, p_drives: [...drives] }, options)
  if (!oneOf(DELEGATION_CHECK_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned something that is not a delegation check outcome`)
  return data
}

// ── the Google mailboxes and drives list (#2338) ────────────────────────────

/** The signed in person changing the list, as the bidding Worker read them from the JWT: their user id, and a name or an email to show. */
export interface DelegationActor {
  id: string
  email: string | null
  name: string | null
}

/** One entry, as the add and the remove name it. The database judges its shape (subject_invalid), so it has one home. */
export interface DelegationEntry {
  kind: DelegationKind
  subject: string
}

/** One entry of an organization's list, as list_google_delegation_subjects answers it. */
export interface DelegationSubject {
  kind: DelegationKind
  /** A mailbox's address, lower case, or a shared drive's id. */
  subject: string
  /** A shared drive's name; null for a mailbox, and for a drive saved without one. */
  displayName: string | null
  /** The person's name, or their email when no name was given. */
  addedBy: string
  addedAt: string
}

export type AddDelegationResult =
  | { outcome: 'added' | 'already_listed'; entry: DelegationSubject }
  | { outcome: Exclude<DelegationAddOutcome, 'added' | 'already_listed'>; entry: null }

function delegationSubject(name: string, row: Row): DelegationSubject {
  return {
    kind: field(name, row, 'kind', oneOf(DELEGATION_KINDS), 'mailbox or drive'),
    subject: field(name, row, 'subject', isString, 'text'),
    displayName: field(name, row, 'display_name', isStringOrNull, 'text or null'),
    addedBy: field(name, row, 'added_by', isString, 'text'),
    addedAt: field(name, row, 'added_at', isTime, 'a time'),
  }
}

function actorArgs(actor: DelegationActor): Record<string, unknown> {
  return { p_actor_id: actor.id, p_actor_email: actor.email, p_actor_name: actor.name }
}

/**
 * Adds one entry to the organization's list, with its change record (who, when,
 * what) in the same transaction, so a record that cannot be written rolls the
 * entry back. Throws when the database errors or answers anything else.
 */
export async function addGoogleDelegationSubject(
  client: OpsSupabaseClient, organizationId: OrganizationId, entry: DelegationEntry & { displayName: string | null }, actor: DelegationActor, options?: OpsRpcOptions,
): Promise<AddDelegationResult> {
  const name = 'add_google_delegation_subject'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_kind: entry.kind, p_subject: entry.subject, p_display_name: entry.displayName, ...actorArgs(actor),
  }, options))
  const outcome = field(name, row, 'outcome', oneOf(DELEGATION_ADD_OUTCOMES), 'an add outcome')
  if (outcome === 'added' || outcome === 'already_listed') return { outcome, entry: delegationSubject(name, row) }
  return { outcome, entry: null }
}

/** Removes one of the organization's own entries, with its change record. not_listed when it holds no such entry. */
export async function removeGoogleDelegationSubject(
  client: OpsSupabaseClient, organizationId: OrganizationId, entry: DelegationEntry, actor: DelegationActor, options?: OpsRpcOptions,
): Promise<DelegationRemoveOutcome> {
  const name = 'remove_google_delegation_subject'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_kind: entry.kind, p_subject: entry.subject, ...actorArgs(actor),
  }, options))
  return field(name, row, 'outcome', oneOf(DELEGATION_REMOVE_OUTCOMES), 'a remove outcome')
}

/** The organization's list, at most limit entries. Throws on a failed read: an empty list would read as nothing allowed. */
export async function readGoogleDelegationSubjects(
  client: OpsSupabaseClient, organizationId: OrganizationId, limit: number, options?: OpsRpcOptions,
): Promise<{ subjects: DelegationSubject[]; reachedLimit: boolean }> {
  const name = 'list_google_delegation_subjects'
  // list_google_delegation_subjects holds the limit to 1 to 1000, the contract's DELEGATION_LIST_LIMIT.
  if (!Number.isInteger(limit) || limit < 1 || limit > DELEGATION_LIST_LIMIT) throw new OpsWriteError(`${name}: the limit must be a whole number from 1 to ${DELEGATION_LIST_LIMIT}`)
  const subjects = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_limit: limit }, options)).map((row) => delegationSubject(name, row))
  return { subjects, reachedLimit: subjects.length === limit }
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

export const MEASURED_IDENTITY_OUTCOMES = ['recorded', 'confirmed', 'replaced', 'identity_changed', 'connection_removed'] as const
export type MeasuredIdentityOutcome = (typeof MEASURED_IDENTITY_OUTCOMES)[number]

/**
 * Written only by verify, from /services/oauth2/userinfo, never from the
 * declared target (L83). identity_changed writes nothing: a generation ops
 * holds as its copy measured another org. replaced (#2335, PR 8): a generation
 * the copy does not hold yet is a candidate's (F116, F126), and the next
 * candidate at that generation measures afresh.
 */
export async function recordMeasuredIdentity(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, generation: number,
  identity: { sfOrgId: string; username: string }, options?: OpsRpcOptions,
): Promise<MeasuredIdentityOutcome> {
  if (!SF_ORG_ID.test(identity.sfOrgId)) throw new OpsWriteError('record_measured_identity: the measured org id is not an 18 character Salesforce org id')
  const name = 'record_measured_identity'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_connection_id: connectionId, p_generation: generation, p_sf_org_id: identity.sfOrgId, p_username: identity.username,
  }, options)
  if (!oneOf(MEASURED_IDENTITY_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned something that is not an identity outcome`)
  return data
}

/**
 * The Salesforce org one connection generation MEASURED as
 * (connection_measured_identity, written only by verify), or null while verify
 * has not measured it (#2336). The key a response's budget reading is written
 * under, the same one acquire_sf_lease draws the call's lease from, never the
 * declared target (L83). A read, through readOpsRows, so it is held to the
 * organization by type and at run time, and to readOpsRows's deadline (#2505).
 * Its live caller (connectionFetch's recordBudget) still races it against the
 * tighter SF_BUDGET_READING_DEADLINE_MS.
 */
export async function readMeasuredSfOrg(
  client: OpsSupabaseClient, organizationId: OrganizationId, connectionId: string, generation: number,
): Promise<string | null> {
  const { rows } = await readOpsRows<{ sf_org_id: unknown }>(client, organizationId, {
    table: 'connection_measured_identity',
    columns: 'sf_org_id,organization_id',
    limit: 2,
    refine: (q) => q.eq('connection_id', connectionId).eq('generation', generation),
  })
  if (rows.length === 0) return null
  // The primary key is (connection_id, generation), so two rows mean the read is not what this code believes it is.
  if (rows.length > 1) throw new OpsWriteError('connection_measured_identity answered more than one row for one connection generation')
  const sfOrgId = rows[0].sf_org_id
  if (typeof sfOrgId !== 'string' || !SF_ORG_ID.test(sfOrgId)) throw new OpsWriteError('connection_measured_identity holds an org id that is not an 18 character Salesforce org id')
  return sfOrgId
}

/**
 * One measured Salesforce org the sf_limits sweep reads, and the connection it
 * reads it through (sf_limits_targets, #2336): the org the connection MEASURED
 * as, never its declared target (L83), and the organization every later call
 * for it is made under. readingMeasuredAt is the org's last budget reading, or
 * null when it has none; dbNow is the clock that reading's age is judged on.
 */
export interface SfLimitsTarget {
  sfOrgId: string
  organizationId: OrganizationId
  connectionId: string
  generation: number
  /** The copy's declared target, whose instance_url the read is sent to. connectionFetch checks it against the declared hosts again. */
  target: unknown
  readingMeasuredAt: string | null
  dbNow: string
}

/** The most measured orgs one read returns, as sf_limits_targets holds it. */
export const SF_LIMITS_TARGETS_MAX = 100

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every measured Salesforce org, at most `limit`, each with one connection that
 * can read it now. Lane wide, like workflow_copies. Throws on a failed read or a
 * row of the wrong shape: an empty list would read as nothing measured.
 */
export async function readSfLimitsTargets(
  client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions,
): Promise<{ targets: SfLimitsTarget[]; reachedLimit: boolean }> {
  const name = 'sf_limits_targets'
  if (!Number.isInteger(limit) || limit < 1 || limit > SF_LIMITS_TARGETS_MAX) throw new OpsWriteError(`${name}: the limit must be a whole number from 1 to ${SF_LIMITS_TARGETS_MAX}`)
  const all = rows(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  const targets = all.map((row): SfLimitsTarget => {
    const sfOrgId = field(name, row, 'sf_org_id', isString, 'an org id')
    if (!SF_ORG_ID.test(sfOrgId)) throw new OpsWriteError(`${name} returned an org id that is not an 18 character Salesforce org id`)
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a target whose organization is not a uuid`)
    }
    const connectionId = field(name, row, 'connection_id', isString, 'an id')
    if (!UUID_SHAPE.test(connectionId)) throw new OpsWriteError(`${name} returned a target whose connection is not a uuid`)
    const generation = field(name, row, 'generation', isInt, 'a whole number')
    if (generation < 1) throw new OpsWriteError(`${name} returned a generation below 1`)
    return {
      sfOrgId,
      organizationId,
      connectionId,
      generation,
      target: row.target ?? null,
      readingMeasuredAt: field(name, row, 'reading_measured_at', isTimeOrNull, 'a time or null'),
      dbNow: field(name, row, 'db_now', isTime, 'a time'),
    }
  })
  return { targets, reachedLimit: targets.length === limit }
}

/**
 * One ops connection as connection_check_targets answers it (#2340, supabase-ops
 * migration 20261020030000): what the connection_check sweep probes, and the
 * login state the tick reports to the bidding Worker. Never a login: the copy's
 * envelope is not read here, connectionFetch reads it for itself.
 */
export interface ConnectionCheckTarget {
  organizationId: OrganizationId
  connectionId: string
  service: string
  generation: number
  /** The copy's declared target and public config, which the identity probe is given. */
  target: unknown
  publicConfig: unknown
  /** serve_until is still ahead, so connectionFetch would use the copy. */
  servable: boolean
  /** connection_status's derived status; one this Worker does not know is kept as text (#1698 R3). */
  status: string
  lastCheckOkAt: string | null
  lastCheckFailedAt: string | null
  needsReauthAt: string | null
  needsReauthCause: string | null
  /** The refresh streak (Dan's decision 2): 0 and null when there is none. */
  refreshFailures: number
  refreshFailingSince: string | null
  /** What verify measured this generation as (Salesforce), or null when nothing was measured. */
  measuredIdentity: { sfOrgId: string; username: string } | null
  dbNow: string
}

/** The most connections one read returns, as connection_check_targets holds it. */
export const CONNECTION_CHECK_TARGETS_MAX = 500

/**
 * Every ops connection not withdrawn and not removed, at most `limit`, in
 * three bands: each login state that may page (needs_reauth, refresh_failing)
 * first, then the other servable copies, then the expired ones, the least
 * recently checked first within each (migration 20261020030000 says why). The
 * sweep and the tick's login states read this one list. Lane wide. Throws on a failed read or a row of the
 * wrong shape: an empty list would read as nothing to check and every login
 * state cleared.
 */
export async function readConnectionCheckTargets(
  client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions,
): Promise<{ targets: ConnectionCheckTarget[]; reachedLimit: boolean }> {
  const name = 'connection_check_targets'
  if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTION_CHECK_TARGETS_MAX) {
    throw new OpsWriteError(`${name}: the limit must be a whole number from 1 to ${CONNECTION_CHECK_TARGETS_MAX}`)
  }
  const all = rows(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  const targets = all.map((row): ConnectionCheckTarget => {
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a connection whose organization is not a uuid`)
    }
    const connectionId = field(name, row, 'connection_id', isString, 'an id')
    if (!UUID_SHAPE.test(connectionId)) throw new OpsWriteError(`${name} returned a connection id that is not a uuid`)
    const generation = field(name, row, 'generation', isInt, 'a whole number')
    if (generation < 1) throw new OpsWriteError(`${name} returned a generation below 1`)
    const refreshFailures = field(name, row, 'refresh_failures', isInt, 'a whole number')
    if (refreshFailures < 0) throw new OpsWriteError(`${name} returned refresh_failures below 0`)
    const sfOrgId = field(name, row, 'measured_sf_org_id', isStringOrNull, 'text or null')
    const username = field(name, row, 'measured_username', isStringOrNull, 'text or null')
    if ((sfOrgId === null) !== (username === null)) throw new OpsWriteError(`${name} returned half a measured identity`)
    return {
      organizationId,
      connectionId,
      service: field(name, row, 'service', isString, 'text'),
      generation,
      target: row.target ?? null,
      publicConfig: row.public_config ?? null,
      servable: field(name, row, 'servable', isBool, 'true or false'),
      status: field(name, row, 'status', isString, 'text'),
      lastCheckOkAt: field(name, row, 'last_check_ok_at', isTimeOrNull, 'a time or null'),
      lastCheckFailedAt: field(name, row, 'last_check_failed_at', isTimeOrNull, 'a time or null'),
      needsReauthAt: field(name, row, 'needs_reauth_at', isTimeOrNull, 'a time or null'),
      needsReauthCause: field(name, row, 'needs_reauth_cause', isStringOrNull, 'text or null'),
      refreshFailures,
      refreshFailingSince: field(name, row, 'refresh_failing_since', isTimeOrNull, 'a time or null'),
      measuredIdentity: sfOrgId === null || username === null ? null : { sfOrgId, username },
      dbNow: field(name, row, 'db_now', isTime, 'a time'),
    }
  })
  return { targets, reachedLimit: targets.length === limit }
}

/** What take_lookup_allowance answers: allowed (used counts this lookup), or rate_limited until retryAt. */
export type LookupAllowance =
  | { outcome: 'allowed'; used: number; retryAt: null }
  | { outcome: 'rate_limited'; used: number; retryAt: string }

/**
 * One schema lookup's allowance for one organization (#2335, PR 8): at most
 * perMinute in a one minute window, held under the organization's row lock.
 * The cap is the caller's stated constant; the database holds it to 1 to 600.
 */
export async function takeLookupAllowance(
  client: OpsSupabaseClient, organizationId: OrganizationId, perMinute: number, options?: OpsRpcOptions,
): Promise<LookupAllowance> {
  const name = 'take_lookup_allowance'
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) throw new OpsWriteError(`${name}: the cap must be a whole number from 1 to 600 a minute`)
  const row = oneRow(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_per_minute: perMinute }, options))
  const outcome = field(name, row, 'outcome', oneOf(['allowed', 'rate_limited'] as const), 'an allowance outcome')
  const used = field(name, row, 'used', isCount, 'a count')
  const retryAt = field(name, row, 'retry_at', isTimeOrNull, 'a time or null')
  if (outcome === 'allowed') return { outcome, used, retryAt: null }
  if (retryAt === null) throw new OpsWriteError(`${name} answered rate_limited with no retry_at`)
  return { outcome, used, retryAt }
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

// ── retention and definition copies (#1950, ops migration 20261022150000) ──

/** The observation_purge sweep: observations past 30 days, never a workflow's latest slot. */
export async function purgeScheduleObservations(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_schedule_observations'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

/**
 * One workflow version's definition, as the bidding Worker served it.
 * conflict: a different definition is held for the version and is kept, which
 * is the bidding side breaking its own rule, so the caller pages. no_copy: no
 * saved copy names the workflow yet. Never sends p_variables (#3003): a run
 * reads its variables when it starts, so none are kept beside a version any
 * more. A version held with variables an earlier deploy kept (#2702 to before
 * #3003) answers conflict to a second save of it, since the database still
 * compares them; nothing saves a version it already holds.
 */
export async function saveWorkflowDefinition(
  client: OpsSupabaseClient, organizationId: OrganizationId, workflowId: string, versionNumber: number, definition: Record<string, unknown>,
  options?: OpsRpcOptions,
): Promise<'saved' | 'already_saved' | 'conflict' | 'no_copy'> {
  const name = 'save_workflow_definition'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_workflow_id: workflowId, p_version_number: versionNumber, p_definition: definition,
  }, options)
  if (!oneOf(['saved', 'already_saved', 'conflict', 'no_copy'] as const)(data)) throw new OpsWriteError(`${name} returned something other than a save outcome`)
  return data
}

/**
 * One version of one organization's workflow, or null when it is not held.
 * The variables column an earlier deploy kept beside it (#2702) is not read
 * (#3003): no run reads it, so it can never stop one.
 */
export async function readWorkflowDefinition(
  client: OpsSupabaseClient, organizationId: OrganizationId, workflowId: string, versionNumber: number, options?: OpsRpcOptions,
): Promise<{ definition: Record<string, unknown>; savedAt: string } | null> {
  const name = 'workflow_definition'
  const all = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_workflow_id: workflowId, p_version_number: versionNumber }, options))
  if (all.length > 1) throw new OpsWriteError(`${name} returned ${all.length} rows, expected at most 1`)
  if (all.length === 0) return null
  const row = all[0]
  const definition = row.definition
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) throw new OpsWriteError(`${name} returned a definition that is not an object`)
  return { definition: definition as Record<string, unknown>, savedAt: field(name, row, 'saved_at', isString, 'a time') }
}

/** The saved copies whose current version has no definition held, at most limit, and whether the read was full. */
export async function readMissingWorkflowDefinitions(
  client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions,
): Promise<{ missing: Array<{ workflowId: string; organizationId: OrganizationId; versionNumber: number }>; reachedLimit: boolean }> {
  const name = 'missing_workflow_definitions'
  const all = rows(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  const missing = all.map((row) => {
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a workflow whose organization is not a uuid`)
    }
    return {
      workflowId: field(name, row, 'workflow_id', isString, 'an id'),
      organizationId,
      versionNumber: field(name, row, 'version_number', isInt, 'a whole number'),
    }
  })
  return { missing, reachedLimit: missing.length === limit }
}

// ── the waits to start (#3039, ops migration 20261030190000) ─────────────────

/** One workflow's runs waiting to start, as unstarted_run_waits answers it. */
export interface UnstartedRunWait {
  organizationId: OrganizationId
  workflowId: string
  /** The runs whose wait has lasted at least the minimum asked. */
  runs: number
  /** When the oldest of their waits began, on the database clock. */
  oldestSince: string
  /** How long the oldest has waited, on the database clock. */
  waitedSeconds: number
  /** The causes their latest returns named; null for a return that named none (an ops release before #3039). */
  causes: Array<UnstartedReturnCause | null>
}

const isCauses = (v: unknown): v is Array<UnstartedReturnCause | null> =>
  Array.isArray(v) && v.length > 0 && v.every((c) => c === null || (UNSTARTED_RETURN_CAUSES as readonly unknown[]).includes(c))
const isPositiveCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1

/**
 * Per workflow, the runs returned to the queue unstarted whose wait to start
 * has lasted at least minWaitSeconds, oldest wait first, at most limit
 * workflows (unstarted_run_waits, lane wide).
 */
export async function readUnstartedRunWaits(
  client: OpsSupabaseClient, minWaitSeconds: number, limit: number, options?: OpsRpcOptions,
): Promise<{ waits: UnstartedRunWait[]; reachedLimit: boolean }> {
  const name = 'unstarted_run_waits'
  const all = rows(name, await callOpsRpc(client, name, { p_min_wait_seconds: minWaitSeconds, p_limit: limit }, options))
  const waits = all.map((row) => {
    let organizationId: OrganizationId
    try {
      organizationId = organizationIdFrom(row.organization_id)
    } catch {
      throw new OpsWriteError(`${name} returned a workflow whose organization is not a uuid`)
    }
    return {
      organizationId,
      workflowId: field(name, row, 'workflow_id', isString, 'an id'),
      runs: field(name, row, 'runs', isPositiveCount, 'a count of one or more'),
      oldestSince: field(name, row, 'oldest_since', isTime, 'a time'),
      waitedSeconds: field(name, row, 'waited_seconds', isCount, 'a count'),
      causes: field(name, row, 'causes', isCauses, 'causes'),
    }
  })
  return { waits, reachedLimit: waits.length === limit }
}

// ── a step's test result (#2339, ops migration 20261024010000) ──────────────

export interface StepTestRecord {
  nodeId: string
  namespace: string
  /** The users.id of the person who ran the test. */
  testedBy: string
  status: StepTestStatus
  /** The action's answer, scrubbed of the connection's secrets; null for a failure or an answer over the cap. */
  output: unknown
  /** The answer's size: given for one over the cap (output null), so it is named, never read as empty; measured by the database otherwise. */
  outputBytes: number | null
  /** Why it failed; null when it completed. */
  error: string | null
  /** Each request the step made, sanitised before its login was applied. */
  requests: unknown[]
  durationMs: number
}

export interface StoredStepTest extends StepTestRecord {
  testedAt: string
}

/** Keeps a step's latest test result, replacing the one before. Answers when it was recorded, on the database clock. */
export async function recordStepTest(
  client: OpsSupabaseClient, organizationId: OrganizationId, workflowId: string, result: StepTestRecord, options?: OpsRpcOptions,
): Promise<string> {
  const name = 'record_step_test'
  if (!(STEP_TEST_STATUSES as readonly string[]).includes(result.status)) throw new OpsWriteError(`${name}: ${String(result.status)} is not a test status`)
  if (result.status === 'failed' && (result.error === null || result.error === '')) throw new OpsWriteError(`${name}: a failed test needs its error`)
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_workflow_id: workflowId, p_node_id: result.nodeId, p_namespace: result.namespace, p_tested_by: result.testedBy,
    p_status: result.status, p_output: result.output ?? null, p_output_bytes: result.outputBytes, p_error: result.error, p_requests: result.requests, p_duration_ms: result.durationMs,
  }, options)
  if (!isTime(data)) throw new OpsWriteError(`${name} returned something other than a time`)
  return data
}

/** One step's latest test result in the organization, or null: none, or one past 7 days on the database clock. */
export async function readStepTestResult(
  client: OpsSupabaseClient, organizationId: OrganizationId, workflowId: string, nodeId: string, options?: OpsRpcOptions,
): Promise<StoredStepTest | null> {
  const name = 'step_test_result'
  const all = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_workflow_id: workflowId, p_node_id: nodeId }, options))
  if (all.length > 1) throw new OpsWriteError(`${name} returned ${all.length} rows, expected at most 1`)
  if (all.length === 0) return null
  const row = all[0]
  const requests = row.requests
  if (!Array.isArray(requests)) throw new OpsWriteError(`${name} returned requests that are not a list`)
  return {
    nodeId: field(name, row, 'node_id', isString, 'text'),
    namespace: field(name, row, 'namespace', isString, 'text'),
    testedBy: field(name, row, 'tested_by', isString, 'an id'),
    testedAt: field(name, row, 'tested_at', isTime, 'a time'),
    status: field(name, row, 'status', oneOf(STEP_TEST_STATUSES), 'a test status'),
    output: row.output ?? null,
    outputBytes: field(name, row, 'output_bytes', isIntOrNull, 'a whole number or null'),
    error: field(name, row, 'error', isStringOrNull, 'text or null'),
    requests,
    durationMs: field(name, row, 'duration_ms', isInt, 'a whole number'),
  }
}

/** The nightly purge of step test results tested more than 7 days ago, by the database clock. */
export async function purgeStepTestResults(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_step_test_results'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

// ── each step of an ops run (#2703, ops migration 20261024150000) ───────────

/** The run attempt a step record belongs to, and the claim token that fences it. */
export interface OpsStepFence {
  runRequestId: string
  claimToken: string
  executionId: string
}

/** One step a run walked, as record_ops_step keeps it. */
export interface OpsStepRecord {
  /** The step's place in its attempt, from 0, with no gap. */
  seq: number
  nodeId: string
  namespace: string
  stepType: string
  status: OpsStepRecordStatus
  startedAt: Date
  durationMs: number
  /** What the step answered, scrubbed of the connection's secrets by connectionFetch; null for a failure or an answer over the cap. */
  output: unknown
  /** The answer's size when it was over the cap (output null); measured by the database otherwise. */
  outputBytes: number | null
  /** Why it failed; null when it completed. */
  error: string | null
}

/**
 * Records one step of the running attempt the fence names. stale means the run
 * is not this holder's any more and nothing was written; already_recorded is a
 * repeat of a record that landed. A place that would leave a gap is refused by
 * the database, by name.
 */
export async function recordOpsStep(
  client: OpsSupabaseClient, organizationId: OrganizationId, fence: OpsStepFence, record: OpsStepRecord, options?: OpsRpcOptions,
): Promise<OpsStepRecordOutcome> {
  const name = 'record_ops_step'
  if (!(OPS_STEP_RECORD_STATUSES as readonly string[]).includes(record.status)) throw new OpsWriteError(`${name}: ${String(record.status)} is not a step record status`)
  if (record.status === 'failed' && (record.error === null || record.error === '')) throw new OpsWriteError(`${name}: a failed step needs its error`)
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: fence.runRequestId, p_claim_token: fence.claimToken, p_execution_id: fence.executionId,
    p_seq: record.seq, p_node_id: record.nodeId, p_namespace: record.namespace, p_step_type: record.stepType, p_status: record.status,
    p_started_at: record.startedAt.toISOString(), p_duration_ms: record.durationMs, p_output: record.output ?? null, p_output_bytes: record.outputBytes,
    p_error: record.error,
  }, options)
  if (!oneOf(OPS_STEP_RECORD_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned ${JSON.stringify(data)?.slice(0, 40) ?? 'nothing'}, not a step record outcome`)
  return data
}

/** One step's latest completed output in a past run, as run_step_context answers it. */
export interface RunContextStep {
  namespace: string
  nodeId: string
  seq: number
  output: unknown
  /** False when the output was over the cap and only its size was kept. */
  outputKept: boolean
}

/** What a step test from a past run is built from (#2339), read by run_step_context. */
export interface RunStepContext {
  executionStatus: string
  startedAt: string
  /** False once the attempt is 7 days old by the database clock: payload and steps are then null. */
  withinRetention: boolean
  /** The attempt recorded the step: steps is then the context the run had at its last place. */
  reached: boolean
  payload: unknown
  /** The run's payload is held by reference elsewhere, not in the run row. */
  payloadElsewhere: boolean
  contextBytes: number | null
  /** Null past 7 days, or when the outputs together are more than a test takes (contextBytes says how big). */
  steps: RunContextStep[] | null
}

const isRecordRow = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** One organization's attempt of one workflow, read for a step test; null when there is no such attempt. */
export async function readRunStepContext(
  client: OpsSupabaseClient, organizationId: OrganizationId, workflowId: string, executionId: string, nodeId: string, options?: OpsRpcOptions,
): Promise<RunStepContext | null> {
  const name = 'run_step_context'
  const all = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_workflow_id: workflowId, p_execution_id: executionId, p_node_id: nodeId }, options))
  if (all.length > 1) throw new OpsWriteError(`${name} returned ${all.length} rows, expected at most 1`)
  if (all.length === 0) return null
  const row = all[0]
  let steps: RunContextStep[] | null = null
  if (row.steps !== null && row.steps !== undefined) {
    if (!Array.isArray(row.steps)) throw new OpsWriteError(`${name} returned steps that are not a list`)
    steps = row.steps.map((s: unknown) => {
      if (!isRecordRow(s) || !isString(s.namespace) || !isString(s.node_id) || !isInt(s.seq) || !isBool(s.output_kept)) {
        throw new OpsWriteError(`${name} returned steps whose entries are not each a step id, node, place and kept flag`)
      }
      return { namespace: s.namespace, nodeId: s.node_id, seq: s.seq, output: s.output ?? null, outputKept: s.output_kept }
    })
  }
  return {
    executionStatus: field(name, row, 'execution_status', isString, 'text'),
    startedAt: field(name, row, 'started_at', isTime, 'a time'),
    withinRetention: field(name, row, 'within_retention', isBool, 'true or false'),
    reached: field(name, row, 'reached', isBool, 'true or false'),
    payload: row.payload ?? null,
    payloadElsewhere: field(name, row, 'payload_elsewhere', isBool, 'true or false'),
    contextBytes: field(name, row, 'context_bytes', isIntOrNull, 'a whole number or null'),
    steps,
  }
}

// ── a run's checkpoint (#1951, ops migration 20261027150000) ───────────────

/** What a holder names when it acknowledges a checkpoint it wrote to R2 (checkpoint.ts). */
export interface CheckpointAck {
  executionId: string
  /** The state version the holder's start answered, which the key carries. */
  stateVersion: number
  steps: number
  key: string
  sha256: string
  bytes: number
}

/**
 * Names the checkpoint on its run. stale means the run is not this holder's
 * running attempt at this state version any more, and nothing was written;
 * superseded that the run names a later checkpoint of this holder;
 * already_recorded a repeat of an acknowledgement that landed.
 */
export async function recordRunCheckpoint(
  client: OpsSupabaseClient, organizationId: OrganizationId, fence: { runRequestId: string; claimToken: string }, ack: CheckpointAck, options?: OpsRpcOptions,
): Promise<CheckpointAckOutcome> {
  const name = 'record_run_checkpoint'
  const data = await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_run_request_id: fence.runRequestId, p_claim_token: fence.claimToken, p_execution_id: ack.executionId,
    p_state_version: ack.stateVersion, p_steps: ack.steps, p_checkpoint_key: ack.key, p_sha256: ack.sha256, p_bytes: ack.bytes,
  }, options)
  if (!oneOf(CHECKPOINT_ACK_OUTCOMES)(data)) throw new OpsWriteError(`${name} returned ${JSON.stringify(data)?.slice(0, 40) ?? 'nothing'}, not a checkpoint outcome`)
  return data
}

/** The checkpoint a run names, as the resume trusts it (checkpoint.ts CheckpointPointer). */
export interface NamedCheckpoint {
  key: string
  stateVersion: number
  steps: number
  sha256: string
  bytes: number
}

/** What run_checkpoint answers: the run is not this holder's (held false), or its state version and the checkpoint it names, null for none. */
export type RunCheckpointRead = { held: false } | { held: true; stateVersion: number; checkpoint: NamedCheckpoint | null }

export async function readRunCheckpoint(
  client: OpsSupabaseClient, organizationId: OrganizationId, runRequestId: string, claimToken: string, options?: OpsRpcOptions,
): Promise<RunCheckpointRead> {
  const name = 'run_checkpoint'
  const all = rows(name, await callOpsRpc(client, name, { p_organization_id: organizationId, p_run_request_id: runRequestId, p_claim_token: claimToken }, options))
  if (all.length === 0) return { held: false }
  if (all.length !== 1) throw new OpsWriteError(`${name} returned ${all.length} rows, expected at most 1`)
  const row = all[0]
  const stateVersion = field(name, row, 'state_version', isInt, 'a whole number')
  const pointer = ['checkpoint_key', 'checkpoint_state_version', 'checkpoint_steps', 'checkpoint_sha256', 'checkpoint_bytes', 'checkpoint_execution_id', 'checkpoint_at']
  const set = pointer.filter((k) => row[k] !== null && row[k] !== undefined).length
  if (set === 0) return { held: true, stateVersion, checkpoint: null }
  // The database holds the pointer whole or not at all; a half one is never read as none.
  if (set !== pointer.length) throw new OpsWriteError(`${name} returned a checkpoint with only ${set} of its ${pointer.length} parts`)
  const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  return {
    held: true,
    stateVersion,
    checkpoint: {
      key: field(name, row, 'checkpoint_key', isString, 'a key'),
      stateVersion: field(name, row, 'checkpoint_state_version', isInt, 'a whole number'),
      steps: field(name, row, 'checkpoint_steps', isInt, 'a whole number'),
      sha256: field(name, row, 'checkpoint_sha256', isSha, 'a digest'),
      bytes: field(name, row, 'checkpoint_bytes', isInt, 'a whole number'),
    },
  }
}

/** The records of runs terminal more than 7 days ago, cleared a page at a time (purge_run_variables, #2998). */
export async function purgeRunVariables(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_run_variables'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

// ── the last good copy of each version's plain variables (#2999, ops migration 20261029220000) ──

/**
 * The database's bounds on a copy (save_variable_copies), which the tick checks
 * before it sends, so one oversized version is left out rather than failing the
 * whole save. variable-copies.test.ts reads them out of the migration.
 */
export const MAX_VARIABLE_COPIES_PER_SAVE = 1000
export const MAX_VARIABLE_COPY_NAMES = 500
export const MAX_VARIABLE_COPY_VALUE_BYTES = 65536
export const MAX_VARIABLE_COPY_KEY_BYTES = 256

/**
 * One version's copy as the tick writes it: every name the version reads, each
 * a plain value, a secret by name, or absent (bidding has no such variable).
 * There is no field a secret's value could travel in.
 */
export interface VariableCopyInput {
  organizationId: OrganizationId
  workflowId: string
  versionNumber: number
  /** The bidding Worker's clock when it served the values. */
  servedAt: string
  values: Record<string, string>
  secretKeys: string[]
  absentKeys: string[]
}

/** What save_variable_copies did: versions written or left as held, key rows written or deleted, and versions it skipped. */
export interface SaveVariableCopiesResult {
  versionsWritten: number
  versionsUnchanged: number
  keysWritten: number
  keysDeleted: number
  refusedNoCopy: number
  refusedOlder: number
}

/**
 * The tick's one write of the copies (variable-copies.ts is its only caller,
 * held by ops-variable-copies-one-writer.test.ts). Each version replaces its
 * rows whole, and the database rewrites only the rows that changed;
 * confirmEverySeconds is how stale an unchanged version's confirmed_at may get
 * before it is moved.
 */
export async function saveVariableCopies(
  client: OpsSupabaseClient, copies: readonly VariableCopyInput[], confirmEverySeconds: number, options?: OpsRpcOptions,
): Promise<SaveVariableCopiesResult> {
  const name = 'save_variable_copies'
  const row = oneRow(name, await callOpsRpc(client, name, {
    p_copies: copies.map((c) => ({
      organization_id: c.organizationId, workflow_id: c.workflowId, version_number: c.versionNumber, served_at: c.servedAt,
      values: { ...c.values }, secret_keys: [...c.secretKeys], absent_keys: [...c.absentKeys],
    })),
    p_confirm_every_seconds: confirmEverySeconds,
  }, options))
  return {
    versionsWritten: field(name, row, 'versions_written', isCount, 'a count'),
    versionsUnchanged: field(name, row, 'versions_unchanged', isCount, 'a count'),
    keysWritten: field(name, row, 'keys_written', isCount, 'a count'),
    keysDeleted: field(name, row, 'keys_deleted', isCount, 'a count'),
    refusedNoCopy: field(name, row, 'refused_no_copy', isCount, 'a count'),
    refusedOlder: field(name, row, 'refused_older', isCount, 'a count'),
  }
}

/** One version's kept copy, as variable_copies answers it, with the database clock it was read at. */
export interface VariableCopy {
  workflowId: string
  versionNumber: number
  servedAt: string
  /** This database's clock when the copy was last written or confirmed: its age is judged from here. */
  confirmedAt: string
  values: Record<string, string>
  secretKeys: string[]
  absentKeys: string[]
  dbNow: string
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === 'string' && ENV_KEY.test(k))
const isNamedText = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, x]) => ENV_KEY.test(k) && typeof x === 'string')

/** One organization's kept copies of the versions asked about; a version not held is left out. */
export async function readVariableCopies(
  client: OpsSupabaseClient, organizationId: OrganizationId, versions: ReadonlyArray<{ workflowId: string; versionNumber: number }>, options?: OpsRpcOptions,
): Promise<VariableCopy[]> {
  const name = 'variable_copies'
  const all = rows(name, await callOpsRpc(client, name, {
    p_organization_id: organizationId, p_versions: versions.map((v) => ({ workflow_id: v.workflowId, version_number: v.versionNumber })),
  }, options))
  return all.map((row) => ({
    workflowId: field(name, row, 'workflow_id', isString, 'an id'),
    versionNumber: field(name, row, 'version_number', isInt, 'a whole number'),
    servedAt: field(name, row, 'served_at', isTime, 'a time'),
    confirmedAt: field(name, row, 'confirmed_at', isTime, 'a time'),
    values: { ...field(name, row, 'plain_values', isNamedText, 'variable names and text') },
    secretKeys: [...field(name, row, 'secret_keys', isNameList, 'variable names')],
    absentKeys: [...field(name, row, 'absent_keys', isNameList, 'variable names')],
    dbNow: field(name, row, 'db_now', isTime, 'a time'),
  }))
}

/** The nightly purge of copies past the age a fallback refuses, and of workflows gone from the lane. */
export async function purgeVariableCopies(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_variable_copies'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

/** The nightly purge of the step records of run attempts started more than 7 days ago, by the database clock. */
export async function purgeOpsStepRecords(client: OpsSupabaseClient, limit: number, options?: OpsRpcOptions): Promise<{ purged: number; more: boolean }> {
  const name = 'purge_ops_step_records'
  const row = oneRow(name, await callOpsRpc(client, name, { p_limit: limit }, options))
  return { purged: field(name, row, 'purged', isInt, 'a count'), more: field(name, row, 'more', isBool, 'true or false') }
}

// ── The reseal watch (#2486, ops migration 20261027160000) ──────────────────

/** The modes OPS_RESEAL may name, which the state row keeps (its CHECK). */
export const OPS_RESEAL_MODES = ['preview', 'apply'] as const
export type OpsResealMode = (typeof OPS_RESEAL_MODES)[number]

/**
 * ops_reseal_state as either function answers it: the mode the switch was
 * seen in and since when, the last run's result, the first of an unbroken line
 * of runs that left nothing, whether this call started the clock afresh, and
 * the database's clock to judge it all by.
 */
export interface OpsResealState {
  mode: OpsResealMode
  modeSince: string
  lastRunAt: string | null
  lastRunNothingLeft: boolean | null
  lastRunLeft: number | null
  nothingLeftSince: string | null
  restarted: boolean
  dbNow: string
}

const isResealMode = (v: unknown): v is OpsResealMode => (OPS_RESEAL_MODES as readonly unknown[]).includes(v)
const isBoolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean'
const isCountOrNull = (v: unknown): v is number | null => v === null || isCount(v)

function resealModeArg(name: string, mode: unknown): OpsResealMode {
  if (!isResealMode(mode)) throw new OpsWriteError(`${name}: the mode must be preview or apply`)
  return mode
}

function resealState(name: string, data: unknown): OpsResealState {
  const row = oneRow(name, data)
  return {
    mode: field(name, row, 'mode', isResealMode, 'preview or apply'),
    modeSince: field(name, row, 'mode_since', isTime, 'a time'),
    lastRunAt: field(name, row, 'last_run_at', isTimeOrNull, 'a time or null'),
    lastRunNothingLeft: field(name, row, 'last_run_nothing_left', isBoolOrNull, 'true, false or null'),
    lastRunLeft: field(name, row, 'last_run_left', isCountOrNull, 'a count or null'),
    nothingLeftSince: field(name, row, 'nothing_left_since', isTimeOrNull, 'a time or null'),
    restarted: field(name, row, 'restarted', isBool, 'true or false'),
    dbNow: field(name, row, 'db_now', isTime, 'a time'),
  }
}

/** The tick's sighting of OPS_RESEAL in `mode` (reseal-watch.ts): stamps it seen, restarting its clock on a change of mode or a gap past the window. */
export async function observeOpsReseal(client: OpsSupabaseClient, mode: OpsResealMode, restartAfterSeconds: number, options?: OpsRpcOptions): Promise<OpsResealState> {
  const name = 'observe_ops_reseal'
  const p_mode = resealModeArg(name, mode)
  return resealState(name, await callOpsRpc(client, name, { p_mode, p_restart_after_seconds: restartAfterSeconds }, options))
}

/**
 * One reseal run's result in `mode` (reseal-live.ts): nothingLeft only when the
 * run reported nothing_left, with left 0; a failed or refused run is
 * nothingLeft false with left null.
 */
export async function recordOpsResealRun(
  client: OpsSupabaseClient, mode: OpsResealMode, run: { nothingLeft: boolean; left: number | null }, restartAfterSeconds: number, options?: OpsRpcOptions,
): Promise<OpsResealState> {
  const name = 'record_ops_reseal_run'
  const p_mode = resealModeArg(name, mode)
  return resealState(name, await callOpsRpc(client, name, {
    p_mode, p_nothing_left: run.nothingLeft, p_left: run.left, p_restart_after_seconds: restartAfterSeconds,
  }, options))
}
