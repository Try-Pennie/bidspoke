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
 * A FAILURE CARRIES THE NOTED REQUEST (#2163). A timeout fails with
 * withTimeout's own error, which holds no request, so the failure is given the
 * request the node noted, read from the watch, and, when the record is kept,
 * when it expires. The failed step then logs its input, and the capture routes it
 * as held rather than uncapturable.
 *
 * Every non-test run, outside every alert gate: a classified Salesforce outage
 * is exactly when these writes are at risk.
 */
import { encryptSecret, type SecretKeyInput } from '../lib/secret-crypto'
import { formatErr } from '../lib/format-error'
import type { RetryClock } from '../lib/post-response-budget'
import type { ResolvedStepInput } from '../types'

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
  sf_operation: 'update'
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
  operation: 'update'
  body: Record<string, unknown>
}

export type WriteOutcome = 'landed' | 'refused' | 'unknown'

export interface AtRiskKv {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** A record the watch kept for the read-back, and when KV deletes it. */
export interface HeldWrite {
  key: string
  /** ISO. The last write of the record plus its 24 hour expiry. */
  expires_at: string
}

export interface AtRiskWatch {
  /** The request as the node resolved it; called again if the node changes it. */
  note(req: SalesforceRequestNote): void
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
  const text = (k: string) => (typeof v[k] === 'string' && v[k] !== '' ? (v[k] as string) : null)
  const keys = ['org_id', 'workflow_id', 'execution_id', 'step_namespace', 'sf_object', 'sf_record_id', 'body_encrypted', 'first_attempt_at', 'recorded_at'] as const
  if (v.v !== 1 || v.sf_operation !== 'update' || keys.some((k) => text(k) === null)) return null
  if (!Number.isFinite(Date.parse(v.first_attempt_at as string)) || !Number.isFinite(Date.parse(v.recorded_at as string))) return null
  return v as unknown as AtRiskEntry
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

/** What a failure carries when the request it lost came from the watch (#2163). */
interface NotedFailure {
  resolvedInput?: ResolvedStepInput
  /** ISO: when the held record of this request expires. Absent when none is held. */
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
 * (a Salesforce answer, which says more: the url and the template) keeps it and
 * is marked held by nothing here, so a refusal still reaches the replay store.
 *
 * Every watched step settles through runWatched, so this is the one place a
 * timed out update gets its request back, for every node and every workflow.
 */
function carryNotedRequest(err: unknown, noted: SalesforceRequestNote | null, held: HeldWrite | null): unknown {
  if (!noted || !err || typeof err !== 'object') return err
  const failure = err as NotedFailure
  if (failure.resolvedInput) return err
  failure.resolvedInput = {
    // The node's config is not part of the note; the run page shows the request as sent.
    template: null,
    resolved: { operation: noted.operation, object: noted.object, record_id: noted.record_id, body: noted.body },
  }
  if (held) failure.atRiskHeldUntil = held.expires_at
  return err
}

/**
 * When the at-risk record of a failed write expires, if this failure's request
 * came from the watch and the watch kept the record; null otherwise.
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
          body_encrypted: await encryptSecret(JSON.stringify(req.body), opts.keys),
          first_attempt_at: firstAttemptAt,
          recorded_at: new Date(putAt).toISOString(),
        }
        await opts.kv.put(key, JSON.stringify(entry), { expirationTtl: AT_RISK_WRITE_TTL_SECONDS })
        written = true
        writtenAt = putAt
      } catch (e) {
        // The write this guards still goes ahead; the run simply has no record
        // of it, which is the gap this exists to close, so it is said loudly.
        console.error(`[at-risk-writes] could not record the at-risk write of step ${opts.stepNamespace}, execution ${opts.run.executionId}:`, formatErr(e))
      }
    })
  }

  void opts.clock.timer(AT_RISK_AFTER_MS, watching.signal).then(() => {
    if (watching.signal.aborted) return
    due = true
    record()
  })

  return {
    note(req) {
      latest = req
      if (due) record()
    },
    noted() {
      return latest
    },
    async settle(outcome) {
      watching.abort()
      await chain
      if (!written) return null
      if (outcome === 'unknown') {
        return { key, expires_at: new Date(writtenAt + AT_RISK_WRITE_TTL_SECONDS * 1000).toISOString() }
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
