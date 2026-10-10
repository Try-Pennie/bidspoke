// Fires a Slack alert for a single execution AND persists a TLDR snapshot on
// workflow_executions.slack_alert_reason. After the alert is posted (Slack ts
// captured), a Claude call drafts a one-sentence root cause that gets written
// back to .summary and posted as a thread reply.
//
// Three call sites in engine/index.ts use this:
//   - duration threshold breach
//   - failed-status execution
//   - backstop: completed walk that flipped to failed during finalize
//
// All run inside executionCtx.waitUntil — never blocks the HTTP response.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { ErrorType, StepStatus } from '../types'
import { sendDurationAlert, sendFailureAlert, sendThreadReply } from './slack'
import { draftAlertSummary, type AlertSummaryStep } from './alert-summarizer'
import { getAnthropicKey } from './changelog-drafter'
import { isNoRowMatchedError, requireRowsAffected } from './db-retry'
import { failureAlertSignature, failureAlertSuppressed, markFailureAlertSent } from './failure-alert-throttle'

// Minimal slice of Cloudflare's ExecutionContext we actually use. Engine code
// uses a structural alias for the same reason — `ExecutionContext` is also the
// name of an engine-local type and importing the CF one collides.
type CfExecutionContext = { waitUntil: (promise: Promise<unknown>) => void }

// Container step types whose duration is just a roll-up of their children — we
// want the actual slow leaf, not the parent that wraps it.
const CONTAINER_STEP_TYPES = new Set(['parallel', 'parallel_end', 'branch', 'branch_end'])

interface StepLogShape {
  step_namespace: string
  step_node_id?: string
  step_type: string
  duration_ms: number
  status: StepStatus
  error_message?: string
  error_type?: ErrorType | null
  retries_used?: number
}

export interface ExecutionAlertArgs {
  alertType: 'failure' | 'duration'
  supabase: SupabaseClient
  env: Env
  executionCtx: CfExecutionContext
  orgId: string
  slackChannel: string | null
  workflowId: string
  workflowName: string
  executionId: string
  executionStartedAt: string
  durationMs: number
  /** Required when alertType='duration'. */
  thresholdMs?: number
  /** Required when alertType='failure'. */
  failedStep?: string
  /** Required when alertType='failure'. */
  errorMessage?: string
  /** Required when alertType='failure'. */
  errorType?: ErrorType
  timestamp: string
  stepLogQueue: readonly StepLogShape[]
}

/**
 * Best-effort write of alert bookkeeping onto a workflow_executions row.
 *
 * Shared by both alert writes (the pre-send snapshot and the post-send summary
 * attach) so the semantics live in one place. Never throws: the Slack alert
 * matters more than its bookkeeping. The .select('id') makes a zero-row match
 * visible, which is what happens when the execution row is missing entirely
 * (#487) rather than the write being reported as a silent success (#583).
 */
export async function writeExecutionAlertState(
  supabase: SupabaseClient,
  executionId: string,
  executionStartedAt: string,
  patch: Record<string, unknown>,
  operation: string,
): Promise<void> {
  const { error } = await requireRowsAffected(
    `workflow_executions.${operation}`,
    () =>
      supabase
        .from('workflow_executions')
        .update(patch)
        .eq('id', executionId)
        .eq('started_at', executionStartedAt)
        .select('id'),
    { onMiss: 'error', context: { executionId, executionStartedAt, operation } },
  )
  // The zero-row line is the helper's. Only a real database failure is ours.
  if (error && !isNoRowMatchedError(error)) {
    console.error(`[execution-alerts] failed to ${operation}`, { executionId, error: error.message })
  }
}

