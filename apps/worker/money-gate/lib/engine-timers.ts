/**
 * The engine's own timers, lifted for the length of a replay run (#1872).
 *
 * #1796 lifted the timeouts a definition sets. The engine also sets budgets in
 * code: buyer_click_check gives its profile read and click count 800 ms of wall
 * clock (CLICK_CHECK_BUDGET_MS), buyer_select bounds its whole path, the lead
 * read budget aborts slow reads, and so on. Each is a real timer racing work the
 * replay answers from canned data, so on a slow or cold runner one ran out on one
 * side only and the gate went red with nothing changed (2026-10-07: the head
 * replay ran first and cold, the click check timed out, and the lead was refused
 * instead of offered).
 *
 * Measured on a replay of every fixture: no engine timer fires, before or after
 * the answer. Every budget is meant to lose its race, so raising each one to the
 * gate deadline changes no outcome and removes the race. A timer that fires anyway
 * is recorded with the length the engine asked for and where it was set, and the
 * replay fails on it by name rather than letting it decide a fixture.
 *
 * Code node scripts run in the gate's nested workerd, out of reach of this lift:
 * their retry sleeps are meant to fire.
 *
 * MOVING THE REPLAY'S TIME ON (#3086). A buyer call that never answers ends only
 * when the call's own timer aborts it (abortAfter in engine/step-timeout.ts), and
 * under the lift that timer is GATE_STEP_DEADLINE_MS of real time away. So the
 * lift keeps every setTimeout still pending, due at the replay time it was set
 * plus the length the engine asked for, and advanceUntil runs them early, the one
 * due first each time, until the held call is aborted. The replay's time starts at
 * zero each run and moves only by an advance, so the order is the same on both
 * sides whatever the runner's speed. A timer run this way is recorded as
 * advanced, never as fired: it did not race the runner. AbortSignal.timeout is
 * native and is not advanced; the engine sets none on the buyer call's path.
 */
import { GATE_STEP_DEADLINE_MS } from './step-deadlines'

/** What the lift replaces: the global scope in a replay, a plain object in a test. */
export interface TimerHost {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  AbortSignal: { timeout: (ms: number) => AbortSignal }
}

/** How a held answer waits (#3086): until `signal` aborts, or `ms` of replay time pass when given, whichever is first. */
export type WaitOnReplayTime = (signal: AbortSignal, ms?: number) => Promise<'aborted' | 'elapsed'>

/** More advances than any real run sets timers, so a run that re-arms a timer for ever stops by name. */
const ADVANCE_LIMIT = 1_000

export interface FiredTimer {
  kind: 'setTimeout' | 'AbortSignal.timeout'
  /** The length the engine asked for, before the lift. */
  requestedMs: number
  /** The frames that set it, nearest first. */
  where: string
}

export interface LiftedTimers {
  /** Every lifted timer that fired on the real clock, in the order they fired. */
  fired(): FiredTimer[]
  /** Every timer advanceUntil ran early, in the order it ran them (#3086). */
  advanced(): FiredTimer[]
  /**
   * Moves the replay's time on (#3086): lets the run settle, then runs the
   * pending timer due first, and again, until `done` holds. Refuses by name when
   * nothing pending could end the wait.
   */
  advanceUntil(done: () => boolean): Promise<void>
  /** A held answer's wait on the replay's time (#3086), moved on by advanceUntil. */
  waitFor: WaitOnReplayTime
  /** Puts back exactly what the lift replaced. */
  restore(): void
}

export interface LiftOptions {
  /** The shortest any timer may be; 0 keeps every length as the engine asked and only tracks them. */
  floorMs?: number
  /** Told the replay time an advance has reached, before the timer runs, so a pinned clock can move with it. */
  onAdvance?: (replayMs: number) => void
}

interface PendingTimer { seq: number; dueMs: number; record: FiredTimer; runEarly: () => void }

