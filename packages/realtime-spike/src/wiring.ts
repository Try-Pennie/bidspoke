/** The real wiring of src/cli.ts main: this process, the file system, Supabase, pg and wrangler. */
import type { Wiring } from './cli.ts'
import { nodeLedgerIo } from './ledger.ts'
import { liveCleanupOps, liveDeps, loadConfig } from './live.ts'
import { runSpike } from './spike.ts'

export function liveWiring(): Wiring {
  const log = (line: string) => process.stdout.write(`${line}\n`)
  return {
    io: nodeLedgerIo,
    log,
    proc: process,
    now: () => new Date(),
    loadConfig: (mode) => loadConfig(mode),
    cleanupOps: liveCleanupOps,
    liveDeps: (config, ledger, marker, register) => liveDeps(config, ledger, marker, log, register),
    spike: runSpike,
  }
}
