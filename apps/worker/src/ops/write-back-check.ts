/**
 * The write back check (#2340, phase 10 item 4 of #1689; the requirement is
 * #2425's): the ops tick's judgement of the person bound logins whose
 * ConnectionTokenObject holds a rotated login that service_connections has not
 * taken.
 *
 * WHY. A person bound login's refresh token rotates: the provider's answer
 * kills the old one. The object keeps the new one in its own storage and hands
 * it back to the row by its alarm (connection-token-object.ts), retried with
 * backoff while bidding is down or store_rotated_envelope fails. Until it
 * lands, the object holds the only live copy of that login, so losing the
 * object loses the login, and before this nothing said so however long it
 * lasted.
 *
 * HOW THE TICK LEARNS IT, AND WHAT IT COSTS. The way the reseal reaches the
 * objects (reseal-live.ts): the CONNECTION_TOKENS binding, the object named by
 * the connection id, one RPC (writeBackState) each, raced against a deadline.
 * Asked only by the tick that owns the connection_check sweep's claim
 * (tick.ts), so once every 14 to 15 minutes (CONNECTION_CHECK_EVERY_SECONDS),
 * never every minute, and only about the connections the tick's own list
 * already names (connection_check_targets): no extra database read. Every
 * listed connection's object is asked, as the reseal asks them, because
 * nothing in the list says which are person bound, and choosing by the
 * service's registered rules would exempt exactly the object whose service
 * lost its rules while it still held a login (L96). The read is one storage
 * get, and writes nothing. So the cost is one Durable Object request per ops
 * connection per sweep, about a hundred a day per connection, and one
 * subrequest each against the tick's 10,000 (docs/ops-ceilings-spike.md P3,
 * which counts a binding call as the caller's subrequest); the reads run at
 * most WRITE_BACK_READ_CONCURRENCY at a time, each bounded at
 * WRITE_BACK_READ_DEADLINE_MS, and none starts past WRITE_BACK_START_BUDGET_MS,
 * so the check ends within the minute the tick rides however many there are
 * (spike P1, P2: a minute cron's ceilings are 15 minutes of wall and 30 s of
 * CPU, and a read is a few milliseconds of either). With no ops connection
 * (production today) nothing is asked.
 *
 * THE BOUND (WRITE_BACK_PENDING_PAGE_MS, 30 minutes), from the alarm's retry
 * schedule: the first try is at once and each failed one waits twice as long
 * as the last, from 30 seconds to the 15 minute ceiling, so the tries come at
 * 0, 0.5, 1.5, 3.5, 7.5, 15.5 and 30.5 minutes. A blip, a deploy of the bidding
 * Worker or a few minutes of it being down, is retried four times in its first
 * five minutes and lands. By 30 minutes six tries have failed and the wait
 * between tries has reached its ceiling, so the cause is not passing, and
 * waiting longer only adds a quarter hour of exposure for each further try.
 * Read on the sweep's interval, a write back is paged once it has been pending
 * between 30 and about 46 minutes.
 *
 * WHAT IS LISTED, for the bidding Worker to page through the
 * ops-connection-write-back signal (lib/ops-connection-logins.ts): each
 * connection whose object holds a login pending past the bound, or pending
 * since a time it never recorded (a login stored before that time was kept,
 * which is read as unknown, never as fresh). The list is complete only when
 * the tick's read named every ops connection and every object answered, so a
 * connection is never given an all clear that was not asked about.
 *
 * WHAT IS UNKNOWN, AND PAGED. An object that cannot be reached, does not answer
 * within its deadline, answers failed or refused, answers something this code
 * cannot read, or is not asked because the budget was spent, is a keyed tick
 * problem (write_back_unreadable, by connection), paged at once like every kind
 * of the sweep it rides: never read as nothing pending.
 */
import { raceDeadline } from '../lib/alert-claim'
import { formatErr } from '../lib/format-error'
import { MAX_REPORT_WRITE_BACKS, tickProblem, type TickProblem, type WriteBackAlert, type WriteBacksReport } from '../lib/ops-gateway-contract'
import { WRITE_BACK_RETRY_MAX_MS, WRITE_BACK_RETRY_MIN_MS } from './connection-token-object'
import { parseWriteBackStateAnswer, type WriteBackStateAnswer } from './connections/token-object-contract'
import type { ConnectionCheckTarget } from './ops-writes'

/** A write back pending this long pages: see THE BOUND above. */
export const WRITE_BACK_PENDING_PAGE_MS = 30 * 60_000
/** One object's read: one storage get, so far past what it takes. */
export const WRITE_BACK_READ_DEADLINE_MS = 10_000
/** The reads in flight at once. */
export const WRITE_BACK_READ_CONCURRENCY = 6
/** No read starts once this much of the check has passed, counted on this Worker's clock from its start. */
export const WRITE_BACK_START_BUDGET_MS = 15_000