/** Replaces `host`'s setTimeout, clearTimeout and AbortSignal.timeout until `restore`, raising each timer to `floorMs`. */
export function liftEngineTimers(host: TimerHost, opts: LiftOptions = {}): LiftedTimers {
  const floorMs = opts.floorMs ?? GATE_STEP_DEADLINE_MS
  const realSetTimeout = host.setTimeout
  const realClearTimeout = host.clearTimeout
  const signals = host.AbortSignal
  const realTimeout = signals.timeout
  const fired: FiredTimer[] = []
  const advanced: FiredTimer[] = []
  const pending = new Map<unknown, PendingTimer>()
  let replayNowMs = 0
  let seq = 0

  host.setTimeout = ((handler: unknown, ms?: number, ...args: unknown[]) => {
    // Workers refuse a string handler, so the engine never sets one; one here is a fault, not a timer.
    if (typeof handler !== 'function') throw new TypeError('money gate: a setTimeout handler that is not a function cannot be lifted')
    const run = handler as (...a: unknown[]) => void
    const requestedMs = Number(ms ?? 0) || 0
    const record: FiredTimer = { kind: 'setTimeout', requestedMs, where: setAt(new Error().stack) }
    // Each timer runs once, on the real clock or by an advance, whichever comes first.
    let ran = false
    const once = (into: FiredTimer[]) => {
      if (ran) return
      ran = true
      pending.delete(handle)
      into.push(record)
      run(...args)
    }
    const handle = realSetTimeout.call(globalThis, () => once(fired), Math.max(requestedMs, floorMs))
    pending.set(handle, {
      seq: seq++,
      dueMs: replayNowMs + requestedMs,
      record,
      runEarly: () => {
        realClearTimeout.call(globalThis, handle)
        once(advanced)
      },
    })
    return handle
  }) as typeof setTimeout

  // The cast is needed under tsconfig.scripts.json, whose Node types give clearTimeout a
  // second overload; the Workers config alone does not need it, which lint reports.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  host.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle)
    realClearTimeout.call(globalThis, handle)
  }) as typeof clearTimeout

  // One real turn, on the timer the lift found, so work already in flight lands before time moves.
  const settle = (): Promise<void> => new Promise((resolve) => { realSetTimeout.call(globalThis, resolve, 0) })

  const advanceUntil = async (done: () => boolean): Promise<void> => {
    for (let advances = 0; ; advances++) {
      await settle()
      if (done()) return
      if (advances >= ADVANCE_LIMIT) throw new Error(`money gate: the replay's time was moved on ${ADVANCE_LIMIT} times and the held answer is still waiting, so something re-arms a timer for ever`)
      let next: PendingTimer | null = null
      for (const t of pending.values()) if (!next || t.dueMs < next.dueMs || (t.dueMs === next.dueMs && t.seq < next.seq)) next = t
      if (!next) throw new Error('money gate: a held answer is waiting on the replay\'s time, but no engine timer is pending that could end the wait, so it would wait for ever')
      replayNowMs = Math.max(replayNowMs, next.dueMs)
      opts.onAdvance?.(replayNowMs)
      next.runEarly()
    }
  }

  const waitFor: WaitOnReplayTime = async (signal, ms) => {
    let elapsed = false
    // Set through the lift, so it is pending, in order, beside the engine's own timers.
    const handle = ms === undefined ? null : host.setTimeout(() => { elapsed = true }, ms)
    try {
      await advanceUntil(() => signal.aborted || elapsed)
    } finally {
      if (handle !== null) host.clearTimeout(handle)
    }
    return signal.aborted ? 'aborted' : 'elapsed'
  }

  signals.timeout = (ms: number): AbortSignal => {
    const where = setAt(new Error().stack)
    const signal = realTimeout.call(signals, Math.max(ms, floorMs))
    signal.addEventListener('abort', () => { fired.push({ kind: 'AbortSignal.timeout', requestedMs: ms, where }) }, { once: true })
    return signal
  }

  return {
    fired: () => [...fired],
    advanced: () => [...advanced],
    advanceUntil,
    waitFor,
    restore: () => {
      host.setTimeout = realSetTimeout
      host.clearTimeout = realClearTimeout
      signals.timeout = realTimeout
    },
  }
}

/** The first frames of a stack outside this file, so a fired timer names the code that set it. */
function setAt(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at /, ''))
    .filter((line) => line !== '' && !line.includes('engine-timers.ts'))
    .slice(0, 3)
    .join(' < ')
}

/** The replay's refusal for a run whose engine timers fired; empty when none did. */
export function describeFiredTimers(fixture: string, fired: FiredTimer[]): string {
  if (fired.length === 0) return ''
  const lines = fired.map((t) => `  ${t.kind} of ${t.requestedMs} ms, set at ${t.where}`)
  return [
    `money gate: ${fixture}: ${fired.length} engine timer(s) fired during the run, after being lifted to the gate deadline, so the record depended on how long the run took (#1872):`,
    ...lines,
  ].join('\n')
}
