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