export async function fireExecutionAlert(args: ExecutionAlertArgs): Promise<void> {
  const bottleneck = pickBottleneck(args)
  if (!bottleneck) return // nothing to alert on (e.g. failure with no logged steps)

  const reason: Record<string, unknown> = {
    step_namespace: bottleneck.step_namespace,
    step_type: bottleneck.step_type,
    step_duration_ms: bottleneck.duration_ms,
  }
  if (args.alertType === 'duration') {
    reason.threshold_ms = args.thresholdMs
  }
  // Retries the failed step burned through before giving up. Read from the
  // logged step (engine now records the real count) so both the Slack message
  // and the persisted snapshot can say "retried N times before failing".
  let retriesUsed: number | undefined
  let failedNodeId: string | undefined
  // Node id of the slowest step, for deep-linking the duration alert to it.
  const bottleneckNodeId = args.stepLogQueue.find(
    (s) => s.step_namespace === bottleneck.step_namespace
  )?.step_node_id
  if (args.alertType === 'failure') {
    reason.error_message = args.errorMessage
    reason.error_type = args.errorType
    const failedLog = args.failedStep
      ? args.stepLogQueue.find((s) => s.step_namespace === args.failedStep && s.status === 'failed')
      : undefined
    failedNodeId = failedLog?.step_node_id
    retriesUsed = failedLog?.retries_used
    if (retriesUsed !== undefined) reason.retries_used = retriesUsed
  }

  // #693: decide burst collapse BEFORE recording the snapshot, so a collapsed run
  // is not recorded as having fired a Slack alert it never sent. Failure path only;
  // the first of each signal pages, a different signal pages on its own, and the
  // claim fails open, so this can never silence a real failure.
  let signature: string | undefined
  let collapsed = false
  if (args.alertType === 'failure') {
    signature = failureAlertSignature(args.workflowId, args.failedStep, args.errorMessage)
    // Suppressed only if a page for this signature already went out this window.
    // failureAlertSuppressed fails open (a KV error reads as not suppressed), so
    // the throttle can never be the reason a real failure goes unalerted.
    collapsed = await failureAlertSuppressed(args.env.IDEMPOTENCY, signature)
  }

  // Persist the snapshot BEFORE sending Slack (even if Slack fails, the banner
  // still renders with the structured fallback). Best-effort: a write failure here
  // should not prevent the alert from going out. slack_alert_fired_at marks that an
  // alert was ATTEMPTED (it is written ahead of the send, so a send that then fails
  // still carries it, as before): a collapsed burst run never attempts a send, so
  // it records the reason (marked collapsed, so the banner still explains the
  // failure) but no fired-at.
  await writeExecutionAlertState(
    args.supabase,
    args.executionId,
    args.executionStartedAt,
    {
      slack_alert_type: args.alertType,
      slack_alert_reason: collapsed ? { ...reason, collapsed_into_burst: true } : reason,
      ...(collapsed ? {} : { slack_alert_fired_at: args.timestamp }),
    },
    'record alert metadata',
  )

  if (collapsed) {
    console.log(`[execution-alerts] failure alert collapsed into an active burst window (${signature})`)
    return
  }

  const handle = args.alertType === 'duration'
    ? await sendDurationAlert(args.supabase, args.orgId, args.slackChannel, {
        workflow_id: args.workflowId,
        workflow_name: args.workflowName,
        execution_id: args.executionId,
        duration_ms: args.durationMs,
        threshold_ms: args.thresholdMs!,
        timestamp: args.timestamp,
        node_id: bottleneckNodeId,
      }, args.env.APP_URL).catch((e) => { console.error('[slack] duration alert failed:', e); return null })
    : await sendFailureAlert(args.supabase, args.orgId, args.slackChannel, {
        workflow_id: args.workflowId,
        workflow_name: args.workflowName,
        execution_id: args.executionId,
        step_namespace: args.failedStep,
        node_id: failedNodeId,
        error_message: args.errorMessage ?? 'Unknown error',
        error_type: args.errorType ?? 'permanent',
        retries_used: retriesUsed,
        timestamp: args.timestamp,
      }, args.env.APP_URL).catch((e) => { console.error('[slack] failure alert failed:', e); return null })

  // #693: open the collapse window ONLY after a page actually went out (handle
  // present), so a failed or unconfigured Slack send never starts a silent window
  // that swallows the rest of the burst. Best-effort; failing to write it just
  // means the next failure of this signature also pages.
  if (args.alertType === 'failure' && handle && signature) {
    await markFailureAlertSent(args.env.IDEMPOTENCY, signature)
  }

  // Claude summary: fire-and-forget. Updates the row + posts a thread reply.
  // Even if no Slack handle (Slack down / not configured), we still try to fill
  // in .summary so the UI banner gets the explanation.
  args.executionCtx.waitUntil(
    summarizeAndAttach({ ...args, bottleneck, reason, handle })
      .catch((e) => console.error('[execution-alerts] summarize failed:', e))
  )
}

async function summarizeAndAttach(args: ExecutionAlertArgs & {
  bottleneck: AlertSummaryStep
  reason: Record<string, unknown>
  handle: Awaited<ReturnType<typeof sendDurationAlert>>
}): Promise<void> {
  const apiKey = await getAnthropicKey(args.env, args.supabase, args.orgId)
  if (!apiKey) return

  const topSteps = pickTopSteps(args.stepLogQueue, 5)
  const summary = await draftAlertSummary(apiKey, {
    alert_type: args.alertType,
    workflow_name: args.workflowName,
    total_duration_ms: args.durationMs,
    threshold_ms: args.thresholdMs,
    bottleneck: args.bottleneck,
    top_steps: topSteps,
  })
  if (!summary) return

  const updatedReason: Record<string, unknown> = { ...args.reason, summary }
  if (args.handle) updatedReason.slack_ts = args.handle.ts

  await writeExecutionAlertState(
    args.supabase,
    args.executionId,
    args.executionStartedAt,
    { slack_alert_reason: updatedReason },
    'attach summary',
  )

  if (args.handle) await sendThreadReply(args.handle, summary)
}

function pickBottleneck(args: ExecutionAlertArgs): AlertSummaryStep | null {
  if (args.alertType === 'failure' && args.failedStep) {
    const hit = args.stepLogQueue.find((s) => s.step_namespace === args.failedStep && s.status === 'failed')
    if (hit) return toSummaryStep(hit)
    return {
      step_namespace: args.failedStep,
      step_type: 'unknown',
      duration_ms: 0,
      status: 'failed',
      error_message: args.errorMessage ?? null,
      error_type: args.errorType ?? null,
    }
  }
  // duration: longest leaf step
  const leaves = args.stepLogQueue.filter((s) => !CONTAINER_STEP_TYPES.has(s.step_type))
  if (leaves.length === 0) return null
  const sorted = [...leaves].sort((a, b) => b.duration_ms - a.duration_ms)
  return toSummaryStep(sorted[0])
}

function pickTopSteps(queue: readonly StepLogShape[], n: number): AlertSummaryStep[] {
  return [...queue]
    .filter((s) => !CONTAINER_STEP_TYPES.has(s.step_type))
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, n)
    .map(toSummaryStep)
}

function toSummaryStep(s: StepLogShape): AlertSummaryStep {
  return {
    step_namespace: s.step_namespace,
    step_type: s.step_type,
    duration_ms: s.duration_ms,
    status: s.status,
    error_message: truncate(s.error_message, 200),
    error_type: s.error_type ?? null,
  }
}

function truncate(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  return s.length <= max ? s : s.slice(0, max) + '…'
}
