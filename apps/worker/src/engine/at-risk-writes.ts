/**
 * Records a post-answer Salesforce write that is still out after 2 seconds
 * (#2022, phase D of #2015).
 *
 * After the answer, the walk keeps writing to Salesforce, and a write can be cut
 * off, time out, or die with its isolate, leaving nobody knowing whether it
 * landed. On 2026-10-13, 8 of 18 such writes checked after a Salesforce slowdown
 * had never landed. So around the whole retry loop of each post-answer update,
 * a watch starts: if the step has not settled 2 s after it started, the request
 * (object, record, body encrypted with SECRET_ENCRYPTION_KEY) is written to KV
 * before anything else, for the read-back (#2023) to find.
 *
 * WHY 2 SECONDS, NOT BEFORE EVERY CALL. About 100k post-answer writes a day
 * settle in roughly 100 ms; recording each ahead of the call would cost a KV
 * write and delete per write. The gap this leaves (an isolate dying inside a
 * write's first 2 s) is measured after launch: runs degraded with no entry.
 *
 * ON SETTLE. Landed clears the record. A definite refusal clears it too, because
 * the failed write is kept in the #1993 store and paged there. Anything else (a
 * timeout, an abort, a 5xx, no settle at all) leaves it, unknown, for the
 * read-back. Entries expire after 24 hours, which is also their erasure bound;
 * the key rotation must wait that long before dropping an old key.
 *
 * ONE OWNER PER WRITE (#468). A kept record says whether the read-back owns it
 * (readBackOwnsHeld, the rule the read-back classifies by). One it owns is never
 * also stored in the #1993 store, whatever the failure carried; one it does not
 * own is stored there, since nothing reads it back.
 *
 * A FAILURE CARRIES THE NOTED REQUEST (#2163). A timeout fails with
 * withTimeout's own error, which holds no request, so the failure is given the
 * request the node noted, read from the watch, and, when the record is kept,
 * when it expires. The failed step then logs its input, and the capture routes it
 * as held rather than uncapturable.
 *
 * Every non-test run, outside every alert gate: a classified Salesforce outage
 * is exactly when these writes are at risk.
 *
 * A CREDIT INQUIRY POST IS RECORDED BEFORE IT IS SENT (#2172, Dan's D5 on #1680).
 * Each such Apex call attaches a new file to the Lead, so it is never resent
 * blind, and an isolate cancelled inside the first 2 s would otherwise leave no
 * trace of it. Its watch records it at once (recordNow), and the node waits for that record
 * before the call goes out; a confirmed answer clears it, as for an update. It
 * is one call a lead (about 3,100 a day), so a KV write and delete each is cheap.
 */
import { encryptSecret, type SecretKeyInput } from '../lib/secret-crypto'
import { formatErr } from '../lib/format-error'
import type { RetryClock } from '../lib/post-response-budget'
import type { ResolvedStepInput } from '../types'
import { CREDIT_INQUIRY_APEX_PATH } from './inquiry-post'
import { readBackOwns } from './write-marker'

export const AT_RISK_WRITE_PREFIX = 'at-risk-write:'
/** The entry's lifetime, and so its erasure bound and the key rotation's wait. */
export const AT_RISK_WRITE_TTL_SECONDS = 24 * 60 * 60
/** How long a write may be out before it is recorded. */
export const AT_RISK_AFTER_MS = 2000

export interface AtRiskEntry {
  v: 1
  org_id: string
  workflow_id: string
  execution_id: string
  step_namespace: string
  sf_object: string
  sf_record_id: string
  /** An update, or the credit inquiry post (#2172), whose record is the Submission it names. */
  sf_operation: 'update' | 'apex'
  /** apex only: the endpoint, always the credit inquiry post. */
  apex_path?: string
  body_encrypted: string
  /** When the step started, ISO: the order the read-back merges entries for one record in. */
  first_attempt_at: string
  /** When this entry was written, ISO. */
  recorded_at: string
}

/** What the Salesforce node reports as it sends (and again when it changes the body). */
export interface SalesforceRequestNote {
  object: string
  record_id: string
  operation: 'update' | 'apex'
  /** apex only: the credit inquiry post's endpoint. */
  apex_path?: string
  body: Record<string, unknown>
}

export type WriteOutcome = 'landed' | 'refused' | 'unknown'