/** How many write back tries the alarm has made by `ms` after a login went pending, every one failing (connection-token-object.ts retryLater). */
export function writeBackAttemptsBy(ms: number): number {
  let at = 0
  let tries = 0
  while (at <= ms) {
    tries += 1
    at += Math.min(WRITE_BACK_RETRY_MIN_MS * 2 ** (tries - 1), WRITE_BACK_RETRY_MAX_MS)
  }
  return tries
}

export interface WriteBackCheckDeps {
  /** The connection's ConnectionTokenObject.writeBackState, as it answered (parsed here). Throws when the object cannot be reached. */
  read(target: ConnectionCheckTarget): Promise<unknown>
  /** This Worker's clock, which the object's pending time is on too (both are the platform's clock). */
  now(): number
  /** The deadline (L524: injected). */
  sleep(ms: number): Promise<void>
  /** For tests: the reads in flight at once. */
  concurrency?: number
}

export interface WriteBackCheckResult {
  report: WriteBacksReport
  problems: TickProblem[]
  counts: Record<string, number>
}

type Read = { kind: 'answered'; answer: Exclude<WriteBackStateAnswer, { ok: false }> } | { kind: 'unknown'; cause: string }

async function readOne(deps: WriteBackCheckDeps, target: ConnectionCheckTarget): Promise<Read> {
  const raced = await raceDeadline(() => deps.read(target), WRITE_BACK_READ_DEADLINE_MS, (ms) => deps.sleep(ms))
  if (raced.kind === 'timed_out') return { kind: 'unknown', cause: `it did not answer within ${WRITE_BACK_READ_DEADLINE_MS / 1000} seconds` }
  if (raced.kind === 'threw') return { kind: 'unknown', cause: `it could not be reached (${formatErr(raced.error)})` }
  let answer: WriteBackStateAnswer
  try {
    answer = parseWriteBackStateAnswer(raced.value)
  } catch (err) {
    return { kind: 'unknown', cause: `its answer could not be read (${formatErr(err)})` }
  }
  if (!answer.ok) return { kind: 'unknown', cause: answer.reason === 'refused' ? 'it refused the read' : 'it could not read the login it holds' }
  return { kind: 'answered', answer }
}

/** Asks each listed connection's object, judges what is due, and never throws. */
export async function runWriteBackCheck(deps: WriteBackCheckDeps, list: { targets: readonly ConnectionCheckTarget[]; reachedLimit: boolean }): Promise<WriteBackCheckResult> {
  const startedMs = deps.now()
  const problems: TickProblem[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const reads = new Map<ConnectionCheckTarget, Read>()

  const queue = [...list.targets]
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      if (deps.now() - startedMs >= WRITE_BACK_START_BUDGET_MS) {
        bump('write_backs_deferred')
        reads.set(t, { kind: 'unknown', cause: `it was not asked: the check's ${WRITE_BACK_START_BUDGET_MS / 1000} second budget was spent` })
        continue
      }
      bump('write_backs_asked')
      try {
        reads.set(t, await readOne(deps, t))
      } catch (err) {
        reads.set(t, { kind: 'unknown', cause: `the read failed (${formatErr(err)})` })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? WRITE_BACK_READ_CONCURRENCY, list.targets.length)) }, worker))

  const nowMs = deps.now()
  const due: WriteBackAlert[] = []
  let allAnswered = true
  for (const t of list.targets) {
    const r = reads.get(t) ?? { kind: 'unknown' as const, cause: 'it was not asked' }
    if (r.kind === 'unknown') {
      allAnswered = false
      bump('write_backs_unknown')
      problems.push(tickProblem('write_back_unreadable', `Whether the ${t.service} connection ${t.connectionId} has a new login not yet saved back to Bidspoke is not known: its ConnectionTokenObject ${r.cause}. No all clear is sent for it until it answers.`, t.connectionId))
      continue
    }
    const a = r.answer
    if (a.state !== 'pending') {
      bump(a.state === 'none' ? 'write_backs_none' : 'write_backs_landed')
      continue
    }
    if (a.pendingSinceMs !== null && nowMs - a.pendingSinceMs < WRITE_BACK_PENDING_PAGE_MS) {
      bump('write_backs_pending_young')
      continue
    }
    bump('write_backs_due')
    due.push({
      organization_id: t.organizationId, connection_id: t.connectionId, service: t.service,
      since: a.pendingSinceMs === null ? null : new Date(a.pendingSinceMs).toISOString(), attempts: a.attempts,
    })
  }

  if (list.reachedLimit || due.length > MAX_REPORT_WRITE_BACKS) {
    problems.push(tickProblem('write_back_limit', list.reachedLimit
      ? `The write back check read ${list.targets.length} ops connections, its limit, so a login waiting to be saved back past them was not judged and no all clear is sent for it.`
      : `The write back check found ${due.length} logins waiting too long to be saved back, more than the ${MAX_REPORT_WRITE_BACKS} one report carries; the rest are in the next report once these are saved.`))
  }
  return {
    report: { complete: allAnswered && !list.reachedLimit && due.length <= MAX_REPORT_WRITE_BACKS, pending: due.slice(0, MAX_REPORT_WRITE_BACKS) },
    problems,
    counts,
  }
}
