/**
 * Every Durable Object call on the attempt path carries a deadline (L110). The
 * timers are injectable so a test proves the deadline without waiting (L524).
 */

export class DeadlineError extends Error {
  readonly operation: string
  readonly ms: number
  constructor(operation: string, ms: number) {
    super(`${operation} did not answer within ${ms} ms`)
    this.name = 'DeadlineError'
    this.operation = operation
    this.ms = ms
  }
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function withDeadline<T>(promise: Promise<T>, ms: number, operation: string, timers: Timers = realTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timers.setTimeout(() => reject(new DeadlineError(operation, ms)), ms)
    promise.then(
      (value) => {
        timers.clearTimeout(handle)
        resolve(value)
      },
      (err: unknown) => {
        timers.clearTimeout(handle)
        reject(err instanceof Error ? err : new Error(`${operation} rejected with a non Error value`))
      }
    )
  })
}
