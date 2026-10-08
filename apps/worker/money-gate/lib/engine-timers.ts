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
 */
import { GATE_STEP_DEADLINE_MS } from './step-deadlines'

/** What the lift replaces: the global scope in a replay, a plain object in a test. */
export interface TimerHost {
  setTimeout: typeof setTimeout
  AbortSignal: { timeout: (ms: number) => AbortSignal }
}

export interface FiredTimer {
  kind: 'setTimeout' | 'AbortSignal.timeout'
  /** The length the engine asked for, before the lift. */
  requestedMs: number
  /** The frames that set it, nearest first. */
  where: string
}

export interface LiftedTimers {
  /** Every lifted timer that fired, in the order they fired. */
  fired(): FiredTimer[]
  /** Puts back exactly what the lift replaced. */
  restore(): void
}

/** Replaces `host`'s setTimeout and AbortSignal.timeout until `restore`, raising each timer to `floorMs`. */
export function liftEngineTimers(host: TimerHost, opts: { floorMs?: number } = {}): LiftedTimers {
  const floorMs = opts.floorMs ?? GATE_STEP_DEADLINE_MS
  const realSetTimeout = host.setTimeout
  const signals = host.AbortSignal
  const realTimeout = signals.timeout
  const fired: FiredTimer[] = []

  host.setTimeout = ((handler: unknown, ms?: number, ...args: unknown[]) => {
    const requestedMs = Number(ms ?? 0) || 0
    const where = setAt(new Error().stack)
    return realSetTimeout.call(globalThis, () => {
      fired.push({ kind: 'setTimeout', requestedMs, where })
      if (typeof handler === 'function') (handler as (...a: unknown[]) => void)(...args)
    }, Math.max(requestedMs, floorMs))
  }) as typeof setTimeout

  signals.timeout = (ms: number): AbortSignal => {
    const where = setAt(new Error().stack)
    const signal = realTimeout.call(signals, Math.max(ms, floorMs))
    signal.addEventListener('abort', () => { fired.push({ kind: 'AbortSignal.timeout', requestedMs: ms, where }) }, { once: true })
    return signal
  }

  return {
    fired: () => [...fired],
    restore: () => {
      host.setTimeout = realSetTimeout
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
