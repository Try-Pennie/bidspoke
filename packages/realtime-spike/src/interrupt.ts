/**
 * SIGINT and SIGTERM run the ledger cleanup, then exit (#2131, L515). A second
 * signal while cleanup is running is ignored rather than killing it halfway; a
 * cleanup that throws is logged and the process still exits non zero. A cleanup
 * that outlives its deadline (a hung call) is abandoned with the command that
 * finishes it, so the process never needs a SIGKILL (#2157 lessons review, L110).
 */
export interface ProcessLike {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown
  exit(code: number): unknown
}

const EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const

export interface InterruptOptions {
  deadlineMs?: number
  /** Injectable so a test never waits the deadline out (L524). */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** What to run to finish the cleanup by hand, named when the deadline passes. */
  hint?: string
}

export function installInterruptCleanup(
  proc: ProcessLike,
  cleanup: () => Promise<void>,
  log: (line: string) => void,
  opts: InterruptOptions = {},
): () => void {
  const deadlineMs = opts.deadlineMs ?? 120_000
  // Unref: the deadline must never be what keeps a finished process alive.
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
  let running = false
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => {
      if (running) {
        log(`${signal} again: cleanup is still running, waiting for it`)
        return
      }
      running = true
      log(`${signal}: cleaning up from the ledger before exiting`)
      let exited = false
      const exit = () => {
        if (exited) return
        exited = true
        proc.exit(EXIT_CODE[signal])
      }
      setTimer(() => {
        if (exited) return
        log(`cleanup after ${signal} did not finish within ${Math.round(deadlineMs / 1000)} s${opts.hint ? `; ${opts.hint}` : ''}`)
        exit()
      }, deadlineMs)
      cleanup()
        .catch((err: unknown) => log(`cleanup after ${signal} failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`))
        .finally(exit)
    }
    proc.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler)
  }
}
