/**
 * Track the spike's remote calls, so an interrupt can stop new ones and wait for
 * the ones already sent before the cleanup reads the ledger (#2131).
 *
 * Without it a SIGINT that lands while a create is in flight starts the cleanup
 * at once; the create then lands after the cleanup has looked for it, and the
 * row is left behind with the process gone.
 */
type AnyFn = (...args: never[]) => unknown

export interface Tracked<T> {
  deps: T
  /** From now on every tracked call rejects without reaching the network. */
  stop(): void
  /** Resolves true once every call in flight has settled, false if one outlives timeoutMs. */
  settle(timeoutMs: number): Promise<boolean>
}

export function trackInflight<T extends object>(target: T, methods: ReadonlyArray<keyof T>): Tracked<T> {
  const inflight = new Set<Promise<unknown>>()
  let stopped = false
  const deps = { ...target }
  for (const name of methods) {
    const original = target[name] as unknown as AnyFn
    const wrapped = (...args: never[]): Promise<unknown> => {
      if (stopped) return Promise.reject(new Error(`interrupted: ${String(name)} was not sent`))
      const call = Promise.resolve(original.apply(target, args))
      inflight.add(call)
      const forget = () => inflight.delete(call)
      call.then(forget, forget)
      return call
    }
    ;(deps as Record<PropertyKey, unknown>)[name] = wrapped
  }
  return {
    deps,
    stop: () => {
      stopped = true
    },
    settle: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      const all = Promise.allSettled([...inflight]).then(() => true as const)
      const settled = await Promise.race([all, timedOut])
      clearTimeout(timer)
      return settled
    },
  }
}
