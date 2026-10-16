/**
 * An alert claim ledger that behaves as the claim object does for one TTL
 * window (#1298): the first caller per key wins until it releases. Every call is
 * logged, with the TTL asked for, so a test can read both what was claimed and
 * in what order against the other steps it logs into the same list.
 */
import type { AlertClaims } from '../alert-claim'

export function claimLedger(log: string[] = []) {
  const held = new Set<string>()
  const ttls = new Map<string, number>()
  const claims: AlertClaims = {
    claim: async (key, ttlSeconds) => {
      log.push(`claim ${key}`)
      ttls.set(key, ttlSeconds)
      if (held.has(key)) return false
      held.add(key)
      return true
    },
    release: async (key) => {
      log.push(`release ${key}`)
      held.delete(key)
    },
  }
  return { claims, log, held, ttls }
}

/**
 * A promise settled by hand, to hold a tick at its post while the other tick
 * reaches the same decision point (L157: prove it by holding two callers there,
 * never by hoping the interleaving reproduces).
 */
export function gate<T>() {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => { open = resolve })
  return { promise, open }
}

/** Lets every queued microtask and macrotask run once. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Waits on the condition itself, never a fixed number of turns (L290): a tick
 * that walks every registered job takes more turns to reach its post on a busy
 * machine, and releasing the held post before it got there would test no
 * overlap at all.
 */
export async function until(ready: () => boolean, what = 'both ticks reaching the decision point'): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (ready()) return
    await settle()
  }
  throw new Error(`${what} never happened`)
}

/**
 * Two ticks of one alert overlapping: both started, the post held until
 * `ready` says both have reached the decision point, then released.
 */
export async function overlap(run: () => Promise<unknown>, open: () => void, ready: () => boolean): Promise<void> {
  const a = run()
  const b = run()
  await until(ready)
  open()
  await Promise.all([a, b])
}
