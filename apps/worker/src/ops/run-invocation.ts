/**
 * Run invocation (#1950, track B3 of the #1698 run engine): one claimed run,
 * from its start to the end of its claim, with a lease kept alive by a
 * heartbeat, every send fenced and ledgered, and every wait given a deadline.
 *
 * The database half is the ops run engine's functions (supabase-ops migration
 * 20261016200000_run_engine_1948.sql and the two after it): the claim token and
 * state_version fence start, extend, the send intent and complete; the lease
 * sweep sends a lapsed run with any non idempotent ledger row to needs_human
 * (lease_expired_after_send). This module is the Worker half that drives them.
 *
 * THE LEASE (#1698 D3). The claim gives RUN_LEASE_SECONDS. Right after the
 * start, and then every HEARTBEAT_EVERY_MS from the start of the beat before
 * (a fixed rate, so a slow renewal does not push the next one late), the
 * heartbeat renews it with the claim token. An answer of false means the run
 * is no longer this holder's. A renewal that fails or passes its deadline is
 * not taken as lost at once, since it may have landed; but once the lease this
 * holder last CONFIRMED has passed on this Worker's clock, it is. Either way
 * the body is told to stop (ctx.signal), every later send is refused before
 * its intent, a send in flight is aborted, and nothing is completed: the run
 * is the lease sweep's now, which judges it by its ledger rows.
 *
 * A SEND (#1698 1.3, L33, L561). Every egress of a run goes through ctx.send:
 *  - a GET is forwarded with a deadline and no ledger row;
 *  - any other method writes its intent row first, fenced by the claim token
 *    and the state version start answered (a holder whose run was re-claimed
 *    is answered stale and forwards nothing, #1698 D2), then forwards with a
 *    deadline, then marks the row forwarded (with the status) or failed (when
 *    the answer proves nothing was applied: not sent, a 429, a requeue with no
 *    request made).
 * A forward that passes SEND_DEADLINE_MS is aborted, and one that throws may
 * have landed either way (L766), so its row is left an intent, which is the
 * ledger's unknown, and the run ends needs_human with send_outcome_unknown,
 * never retried automatically (lessons audit L110 on discussion #1945). A non
 * idempotent send answered 503 with Retry-After ends the same way, because the
 * service may have applied it before answering; a 429 does not (#2337, comment
 * of 2026-10-22). A send declared idempotent (its partner honours the attempt
 * key) is retried instead in each of those cases.
 *
 * THE STEP REQUEST ID. stepRequestId derives one id from the run, the node and
 * the send's sequence, the same on every attempt of the run, so a resend after
 * a lost answer carries the id of the first (Snowflake's requestId with
 * retry=true then runs the statement at most once, #2337). It is recorded as
 * the ledger row's attempt key.
 *
 * HOW THE RUN ENDS. The first answer that decides the run (a lost claim, an
 * unknown send, a requeue) holds, whatever the body returns after it: a body
 * that catches the error and says done is still needs_human. A run that has
 * made a non idempotent send is never retried or requeued, since a new attempt
 * starts the graph again and would send it twice (#1698 D5): it ends failed.
 * Before any such send, a body that throws is retried; the database ends it
 * dead at max_attempts.
 *
 * DEADLINES. Every wait here is bounded on the injected clock (L524): each
 * database call by RUN_DB_DEADLINE_MS, each forward by SEND_DEADLINE_MS, which
 * is shorter than the lease. callOpsRpc bounds the live calls too; the bound
 * here holds whatever the database port is.
 */
import { formatErr } from '../lib/format-error'
import type { RequeueCause } from './connections/refusals'
import {
  OPS_RPC_DEADLINE_MS, OpsClaimLostError,
  type ClaimedRun, type CompleteOutcome, type CompletedRun, type SendIntent, type SendIntentResult, type StartedRun,
} from './ops-writes'
import { LEDGER_METHODS, RESOURCE_WAIT_CAUSES, type HolderFailedReason, type LedgerMethod, type ResourceWaitCause } from './run-vocabulary'

