/**
 * SIGINT and SIGTERM run the ledger cleanup, then exit (#2131, L515). A second
 * signal while cleanup is running is ignored rather than killing it halfway; a
 * cleanup that throws is logged and the process still exits non zero.
 */
export interface ProcessLike {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown
  exit(code: number): unknown
}

const EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const

export function installInterruptCleanup(proc: ProcessLike, cleanup: () => Promise<void>, log: (line: string) => void): () => void {
  let running = false
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => {
      if (running) {
        log(`${signal} again: cleanup is still running, waiting for it`)
        return
      }
      running = true
      log(`${signal}: cleaning up from the ledger before exiting`)
      cleanup()
        .catch((err: unknown) => log(`cleanup after ${signal} failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`))
        .finally(() => proc.exit(EXIT_CODE[signal]))
    }
    proc.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler)
  }
}
