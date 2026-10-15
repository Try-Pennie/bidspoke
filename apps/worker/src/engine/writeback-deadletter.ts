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
 * rather than lost (#1880). A write Salesforce rejected is stored not replayable,
 * so the replay refuses to resend a write Salesforce will refuse again. Rejected
 * is decided by the replay tool's own rule, imported (#2054): a login refused even
 * after a fresh one, or a permission refusal, is a fault on our side that fixing
 * the credentials clears, so it is kept pending to replay, as the replay keeps it.
 *
 * An update that timed out or was cut off is none of these (#2163): its outcome
 * is unknown and the at-risk record (#2022) holds its request in KV. It is not
 * stored here and never called uncapturable. Until the read-back (#2023) ships
 * it is announced with the record, the field names and the expiry, on every
 * object.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ErrorType, ResolvedStepInput } from '../types'
import { encryptSecret, type SecretKeyInput } from '../lib/secret-crypto'
import { formatErr } from '../lib/format-error'
import { isDuplicateError } from '../lib/db-retry'
import { recordOutcomeDeadLetter, writeOutcome, type OutcomeAlertDeps } from './durability'
import { WRITEBACK_UNCAPTURABLE_LABEL, WRITEBACK_STORE_LABEL, WRITEBACK_HELD_LABEL } from './dead-letter-labels'
import { salesforceRejectedTheWrite, type SalesforceAnswer } from './nodes/salesforce'

/** The durable path's label for the store's insert, declared in the leaf label module (#2084). */
export { WRITEBACK_STORE_LABEL }

/** A timed out or cut off update whose request the at-risk watch holds, on any object, declared in the leaf label module (#2163). */
export { WRITEBACK_HELD_LABEL }

/**
 * The objects whose held updates the read-back (#2023) is built to confirm by
 * their write marker. Until it ships, nothing reads any held update back, so
 * every one is announced (#2163), these included: a wrong alert swapped for no
 * alert would be the worse failure. These also get a log line naming the record.
 * When #2023 ships it takes these entries over, and this announcement goes for
 * the objects it covers.
 */
const READ_BACK_OBJECTS: ReadonlySet<string> = new Set(['Submission__c'])

/**
 * A Salesforce step's failure the store could not hold, counted and alerted on.
 * Declared in the leaf label module, so the alert copy can route on it without
 * an import cycle (#835), and re-exported here for the callers that import it.
 */
export { WRITEBACK_UNCAPTURABLE_LABEL }

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
  /**
   * When the at-risk record holding this request expires (#2163), set only when
   * the request came from the watch because the failure carried none of its own
   * (a timeout, an abort, a dropped connection) and the watch kept the record.
   */
  heldUntil?: string | null
  /**
   * Salesforce's answer to the write (#2054), absent when it gave none: a timeout,
   * a dropped connection, or a fresh login the token endpoint refused.
   */
  salesforceAnswer?: SalesforceAnswer | null
  isTest: boolean
}

/**
 * Whether the failed write is stored already refused (#2054): only when Salesforce
 * answered the write and rejected it, by the rule the replay tool (#471) closes a
 * held write on, imported so the two cannot disagree. No answer is not a refusal,
 * there as here. A failure the engine classed transient is not refused either: a
 * node can name an error code worth retrying (`transient_errors`) that the shared
 * rule does not know about.
 */
function storedRefused(f: FailedWriteback): boolean {
  const answer = f.salesforceAnswer
  return f.errorType === 'permanent' && answer != null && salesforceRejectedTheWrite(answer.status, answer.text)
}

export type CaptureDeps = Pick<OutcomeAlertDeps, 'kv' | 'orgId' | 'appUrl' | 'timing' | 'run' | 'claims'> & {
  supabase: SupabaseClient
  encryptionKeys: SecretKeyInput
}

export type CaptureResult =
  | { kind: 'stored' }
  | { kind: 'held'; until: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'uncapturable'; reason: string }
  | { kind: 'store_failed'; error: string }

/**
 * A held update expires unread, so it is announced with what a person needs to
 * check it: the record, the field names (never the values), and when the held
 * request is deleted. A Submission__c one, which the read-back (#2023) will take
 * over, is also logged.
 */
async function announceHeld(
  f: FailedWriteback,
  w: Extract<WritebackRow, { ok: true }>,
  until: string,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  if (READ_BACK_OBJECTS.has(w.sf_object)) {
    console.warn(`[writeback-deadletter] held for the read-back: execution ${f.executionId}, step ${f.stepNamespace}, ${w.sf_object} ${w.sf_record_id}, until ${until}`)
  }
  await recordOutcomeDeadLetter(WRITEBACK_HELD_LABEL, f.error, deps, {
    workflow_id: f.workflowId,
    workflow_name: f.workflowName,
    execution_id: f.executionId,
    at: new Date().toISOString(),
    held: {
      step: f.stepNamespace,
      sf_object: w.sf_object,
      sf_record_id: w.sf_record_id,
      fields: Object.keys(w.body),
      until,
    },
  }).catch((e) =>
    console.error(
      `[writeback-deadletter] ${WRITEBACK_HELD_LABEL} dead letter failed for execution ${f.executionId}, step ${f.stepNamespace}, ${w.sf_object} ${w.sf_record_id}:`,
      formatErr(e),
    ),
  )
  return { kind: 'held', until }
}

/** Stores a failed post-answer Salesforce write, or says why it did not. Never throws. */
export async function captureFailedWriteback(f: FailedWriteback, deps: CaptureDeps): Promise<CaptureResult> {
  if (f.isTest) return { kind: 'skipped', reason: 'test run' }
  const w = writebackFromFailure(f.nodeType, f.resolvedInput)
  // An update that timed out or was cut off has an unknown outcome, and the
  // at-risk record already holds its request (#2163). It is neither a refusal
  // for this store nor unreplayable, and storing it here would keep a second
  // copy of a request that has one home.
  if (w.ok && f.heldUntil) return announceHeld(f, w, f.heldUntil, deps)
  if (!w.ok) {
    if (w.reason === 'not_salesforce') return { kind: 'skipped', reason: w.reason }
    await recordOutcomeDeadLetter(WRITEBACK_UNCAPTURABLE_LABEL, new Error(`${f.stepNamespace}: ${w.reason}`), deps, {
      workflow_id: f.workflowId,
      workflow_name: f.workflowName,
      execution_id: f.executionId,
      at: new Date().toISOString(),
    }).catch((e) =>
      console.error(
        `[writeback-deadletter] ${WRITEBACK_UNCAPTURABLE_LABEL} dead letter failed for execution ${f.executionId}, step ${f.stepNamespace}:`,
        formatErr(e),
      ),
    )
    return { kind: 'uncapturable', reason: w.reason }
  }
  try {
    const refused = storedRefused(f)
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
      // A write Salesforce rejected is stored already refused and finished: the
      // replay leaves it, a person can still read it, and the 30 day retention
      // reaches it rather than keeping its lead fields for ever.
      replayable: !refused,
      status: refused ? 'refused' : 'pending',
      finished_at: refused ? new Date().toISOString() : null,
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
        step_namespace: f.stepNamespace,
        sf_object: w.sf_object,
        sf_record_id: w.sf_record_id,
        sf_operation: w.sf_operation,
      },
    )
    // A retried insert that meets its own earlier row (an attempt that landed but
    // timed out) is already stored, never a loss.
    if (error && !isDuplicateError(error)) return { kind: 'store_failed', error: formatErr(error) }
    return { kind: 'stored' }
  } catch (e) {
    // Encryption or the client threw: the write never reached the durable path,
    // so it is dead-lettered here rather than lost in silence (L13). When the
    // dead letter fails too, the log line is the last trace, so it names the run.
    await recordOutcomeDeadLetter(WRITEBACK_STORE_LABEL, e, deps, {
      workflow_id: f.workflowId,
      workflow_name: f.workflowName,
      execution_id: f.executionId,
      at: new Date().toISOString(),
    }).catch((d) =>
      console.error(
        `[writeback-deadletter] ${WRITEBACK_STORE_LABEL} dead letter failed for execution ${f.executionId}, step ${f.stepNamespace}:`,
        formatErr(d),
        'after:',
        formatErr(e),
      ),
    )
    return { kind: 'store_failed', error: formatErr(e) }
  }
}