/** The lease a claim gives and each renewal extends (#1698 D3, about 60 s from spike 0). */
export const RUN_LEASE_SECONDS = 60
/** How often the heartbeat renews it: three renewals inside one lease. */
export const HEARTBEAT_EVERY_MS = 20_000
/** Each database call of a run, the heartbeat's included: the ops RPC deadline, past the database's own 8 s. */
export const RUN_DB_DEADLINE_MS = OPS_RPC_DEADLINE_MS
/** One forward, shorter than the lease, so a hung partner reads as unknown, never as slow (L110). */
export const SEND_DEADLINE_MS = 45_000
/** How many times complete, and a send's result, are tried. Each is safe to repeat. */
const WRITE_TRIES = 3

/** The ops database as a run uses it, each call bound to this run's organization. The live one wraps ops-writes.ts. */
export interface RunDb {
  start(run: ClaimedRun, executionId: string): Promise<StartedRun>
  extend(run: ClaimedRun, leaseSeconds: number): Promise<boolean>
  recordIntent(run: ClaimedRun, intent: Omit<SendIntent, 'runRequestId' | 'claimToken'>): Promise<SendIntentResult>
  recordResult(run: ClaimedRun, ledgerId: string, result: { status: 'forwarded' | 'failed'; responseStatus?: number }): Promise<'recorded' | 'already_recorded' | 'not_found'>
  complete(run: ClaimedRun, end: CompleteOutcome): Promise<CompletedRun>
}

/** A clock whose timer resolves after ms, or at once when the signal aborts (the RetryClock shape). */
export interface RunClock {
  now(): number
  timer(ms: number, signal: AbortSignal): Promise<void>
}

export interface RunInvocationDeps {
  db: RunDb
  clock: RunClock
  /** A UUIDv7 for the execution row (packages/uuidv7). */
  newExecutionId(): string
  /** One line per event, names and counts only, never a payload (L658). */
  log(event: Record<string, string | number | boolean | null>): void
}

/** What a forward answered. */
export type ForwardAnswer<T> =
  /** The service answered: forwarded, whatever the status. */
  | { kind: 'answered'; status: number; value: T }
  /**
   * Try again at notBefore. status is the HTTP status that said so (429, or a
   * 503 with Retry-After), or null when no request was made (a Salesforce
   * lease refused, a token endpoint's 429).
   */
  | { kind: 'requeue'; notBefore: Date; status: number | null; cause: RequeueCause }
  /** The connection refused before sending anything (a removed connection, a login needing reauth). */
  | { kind: 'not_sent'; reason: string }

export interface StepSend<T> {
  nodeId: string
  /** The send's place within its node: one node may send several times. */
  seq: number
  method: string
  url: string
  /** The service honours the step request id, so a resend cannot apply twice. */
  idempotent: boolean
  forward(call: { signal: AbortSignal; requestId: string }): Promise<ForwardAnswer<T>>
}

export interface RunContext {
  readonly run: ClaimedRun
  readonly executionId: string
  readonly attempt: number
  /** Aborted when the run must stop: its claim is lost, or a send decided how it ends. */
  readonly signal: AbortSignal
  /** The one way a run's step reaches anything outside. Answers the status and value, or throws. */
  send<T>(step: StepSend<T>): Promise<{ status: number; value: T }>
}

/** What a body may end its run with. */
export type RunBodyEnd =
  | { outcome: 'done' }
  | { outcome: 'failed'; reason?: HolderFailedReason; error?: string }
  | { outcome: 'retry'; error?: string; notBefore?: Date }

export type RunBody = (ctx: RunContext) => Promise<RunBodyEnd>

export type RunInvocationReport =
  | { outcome: 'completed'; end: CompleteOutcome; runStatus: string | null }
  /** Not this holder's any more: nothing was completed, and the lease sweep owns the run. */
  | { outcome: 'claim_lost'; during: 'start' | 'heartbeat' | 'send' | 'complete' }
  /** The start failed or passed its deadline, so nothing ran; if it landed, the lease lapses and is swept. */
  | { outcome: 'start_failed'; error: string }
  /** Every complete failed; the lease lapses and the sweep ends the run by its ledger rows. */
  | { outcome: 'complete_failed'; end: CompleteOutcome; error: string }

