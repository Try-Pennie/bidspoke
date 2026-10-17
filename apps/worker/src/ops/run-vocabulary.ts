/**
 * The ops run engine's vocabularies, in one home (#1948, lessons audit L83 on
 * the #1945 plan).
 *
 * Each list here is also a CHECK constraint in the ops database
 * (supabase-ops/supabase/migrations/20261016200000_run_engine_1948.sql), which is
 * what actually refuses a wrong value. The two cannot derive from each other
 * across SQL and TypeScript, so
 * apps/web/src/lib/__tests__/ops-run-vocabulary-matches-db.test.ts reads every
 * constraint the migrations define and fails when a list here and its
 * constraint differ: a status added in one place and not the other is caught
 * there, not by a reader that silently omits it.
 *
 * A reader that switches over one of these ends in assertNever, and renders a
 * value it does not know rather than throwing (#1698 R3): a newer database can
 * hold a status an older Worker has never seen.
 */

/** Every state of a run_requests row. */
export const RUN_REQUEST_STATUSES = [
  'queued',
  'claimed',
  'running',
  'suspended',
  'done',
  'failed',
  'needs_human',
  'dead',
  'expired',
  'skipped',
] as const
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number]

/** The statuses a run never leaves. needs_human is NOT one: a person resolves it. */
export const TERMINAL_RUN_REQUEST_STATUSES = ['done', 'failed', 'dead', 'expired', 'skipped'] as const satisfies readonly RunRequestStatus[]

/** The statuses that hold a lease (and a concurrency permit). */
export const LEASED_RUN_REQUEST_STATUSES = ['claimed', 'running'] as const satisfies readonly RunRequestStatus[]

/** What started a run. rerun is a person's deliberate rerun, in its own dedup namespace (#1698 D5). */
export const TRIGGER_KINDS = ['http_webhook', 'schedule', 'slack_event', 'email_inbound', 'poll', 'app_webhook', 'call', 'rerun'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

/**
 * Why a run is in the state it is in, for the states the status alone does not
 * explain. Grouped by the status each belongs to; the database stores one flat
 * list (run_requests_status_reason_check).
 */
export const STATUS_REASONS = {
  dead: ['workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts'],
  needs_human: ['lease_expired_after_send', 'send_outcome_unknown'],
  skipped: ['paused', 'rate_limited', 'overlap'],
  expired: ['not_started_in_time'],
  failed: ['max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded'],
} as const satisfies Partial<Record<RunRequestStatus, readonly string[]>>
export type StatusReason = (typeof STATUS_REASONS)[keyof typeof STATUS_REASONS][number]
export const ALL_STATUS_REASONS: readonly StatusReason[] = Object.values(STATUS_REASONS).flat()

/** Why a run went back to the queue. */
export const RESUME_REASONS = ['continue', 'wake', 'retry'] as const
export type ResumeReason = (typeof RESUME_REASONS)[number]

/** The state of one attempt of a run. */
export const EXECUTION_STATUSES = ['running', 'success', 'failed', 'suspended', 'needs_human'] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

/** A send ledger row: an intent with no result is a send whose outcome is unknown. */
export const SEND_LEDGER_STATUSES = ['intent', 'forwarded', 'failed'] as const
export type SendLedgerStatus = (typeof SEND_LEDGER_STATUSES)[number]

/** The methods a ledger row records: every egress but GET (#1698 1.3). */
export const LEDGER_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
export type LedgerMethod = (typeof LEDGER_METHODS)[number]

/** How a scheduled run treats a run of the same workflow still going (L693). */
export const OVERLAP_RULES = ['skip', 'queue'] as const
export type OverlapRule = (typeof OVERLAP_RULES)[number]

// ── the minute cron (#1949, supabase-ops migration 20261017090000) ──────────

/** What observe mode records for one schedule slot: a fire it would have made, or a slot it reports missed. */
export const OBSERVATION_OUTCOMES = ['would_fire', 'missed'] as const
export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number]

/**
 * Why, by outcome. These are planFires' own reasons (packages/workflow-definition
 * schedule/plan.ts): a type check in tick.ts fails to compile when the two lists
 * differ, and the vocabulary test holds this one to the database.
 */
export const OBSERVATION_REASONS = {
  would_fire: ['due', 'catch_up'],
  missed: ['catch_up_none', 'outside_catch_up_window', 'superseded_by_due_fire'],
} as const satisfies Record<ObservationOutcome, readonly string[]>
export const ALL_OBSERVATION_REASONS: readonly string[] = Object.values(OBSERVATION_REASONS).flat()

/**
 * The maintenance sweeps the tick may claim, each with one owner per interval
 * (#1698 1.4). tombstone_expiry, connection_check and sf_limits were added by
 * #2334 (supabase-ops migration 20261017220000) for the ops connections; the
 * tick runs only those in TICK_SWEEPS (tick.ts), and none of the three yet.
 */
export const OPS_SWEEPS = ['lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits'] as const
export type OpsSweep = (typeof OPS_SWEEPS)[number]

// ── ops connections and the ops Salesforce pool (#2334, supabase-ops migration 20261017220000) ──

/**
 * Whether a connection's copy may be used now, in connectionFetch's order: a
 * tombstone, then withdrawal, then serve_until. connection_copy answers one.
 */
export const CONNECTION_COPY_STATES = ['usable', 'connection_removed', 'connection_withdrawn', 'connection_copy_expired', 'not_found'] as const
export type ConnectionCopyState = (typeof CONNECTION_COPY_STATES)[number]

/**
 * The shown status of a connection, derived by connection_status and nowhere
 * else: needs_reauth while a refresh failure is newer than the last Reconnect,
 * whatever the check says (L53).
 */
export const CONNECTION_STATUSES = ['needs_reauth', 'check_failing', 'healthy', 'unchecked'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

/** Why a Salesforce lease is taken. A step's share is its workflow's; every other purpose has a share of its own. */
export const SF_LEASE_PURPOSES = ['step', 'lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits'] as const
export type SfLeasePurpose = (typeof SF_LEASE_PURPOSES)[number]

/** What acquire_sf_lease answers. Every refusal is named; none is read as no limit. */
export const SF_LEASE_OUTCOMES = [
  'granted',
  'pool_full',
  'workflow_share_full',
  'sf_budget_floor',
  'sf_budget_unmeasured',
  'sf_org_unmeasured',
  'sf_cap_unset',
] as const
export type SfLeaseOutcome = (typeof SF_LEASE_OUTCOMES)[number]

/** Where a budget reading came from: the sf_limits sweep's /limits read, or a response's Sforce-Limit-Info header. */
export const SF_BUDGET_SOURCES = ['limits', 'sforce_limit_info'] as const
export type SfBudgetSource = (typeof SF_BUDGET_SOURCES)[number]
