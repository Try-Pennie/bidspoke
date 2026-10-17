/**
 * The ExecutionContext worker unit tests hand to the code under test (#2120).
 *
 * The worker hands background work to waitUntil: audit writes, sighting
 * finalizes, every job a scheduled tick starts. A test that gave it a bare
 * vi.fn() (or a function that dropped the promise) let that work run on after
 * the test ended. When it logged after the file's worker had closed, vitest
 * failed the whole run with "Closing rpc while onUserConsoleLog was pending",
 * every test green, about one full run in four (measured 4 of 15 on 2026-10-17,
 * all from scheduled-tick-timing.test.ts, whose hourly tick's jobs wait on
 * dynamic imports that move in real time whatever the faked clock says).
 *
 * recordingContext() keeps every promise handed to it. A test awaits
 * ctx.settle() before it ends; the setup file wait-until-guard.ts runs
 * settleAfterTest() after every test, which fails the test when something was
 * still running at its end and lets that work finish either way, so it can
 * never log into a closed worker. The web guard
 * apps/web/src/lib/__guards__/worker/test-contexts-record-wait-until.test.ts
 * refuses a test file that writes its own waitUntil instead of using this one.
 */
import { vi, type Mock } from 'vitest'
import { formatErr } from '../lib/format-error'

// Captured when this module loads, before any test fakes the clock. Settling
// waits in real time, because what it waits for (a dynamic import, a crypto
// call) moves on the real event loop, not on a faked clock.
const realSetTimeout = globalThis.setTimeout
const realSetImmediate = globalThis.setImmediate

/** How long settling waits for work in real time before it fails instead of hanging. */
export const SETTLE_TIMEOUT_MS = 5_000
const ROUND_MS = 10

export type RecordingContext = ExecutionContext & {
  waitUntil: Mock<(promise: Promise<unknown>) => void>
  passThroughOnException: Mock<() => void>
  /** Every promise handed to waitUntil, in the order handed: a live list, so it grows as more is handed. */
  readonly handed: readonly Promise<unknown>[]
  /** How many handed promises have not settled yet. */
  pending(): number
  /**
   * Waits until every handed promise has settled, including any handed while
   * waiting, and throws naming how many are still running once timeoutMs of
   * real time has passed. Work waiting on a faked timer moves only when the
   * test advances the clock, so advance it first.
   */
  settle(options?: { timeoutMs?: number }): Promise<void>
  /** Stops tracking what is still running: for a test that hangs a promise on purpose. */
  forget(): void
}

type Entry = { promise: Promise<unknown>; settled: boolean }

const recorders: { entries: Entry[]; ctx: RecordingContext }[] = []

const plural = (n: number) => (n === 1 ? '1 promise handed to waitUntil was' : `${n} promises handed to waitUntil were`)
const realTurn = () => new Promise<void>((resolve) => realSetImmediate(resolve))
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms))
const open = (entries: Entry[]) => entries.filter((e) => !e.settled)

async function settleEntries(entries: Entry[], timeoutMs: number): Promise<void> {
  for (let round = 0; round * ROUND_MS < timeoutMs; round++) {
    const running = open(entries)
    if (running.length === 0) return
    await Promise.race([Promise.allSettled(running.map((e) => e.promise)), realSleep(ROUND_MS)])
    // The settled flags are set by handlers attached before allSettled's own,
    // so they are current here; one more turn covers a promise that settled
    // in the same tick the race did.
    await realTurn()
  }
  const left = open(entries).length
  if (left > 0) {
    throw new Error(`${plural(left)} still running after ${timeoutMs} ms. Work waiting on a faked timer moves only when the test advances the clock (vi.advanceTimersByTimeAsync) before it settles.`)
  }
}

export function recordingContext(): RecordingContext {
  const entries: Entry[] = []
  const handed: Promise<unknown>[] = []
  const keep = (promise: Promise<unknown>) => {
    const entry: Entry = { promise: Promise.resolve(promise), settled: false }
    entries.push(entry)
    handed.push(promise)
    // A handler is attached at once, so work that fails is not an unhandled
    // rejection: the platform swallows a failed waitUntil the same way.
    const done = () => { entry.settled = true }
    entry.promise.then(done, done)
  }
  const ctx = {
    // vi.fn(impl): a test can assert the calls, and vi.resetAllMocks restores
    // impl rather than dropping it, so recording survives a reset.
    waitUntil: vi.fn(keep),
    passThroughOnException: vi.fn(),
    props: {},
    handed,
    pending: () => open(entries).length,
    settle: ({ timeoutMs = SETTLE_TIMEOUT_MS }: { timeoutMs?: number } = {}) => settleEntries(entries, timeoutMs),
    forget: () => { entries.splice(0, entries.length, ...entries.filter((e) => e.settled)) },
  } as unknown as RecordingContext
  recorders.push({ entries, ctx })
  return ctx
}

/**
 * Run after every test by the setup file. Gives work one real turn of the
 * event loop (anything finishing in microtasks has then finished, as it would
 * on the platform before the response is read), counts what is still
 * running, then lets ALL of it finish so none can log after the file closes.
 * Returns a message when something was still running at the test's end, for
 * the setup file to fail the test with, or null.
 */
export async function settleAfterTest({ timeoutMs = SETTLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string | null> {
  await realTurn()
  const leftAtEnd = recorders.reduce((n, r) => n + open(r.entries).length, 0)
  if (leftAtEnd === 0) return null
  const problems = [
    `${plural(leftAtEnd)} still running when the test ended, so it could log after the test file closed and fail the run (#2120). Await ctx.settle() before the test ends.`,
  ]
  // Concurrently, so the whole wait is bounded by timeoutMs however many
  // contexts the file made.
  await Promise.all(recorders.map(async (r) => {
    try {
      await settleEntries(r.entries, timeoutMs)
    } catch (e) {
      problems.push(formatErr(e))
      // Reported once; what never settles cannot log, so stop tracking it.
      r.ctx.forget()
    }
  }))
  return problems.join(' ')
}