export interface AtRiskKv {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** A record the watch kept, when KV deletes it, and whether the read-back judges it. */
export interface HeldWrite {
  key: string
  /** ISO. The last write of the record plus its 24 hour expiry. */
  expires_at: string
  /**
   * Whether the Salesforce read-back (#2023) owns the record as written
   * (readBackOwnsHeld): it reads the record back and resends it, so nothing else
   * may also keep the write to send (#468).
   */
  read_back_owns: boolean
}

export interface AtRiskWatch {
  /** The request as the node resolved it; called again if the node changes it. */
  note(req: SalesforceRequestNote): void
  /**
   * The request, recorded at once rather than after 2 s: a credit inquiry post
   * (#2172). Resolves once the record is written (or failed, said in the log),
   * so the node sends after it.
   */
  recordNow(req: SalesforceRequestNote): Promise<void>
  /** The latest request the node noted, or null when it noted none. */
  noted(): SalesforceRequestNote | null
  /**
   * The step settled. Waits for any record in progress, then clears it unless
   * unknown. Returns the record when it is kept, or null when none is.
   */
  settle(outcome: WriteOutcome): Promise<HeldWrite | null>
}

export const atRiskKey = (executionId: string, stepNamespace: string): string =>
  `${AT_RISK_WRITE_PREFIX}${executionId}:${stepNamespace}`

/**
 * A record as the watch wrote it, or null for anything else (gone, or not this
 * shape). Read by the Salesforce read-back (#2023), which never acts on a record
 * it cannot fully read.
 */
export function parseAtRiskEntry(raw: string | null): AtRiskEntry | null {
  if (!raw) return null
  let v: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    v = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const text = (k: string): string | null => {
    const value = v[k]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const keys = ['org_id', 'workflow_id', 'execution_id', 'step_namespace', 'sf_object', 'sf_record_id', 'body_encrypted', 'first_attempt_at', 'recorded_at'] as const
  // An apex record is read only for the credit inquiry post (#2172), the one Apex
  // call the read-back knows how to judge.
  const operationOk = v.sf_operation === 'update' || (v.sf_operation === 'apex' && v.apex_path === CREDIT_INQUIRY_APEX_PATH)
  if (v.v !== 1 || !operationOk || keys.some((k) => text(k) === null)) return null
  if (!Number.isFinite(Date.parse(v.first_attempt_at as string)) || !Number.isFinite(Date.parse(v.recorded_at as string))) return null
  return v as unknown as AtRiskEntry
}

/**
 * Whether the Salesforce read-back (#2023) judges a held record: a credit inquiry
 * post always (#2172), and an update only when its body carries this step's own
 * engine stamp on an object with the marker field (readBackOwns). The one rule
 * the read-back classifies its records by and the watch reports a kept record
 * by, so a write the read-back resends is never also stored for the replay or
 * the drain (#468), and one it ignores always is.
 */
export function readBackOwnsHeld(
  held: Pick<AtRiskEntry, 'sf_operation' | 'apex_path' | 'sf_object' | 'execution_id' | 'step_namespace'>,
  body: unknown,
): boolean {
  if (held.sf_operation === 'apex') return held.apex_path === CREDIT_INQUIRY_APEX_PATH
  return readBackOwns(held.sf_object, body, held.execution_id, held.step_namespace)
}

/**
 * A definite refusal is Salesforce answering 4xx (not 429) and the node marking
 * it permanent: the write did not land, and the #1993 store holds it. Anything
 * without that answer may have reached Salesforce, so it is unknown.
 */
export function outcomeOfFailedWrite(err: unknown): WriteOutcome {
  if (!err || typeof err !== 'object') return 'unknown'
  const e = err as { permanent?: unknown; status?: unknown; mayHaveLanded?: unknown }
  // A refusal whose own resend (the email recovery) got no clean answer may have
  // landed after all.
  if (e.mayHaveLanded === true) return 'unknown'
  return e.permanent === true && typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429
    ? 'refused'
    : 'unknown'
}

/**
 * Starts a step's watch, or none: a watch that cannot start leaves the write
 * running unwatched, said in the log, rather than failing a write it was only
 * meant to guard.
 */
export function startWatchSafely(start: ((stepNamespace: string) => AtRiskWatch) | undefined, stepNamespace: string): AtRiskWatch | null {
  if (!start) return null
  try {
    return start(stepNamespace)
  } catch (e) {
    console.error(`[at-risk-writes] could not start the watch on step ${stepNamespace}, so it runs unrecorded:`, formatErr(e))
    return null
  }
}

/**
 * Runs one post-answer Salesforce step under its watch: the node's request hook
 * points at the watch while the whole retry loop runs, and the outcome settles
 * it. With no watch the step simply runs.
 *
 * The hook is one slot on the run's context, which holds because only the
 * walk's own sequential step loop runs watched steps: a parallel node's children
 * run their own loop, unwatched, while the walk waits on them, so two watched
 * steps never overlap. A post-answer update inside a parallel node is therefore
 * NOT recorded; none is live.
 */
export async function runWatched<T>(
  watch: AtRiskWatch | null,
  setNote: (note: AtRiskWatch['note'] | undefined) => void,
  work: () => Promise<T>,
  /** How many times the step was retried. Only a transient failure is retried. */
  retries: () => number,
): Promise<T> {
  if (!watch) return work()
  setNote(watch.note)
  try {
    const result = await work()
    await watch.settle('landed')
    return result
  } catch (e) {
    // A retry means an earlier attempt failed transiently and may have landed,
    // so a later refusal cannot clear the record: it is unknown.
    const outcome = outcomeOfFailedWrite(e)
    const held = await watch.settle(outcome === 'refused' && retries() > 0 ? 'unknown' : outcome)
    throw carryNotedRequest(e, watch.noted(), held)
  } finally {
    setNote(undefined)
  }
}

/**
 * What a failure carries: its request (put there from the watch when the failure
 * lost it, #2163), and when the held record of that request expires. The expiry
 * is set in two cases (carryNotedRequest): a failure whose request came from the
 * watch (a timeout) whenever a record is held, and, since #468, a failure that
 * keeps its own executor request (a Salesforce answer after the 2 s mark) when
 * the read-back owns the kept record. A held credit inquiry post (#2172) is
 * always owned, so it is the second case too. Its presence is what keeps the
 * capture from storing a pending row for the replay or the drain beside the
 * read-back.
 */
interface NotedFailure {
  resolvedInput?: ResolvedStepInput
  /** ISO: when the held record of this request expires. Absent when none is held, and on an executor's own request whose record the read-back does not own. */
  atRiskHeldUntil?: string
}

/**
 * Puts the request the node noted onto a failure that carries none of its own
 * (#2163). A timeout is the case that matters: withTimeout's own error wins the
 * race against the executor's, so it never carried the request the executor
 * built, and the failed step logged no input while the capture reported the
 * write as uncapturable. An abort or a dropped connection fails the same way.
 *
 * Read from the watch, which is the request's one home: nothing keeps a second
 * copy beside the record. A failure that already carries its executor's request
 * (a Salesforce answer, which says more: the url and the template) keeps it,
 * and is marked held only when the read-back owns the kept record (#468): then
 * the read-back is the write's one sender, and the capture stores no pending row
 * for the replay or the drain to send again. A record the read-back does not
 * own (no stamp of this step's, or an object with no marker field) is marked
 * held by nothing here, so the replay store still keeps the write. A credit
 * inquiry post (#2172) is always the read-back's, a 500 included.
 *
 * Every watched step settles through runWatched, so this is the one place a
 * timed out update or credit inquiry post gets its request back, for every node
 * and every workflow.
 */
function carryNotedRequest(err: unknown, noted: SalesforceRequestNote | null, held: HeldWrite | null): unknown {
  if (!noted || !err || typeof err !== 'object') return err
  const failure = err as NotedFailure
  if (failure.resolvedInput) {
    // A record the read-back owns is the write's one sender, so the failure says
    // it is held whoever built its request (a 5xx after a retry, a refusal after a
    // retry, a bulkhead shed past the 2 s mark), and the capture leaves it to the
    // read-back rather than also storing it for the replay or the drain (#468).
    // That covers a credit inquiry post (#2172), which the read-back always owns.
    if (held?.read_back_owns) failure.atRiskHeldUntil = held.expires_at
    return err
  }
  failure.resolvedInput = {
    // The node's config is not part of the note; the run page shows the request as sent.
    template: null,
    resolved: {
      operation: noted.operation,
      object: noted.object,
      record_id: noted.record_id,
      body: noted.body,
      ...(noted.apex_path ? { apex_path: noted.apex_path } : {}),
    },
  }
  if (held) failure.atRiskHeldUntil = held.expires_at
  return err
}

/**
 * When the at-risk record of a failed write expires, if the watch kept the
 * record and either this failure's request came from the watch or the read-back
 * owns the record (#468; a credit inquiry post always, #2172); null otherwise.
 */
export function heldUntilOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const until = (err as NotedFailure).atRiskHeldUntil
  return typeof until === 'string' ? until : null
}

export function startAtRiskWatch(opts: {
  kv: AtRiskKv
  keys: SecretKeyInput
  clock: RetryClock
  run: { orgId: string; workflowId: string; executionId: string }
  stepNamespace: string
}): AtRiskWatch {
  const key = atRiskKey(opts.run.executionId, opts.stepNamespace)
  const firstAttemptAt = new Date(opts.clock.now()).toISOString()
  const watching = new AbortController()
  let due = false
  let written = false
  // When the last successful write of the record began, which starts its expiry.
  // Taken before the put, so the stated expiry is never later than KV's own.
  let writtenAt = 0
  // The request the record holds now: the last one whose write went through.
  let writtenReq: SalesforceRequestNote | null = null
  let latest: SalesforceRequestNote | null = null
  // Records run one after another, so a rewrite never races the first write.
  let chain: Promise<void> = Promise.resolve()

  const record = () => {
    const req = latest
    if (!req) return
    chain = chain.then(async () => {
      try {
        const putAt = opts.clock.now()
        const entry: AtRiskEntry = {
          v: 1,
          org_id: opts.run.orgId,
          workflow_id: opts.run.workflowId,
          execution_id: opts.run.executionId,
          step_namespace: opts.stepNamespace,
          sf_object: req.object,
          sf_record_id: req.record_id,
          sf_operation: req.operation,
          ...(req.apex_path ? { apex_path: req.apex_path } : {}),
          body_encrypted: await encryptSecret(JSON.stringify(req.body), opts.keys),
          first_attempt_at: firstAttemptAt,
          recorded_at: new Date(putAt).toISOString(),
        }
        await opts.kv.put(key, JSON.stringify(entry), { expirationTtl: AT_RISK_WRITE_TTL_SECONDS })
        written = true
        writtenAt = putAt
        writtenReq = req
      } catch (e) {
        // The write this guards still goes ahead; the run simply has no record
        // of it, which is the gap this exists to close, so it is said loudly.
        console.error(`[at-risk-writes] could not record the at-risk write of step ${opts.stepNamespace}, execution ${opts.run.executionId}:`, formatErr(e))
      }
    })
  }

  void opts.clock.timer(AT_RISK_AFTER_MS, watching.signal).then(() => {
    // Already recorded at its note (a credit inquiry post): nothing more to write.
    if (watching.signal.aborted || due) return
    due = true
    record()
  })

  return {
    note(req) {
      latest = req
      if (due) record()
    },
    recordNow(req) {
      // A credit inquiry post is recorded before it is sent (see the header), and
      // the caller waits for the record.
      latest = req
      due = true
      record()
      return chain
    },
    noted() {
      return latest
    },
    async settle(outcome) {
      watching.abort()
      await chain
      if (!written || !writtenReq) return null
      if (outcome === 'unknown') {
        // Judged on the request the record holds, by the read-back's own rule.
        const readBackOwnsIt = readBackOwnsHeld(
          {
            sf_operation: writtenReq.operation,
            apex_path: writtenReq.apex_path,
            sf_object: writtenReq.object,
            execution_id: opts.run.executionId,
            step_namespace: opts.stepNamespace,
          },
          writtenReq.body,
        )
        return { key, expires_at: new Date(writtenAt + AT_RISK_WRITE_TTL_SECONDS * 1000).toISOString(), read_back_owns: readBackOwnsIt }
      }
      try {
        await opts.kv.delete(key)
      } catch (e) {
        // A record left behind reads as unknown to the read-back, which then
        // finds the write landed: safe, but said.
        console.error(`[at-risk-writes] could not clear the at-risk record of step ${opts.stepNamespace}, execution ${opts.run.executionId}:`, formatErr(e))
      }
      // Settled as landed or refused, which is not held, whether or not the
      // delete went through.
      return null
    },
  }
}