/** The run stopped (see RunContext.signal). Thrown by send; a body should let it go. */
export class RunStopped extends Error {
  constructor() {
    super('the run has stopped: its claim was lost or a send decided how it ends')
    this.name = 'RunStopped'
  }
}

/** The connection sent nothing; the ledger row is marked failed. */
export class StepNotSent extends Error {
  constructor(readonly nodeId: string, readonly reason: string) {
    super(`step ${nodeId} sent nothing: ${reason}`)
    this.name = 'StepNotSent'
  }
}

/** A GET passed SEND_DEADLINE_MS. Nothing was changed by it, so the body may go on or throw. */
export class StepTimedOut extends Error {
  constructor(readonly nodeId: string) {
    super(`step ${nodeId}'s GET passed its ${SEND_DEADLINE_MS} ms deadline`)
    this.name = 'StepTimedOut'
  }
}

/**
 * One id per step send, the same on every attempt of the run: a SHA-256 of the
 * run, node and sequence, shaped as a version 8 (custom) UUID.
 */
export async function stepRequestId(runRequestId: string, nodeId: string, seq: number): Promise<string> {
  const data = new TextEncoder().encode(`bidspoke-step-request:${runRequestId}:${nodeId}:${seq}`)
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x80
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type Settled<T> = { kind: 'ok'; value: T } | { kind: 'timeout' } | { kind: 'threw'; error: unknown } | { kind: 'stopped' }

/**
 * Runs work under a deadline on the injected clock. The work's signal aborts at
 * the deadline and when link aborts; link aborting answers stopped at once,
 * even if the work ignores its signal.
 */
async function within<T>(clock: RunClock, ms: number, work: (signal: AbortSignal) => Promise<T>, link?: AbortSignal): Promise<Settled<T>> {
  const ctl = new AbortController()
  const timerCtl = new AbortController()
  const races: Array<Promise<Settled<T>>> = []
  let onLink: (() => void) | null = null
  if (link) {
    races.push(new Promise<Settled<T>>((resolve) => {
      onLink = () => { ctl.abort(); resolve({ kind: 'stopped' }) }
      if (link.aborted) onLink()
      else link.addEventListener('abort', onLink, { once: true })
    }))
  }
  let settled: Promise<Settled<T>>
  try {
    settled = Promise.resolve(work(ctl.signal)).then((value) => ({ kind: 'ok' as const, value }), (error: unknown) => ({ kind: 'threw' as const, error }))
  } catch (error) {
    // A port that throws before returning a promise.
    settled = Promise.resolve({ kind: 'threw' as const, error })
  }
  races.push(settled)
  races.push(clock.timer(ms, timerCtl.signal).then(() => ({ kind: 'timeout' as const })))
  try {
    const out = await Promise.race(races)
    if (out.kind === 'timeout') ctl.abort()
    return out
  } finally {
    timerCtl.abort()
    if (link && onLink) link.removeEventListener('abort', onLink)
  }
}

const END_RANK: Record<CompleteOutcome['outcome'], number> = { done: 0, retry: 1, suspend: 1, dead: 2, failed: 2, needs_human: 3 }

export async function invokeRun(deps: RunInvocationDeps, run: ClaimedRun, body: RunBody): Promise<RunInvocationReport> {
  const { db, clock } = deps
  const ids = { run_request_id: run.runRequestId, workflow_id: run.workflowId }
  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try {
      deps.log({ event: 'ops_run', step: event, ...ids, ...fields })
    } catch {
      // A log line never changes how the run ends.
    }
  }

  // ── start ──
  const executionId = deps.newExecutionId()
  const started = await within(clock, RUN_DB_DEADLINE_MS, () => db.start(run, executionId))
  if (started.kind === 'threw' && started.error instanceof OpsClaimLostError) {
    log('claim_lost', { during: 'start' })
    return { outcome: 'claim_lost', during: 'start' }
  }
  if (started.kind !== 'ok') {
    const error = started.kind === 'threw' ? formatErr(started.error) : `start_run_execution passed its ${RUN_DB_DEADLINE_MS} ms deadline and may still have committed`
    log('start_failed', { error })
    return { outcome: 'start_failed', error }
  }
  const { stateVersion, attempt } = started.value

  // ── state ──
  /** Aborted when the claim is lost: a forward in flight is aborted with it. */
  const lost = new AbortController()
  /** Aborted when the run must stop for any reason: the body's signal. */
  const halt = new AbortController()
  let lostDuring: 'heartbeat' | 'send' | null = null
  let ending: CompleteOutcome | null = null
  /** A non idempotent send has been forwarded, or is in flight: the run may not start again. */
  let unrepeatable = false
  let unrepeatableInFlight = 0
  /** This Worker's time until which the lease is confirmed held. */
  let confirmedUntil = 0
  const inFlight = new Set<Promise<unknown>>()

  const lose = (during: 'heartbeat' | 'send') => {
    if (lostDuring === null) {
      lostDuring = during
      log('claim_lost', { during })
    }
    lost.abort()
    halt.abort()
  }
  const endWith = (end: CompleteOutcome) => {
    if (ending === null || END_RANK[end.outcome] > END_RANK[ending.outcome]) ending = end
    halt.abort()
  }
  const mayRepeat = () => !unrepeatable && unrepeatableInFlight === 0
  /** A retry, unless a send already made cannot be repeated: then failed. */
  const retryOr = (error: string, notBefore?: Date): CompleteOutcome =>
    mayRepeat() ? { outcome: 'retry', error, ...(notBefore ? { notBefore } : {}) } : { outcome: 'failed', error }
  const requeueEnd = (nodeId: string, a: { notBefore: Date; cause: RequeueCause }): CompleteOutcome => {
    if (!mayRepeat()) return { outcome: 'failed', error: `step ${nodeId} was asked to wait (${a.cause}) after a send that cannot be repeated` }
    if ((RESOURCE_WAIT_CAUSES as readonly string[]).includes(a.cause)) {
      return { outcome: 'suspend', reason: 'resource_wait', cause: a.cause as ResourceWaitCause, notBefore: a.notBefore }
    }
    return { outcome: 'retry', error: `step ${nodeId}: ${a.cause}`, notBefore: a.notBefore }
  }
  const unknown = (nodeId: string, method: string, host: string, why: string): CompleteOutcome =>
    ({ outcome: 'needs_human', reason: 'send_outcome_unknown', error: `step ${nodeId} (${method} ${host}): ${why}; it may have landed` })

  // ── the heartbeat ──
  const renew = async (): Promise<void> => {
    const sentAt = clock.now()
    const r = await within(clock, RUN_DB_DEADLINE_MS, () => db.extend(run, RUN_LEASE_SECONDS))
    if (halt.signal.aborted && lostDuring !== null) return
    if (r.kind === 'ok' && r.value) {
      confirmedUntil = Math.max(confirmedUntil, sentAt + RUN_LEASE_SECONDS * 1000)
      return
    }
    if ((r.kind === 'ok' && !r.value) || (r.kind === 'threw' && r.error instanceof OpsClaimLostError)) {
      lose('heartbeat')
      return
    }
    log('heartbeat_unconfirmed', { error: r.kind === 'threw' ? formatErr(r.error) : `extend_run_lease passed its ${RUN_DB_DEADLINE_MS} ms deadline` })
    if (clock.now() >= confirmedUntil) lose('heartbeat')
  }

  let beatAt = clock.now()
  await renew()
  if (lostDuring !== null) return { outcome: 'claim_lost', during: 'heartbeat' }
  const beatsStop = new AbortController()
  const beats = (async () => {
    while (!beatsStop.signal.aborted && !lost.signal.aborted) {
      beatAt += HEARTBEAT_EVERY_MS
      await clock.timer(Math.max(0, beatAt - clock.now()), beatsStop.signal)
      if (beatsStop.signal.aborted || lost.signal.aborted) return
      await renew()
    }
  })()

  // ── a send ──
  const leaseHeld = (): boolean => {
    if (lost.signal.aborted) return false
    if (clock.now() >= confirmedUntil) {
      lose('heartbeat')
      return false
    }
    return true
  }

  const markResult = async (ledgerId: string, nodeId: string, result: { status: 'forwarded' | 'failed'; responseStatus?: number }): Promise<void> => {
    const clean = result.responseStatus === undefined ? { status: result.status } : result
    for (let n = 1; n <= WRITE_TRIES; n++) {
      const r = await within(clock, RUN_DB_DEADLINE_MS, () => db.recordResult(run, ledgerId, clean))
      if (r.kind === 'ok') return
      if (n === WRITE_TRIES) {
        // The row stays an intent, which reads as unknown: a person resolving the run sees it so.
        log('send_result_unrecorded', { node_id: nodeId, status: result.status, error: r.kind === 'threw' ? formatErr(r.error) : 'deadline' })
      }
    }
  }

  const doSend = async <T>(step: StepSend<T>): Promise<{ status: number; value: T }> => {
    if (halt.signal.aborted || !leaseHeld()) throw new RunStopped()
    const method = step.method.toUpperCase()
    let host: string
    try {
      host = new URL(step.url).hostname
    } catch {
      throw new Error(`step ${step.nodeId}'s URL is not a URL, so nothing was sent`)
    }
    const requestId = await stepRequestId(run.runRequestId, step.nodeId, step.seq)
    const forward = () => within(clock, SEND_DEADLINE_MS, (signal) => step.forward({ signal, requestId }), lost.signal)

    if (method === 'GET') {
      const r = await forward()
      if (r.kind === 'stopped') throw new RunStopped()
      if (r.kind === 'timeout') throw new StepTimedOut(step.nodeId)
      if (r.kind === 'threw') throw r.error
      const a = r.value
      if (a.kind === 'answered') return { status: a.status, value: a.value }
      if (a.kind === 'not_sent') throw new StepNotSent(step.nodeId, a.reason)
      endWith(requeueEnd(step.nodeId, a))
      throw new RunStopped()
    }

    if (!(LEDGER_METHODS as readonly string[]).includes(method)) {
      throw new Error(`step ${step.nodeId}: a ${method} has no name in the send ledger, so it was not sent`)
    }
    const intent = await within(clock, RUN_DB_DEADLINE_MS, () => db.recordIntent(run, {
      stateVersion, nodeId: step.nodeId, seq: step.seq, method: method as LedgerMethod, host, idempotent: step.idempotent, attemptKey: requestId,
    }))
    if (intent.kind !== 'ok') {
      // The intent may have landed, but nothing was forwarded: an intent never followed by a send.
      endWith(retryOr(`step ${step.nodeId}: its send intent was not confirmed (${intent.kind === 'threw' ? formatErr(intent.error) : 'deadline'}), so nothing was sent`))
      throw new RunStopped()
    }
    if (intent.value.outcome === 'stale') {
      lose('send')
      throw new RunStopped()
    }
    if (intent.value.outcome === 'duplicate') {
      // This attempt already recorded this send: never forward it twice.
      if (intent.value.ledgerStatus === 'intent') endWith(unknown(step.nodeId, method, host, 'an earlier send of this step has no recorded result'))
      else endWith({ outcome: 'failed', error: `step ${step.nodeId} sent its send ${step.seq} twice` })
      throw new RunStopped()
    }
    const ledgerId = intent.value.ledgerId
    if (ledgerId === null) throw new Error(`record_send_intent recorded step ${step.nodeId} with no ledger id`)
    if (halt.signal.aborted) {
      // Another send decided the run's end while this intent was written: nothing is forwarded.
      await markResult(ledgerId, step.nodeId, { status: 'failed' })
      throw new RunStopped()
    }

    if (!step.idempotent) unrepeatableInFlight++
    let r: Settled<ForwardAnswer<T>>
    try {
      r = await forward()
    } finally {
      if (!step.idempotent) unrepeatableInFlight--
    }
    if (r.kind === 'stopped') {
      // The claim was lost mid flight. The row stays an intent; the sweep sends the run to a person.
      if (!step.idempotent) unrepeatable = true
      throw new RunStopped()
    }
    if (r.kind !== 'ok') {
      if (!step.idempotent) unrepeatable = true
      const why = r.kind === 'timeout' ? `no answer within ${SEND_DEADLINE_MS} ms` : `the forward failed (${formatErr(r.error)})`
      endWith(step.idempotent ? retryOr(`step ${step.nodeId}: ${why}`) : unknown(step.nodeId, method, host, why))
      throw new RunStopped()
    }
    const a = r.value
    switch (a.kind) {
      case 'answered':
        if (!step.idempotent) unrepeatable = true
        await markResult(ledgerId, step.nodeId, { status: 'forwarded', responseStatus: a.status })
        return { status: a.status, value: a.value }
      case 'not_sent':
        await markResult(ledgerId, step.nodeId, { status: 'failed' })
        throw new StepNotSent(step.nodeId, a.reason)
      case 'requeue':
        if (a.status === null || a.status === 429) {
          // Nothing was applied: no request, or a 429.
          await markResult(ledgerId, step.nodeId, a.status === null ? { status: 'failed' } : { status: 'failed', responseStatus: a.status })
          endWith(requeueEnd(step.nodeId, a))
          throw new RunStopped()
        }
        await markResult(ledgerId, step.nodeId, { status: 'forwarded', responseStatus: a.status })
        if (step.idempotent) {
          endWith(requeueEnd(step.nodeId, a))
        } else {
          unrepeatable = true
          endWith(unknown(step.nodeId, method, host, `answered ${a.status} with Retry-After, which does not prove it was not applied`))
        }
        throw new RunStopped()
    }
  }

  const send = <T>(step: StepSend<T>): Promise<{ status: number; value: T }> => {
    const p = doSend(step)
    inFlight.add(p)
    const done = () => { inFlight.delete(p) }
    p.then(done, done)
    return p
  }

  // ── the body ──
  const ctx: RunContext = { run, executionId, attempt, signal: halt.signal, send }
  type BodyResult = { kind: 'returned'; end: RunBodyEnd } | { kind: 'threw'; error: unknown } | { kind: 'halted' }
  const bodyDone: Promise<BodyResult> = (async () => {
    try {
      return { kind: 'returned' as const, end: await body(ctx) }
    } catch (error) {
      return { kind: 'threw' as const, error }
    }
  })()
  const halted = new Promise<BodyResult>((resolve) => {
    if (halt.signal.aborted) resolve({ kind: 'halted' })
    else halt.signal.addEventListener('abort', () => resolve({ kind: 'halted' }), { once: true })
  })
  const result = await Promise.race([bodyDone, halted])
  // Sends still in flight settle first (each bounded by its deadline), so their outcome is part of the end.
  if (lostDuring === null) await Promise.allSettled([...inFlight])
  beatsStop.abort()
  await beats

  if (lostDuring !== null) return { outcome: 'claim_lost', during: lostDuring }

  let end: CompleteOutcome
  if (ending !== null) {
    end = ending
  } else if (result.kind === 'returned') {
    const b = result.end
    if (b.outcome === 'done') end = { outcome: 'done' }
    else if (b.outcome === 'failed') end = b
    else end = retryOr(b.error ?? 'the run asked to be retried', b.notBefore)
  } else if (result.kind === 'threw') {
    end = retryOr(formatErr(result.error))
  } else {
    // Halted with no end recorded cannot happen: halt is only aborted with one, or with a lost claim.
    end = retryOr('the run stopped without a recorded reason')
  }

  // ── complete ──
  let lastError = ''
  for (let n = 1; n <= WRITE_TRIES; n++) {
    const r = await within(clock, RUN_DB_DEADLINE_MS, () => db.complete(run, end))
    if (r.kind === 'ok') {
      log('completed', { outcome: end.outcome, run_status: r.value.runStatus })
      return { outcome: 'completed', end, runStatus: r.value.runStatus }
    }
    if (r.kind === 'threw' && r.error instanceof OpsClaimLostError) {
      log('claim_lost', { during: 'complete' })
      return { outcome: 'claim_lost', during: 'complete' }
    }
    lastError = r.kind === 'threw' ? formatErr(r.error) : `complete_run_request passed its ${RUN_DB_DEADLINE_MS} ms deadline and may still have committed`
  }
  log('complete_failed', { outcome: end.outcome, error: lastError })
  return { outcome: 'complete_failed', end, error: lastError }
}
