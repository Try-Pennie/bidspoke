/**
 * Captures a failed post-answer Salesforce write for replay (#1993).
 *
 * When a Salesforce write after the answer failed, the dead letter only counted
 * the loss and alerted: nothing kept what should have been written, and the exact
 * patch cannot be rebuilt from anything else the run keeps. The failed step now
 * carries the request its executor resolved (#1992); this stores it, encrypted, in
 * `outcome_writeback_deadletters`, for the replay tool (#471) and the drain (#468).
 *
 * Only what a replay could resend is stored: a Salesforce `update` with an object,
 * a record id and a body. Anything else from a Salesforce step is dead-lettered as
 * uncapturable instead, so a row in the store always means "this can be resent"
 * and the gap is counted rather than silent. A step that is not a Salesforce
 * write is left alone: nothing replays it.
 *
 * The body and the failure text are encrypted with SECRET_ENCRYPTION_KEY: the
 * patch carries lead fields, and a Salesforce 4xx echoes field values back.
 *
 * The row is written through `writeOutcome`, the durable outcome path, so a slow
 * database is retried and an unanswered insert is read back by the minute sweep
 * rather than lost (#1880). A failure classed permanent is stored not replayable,
 * so the replay refuses to resend a write Salesforce will refuse again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ErrorType, ResolvedStepInput } from '../types'
import { encryptSecret, type SecretKeyInput } from '../lib/secret-crypto'
import { formatErr } from '../lib/format-error'
import { recordOutcomeDeadLetter, writeOutcome, type OutcomeAlertDeps } from './durability'

/** The durable path's label for the store's insert. */
export const WRITEBACK_STORE_LABEL = 'outcome_writeback_deadletters.insert'

/** A Salesforce step's failure the store could not hold, counted and alerted on. */
export const WRITEBACK_UNCAPTURABLE_LABEL = 'outcome_writeback_deadletters.uncapturable'

/** The operations a replay can resend. Post-answer writes are updates today (#2015). */
const REPLAYABLE_OPERATIONS = new Set(['update'])

export type WritebackRow =
  | { ok: true; sf_object: string; sf_record_id: string; sf_operation: string; body: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * What a failed step's resolved request holds for replay, or why it holds
 * nothing a replay could resend.
 */
export function writebackFromFailure(nodeType: string, resolvedInput: ResolvedStepInput | null | undefined): WritebackRow {
  if (nodeType !== 'salesforce') return { ok: false, reason: 'not_salesforce' }
  const r = resolvedInput?.resolved
  if (!r || typeof r !== 'object') return { ok: false, reason: 'the failed step carried no resolved request' }
  const req = r as Record<string, unknown>
  const operation = typeof req.operation === 'string' ? req.operation : ''
  if (!REPLAYABLE_OPERATIONS.has(operation)) return { ok: false, reason: `a ${operation || 'missing'} operation cannot be replayed, only an update` }
  const object = typeof req.object === 'string' ? req.object.trim() : ''
  if (!object) return { ok: false, reason: 'the request named no Salesforce object' }
  const recordId = typeof req.record_id === 'string' ? req.record_id.trim() : ''
  if (!recordId) return { ok: false, reason: 'the request named no record id' }
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'the request carried no body' }
  return { ok: true, sf_object: object, sf_record_id: recordId, sf_operation: operation, body: body as Record<string, unknown> }
}

export interface FailedWriteback {
  orgId: string
  workflowId: string
  workflowName: string
  executionId: string
  stepNamespace: string
  nodeType: string
  errorType: ErrorType | null
  error: unknown
  resolvedInput: ResolvedStepInput | null | undefined
  isTest: boolean
}

export type CaptureDeps = Pick<OutcomeAlertDeps, 'kv' | 'orgId' | 'appUrl' | 'timing' | 'run' | 'claims'> & {
  supabase: SupabaseClient
  encryptionKeys: SecretKeyInput
}

export type CaptureResult =
  | { kind: 'stored' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'uncapturable'; reason: string }
  | { kind: 'store_failed'; error: string }

/** Stores a failed post-answer Salesforce write, or says why it did not. Never throws. */
export async function captureFailedWriteback(f: FailedWriteback, deps: CaptureDeps): Promise<CaptureResult> {
  if (f.isTest) return { kind: 'skipped', reason: 'test run' }
  const w = writebackFromFailure(f.nodeType, f.resolvedInput)
  if (!w.ok) {
    if (w.reason === 'not_salesforce') return { kind: 'skipped', reason: w.reason }
    await recordOutcomeDeadLetter(WRITEBACK_UNCAPTURABLE_LABEL, new Error(`${f.stepNamespace}: ${w.reason}`), deps, {
      workflow_id: f.workflowId,
      workflow_name: f.workflowName,
      execution_id: f.executionId,
      at: new Date().toISOString(),
    }).catch((e) => console.error(`[writeback-deadletter] ${WRITEBACK_UNCAPTURABLE_LABEL} dead letter failed:`, formatErr(e)))
    return { kind: 'uncapturable', reason: w.reason }
  }
  try {
    const row = {
      organization_id: f.orgId,
      workflow_id: f.workflowId,
      execution_id: f.executionId,
      step_namespace: f.stepNamespace,
      sf_object: w.sf_object,
      sf_record_id: w.sf_record_id,
      sf_operation: w.sf_operation,
      body_encrypted: await encryptSecret(JSON.stringify(w.body), deps.encryptionKeys),
      error_encrypted: await encryptSecret(formatErr(f.error), deps.encryptionKeys),
      error_type: f.errorType,
      replayable: f.errorType !== 'permanent',
    }
    const { error } = await writeOutcome(
      WRITEBACK_STORE_LABEL,
      async () => {
        const res = await deps.supabase.from('outcome_writeback_deadletters').insert(row)
        return { error: res.error }
      },
      deps,
      {
        kind: 'writeback_deadletter_present',
        execution_id: f.executionId,
        sf_object: w.sf_object,
        sf_record_id: w.sf_record_id,
        sf_operation: w.sf_operation,
      },
    )
    return error ? { kind: 'store_failed', error: formatErr(error) } : { kind: 'stored' }
  } catch (e) {
    // Encryption or the client threw: the write never reached the durable path,
    // so it is dead-lettered here rather than lost in silence (L13).
    await recordOutcomeDeadLetter(WRITEBACK_STORE_LABEL, e, deps).catch(() => {})
    return { kind: 'store_failed', error: formatErr(e) }
  }
}
