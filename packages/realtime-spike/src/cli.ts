/**
 * Entry point of scripts/realtime-spike/run.mjs (#2131). See args.ts for the
 * command line and spike.ts for what a run measures.
 *
 * Order, and why: arguments are checked first (nothing without approval), then
 * the configuration, then the ledger file is written, and only then is anything
 * connected to or created. SIGINT and SIGTERM clean up from the ledger and exit;
 * the normal path, success or failure, cleans up too, after the spike has
 * checked Org B is empty. The result is written beside the ledger.
 */
import { parseArgs } from './args.ts'
import { cleanupLedger, formatCleanupReport, type CleanupOps } from './cleanup.ts'
import { trackInflight, type Tracked } from './inflight.ts'
import { installInterruptCleanup, type ProcessLike } from './interrupt.ts'
import { makeMarker, newLedger, openLedger, readLedger, type LedgerHandle, type LedgerIo } from './ledger.ts'
import { DEFAULT_OPTIONS, type SpikeDeps, type SpikeOptions, type SpikeResult } from './spike.ts'

export interface SpikeConfig {
  project: string
  supabaseUrl: string
  publishableKey: string
  secretKey: string
  orgAEmail: string
  orgAPassword: string
}

export interface Wiring {
  io: LedgerIo
  log(line: string): void
  proc: ProcessLike
  now(): Date
  loadConfig(mode: 'run' | 'cleanup'): SpikeConfig
  cleanupOps(config: SpikeConfig): CleanupOps
  /**
   * Builds the real dependencies. Everything it starts (a connection, a child
   * process) is handed to `register` the moment it exists, so an interrupt
   * while it is still starting stops what is already running.
   */
  liveDeps(
    config: SpikeConfig,
    ledger: LedgerHandle,
    marker: string,
    register: (closer: () => Promise<void>) => void,
  ): Promise<{ deps: SpikeDeps }>
  spike(deps: SpikeDeps, options: SpikeOptions): Promise<SpikeResult>
}

/** The spike's calls that reach Supabase, the database or the Worker. */
const REMOTE_CALLS: ReadonlyArray<keyof SpikeDeps> = [
  'signIn',
  'orgOfUser',
  'createAllowlist',
  'createOrganization',
  'createAuthUser',
  'countOrgRows',
  'partitionExists',
  'dbSend',
  'restSend',
  'subscribe',
  'workerSubscribe',
]
const SETTLE_MS = 15_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err)
}

async function cleanupAndReport(ledgerPath: string, wiring: Wiring, config: SpikeConfig): Promise<boolean> {
  const ledger = readLedger(ledgerPath, wiring.io)
  // Against another project every delete finds nothing and the run would
  // report a clean cleanup while the rows stay where they were made.
  if (ledger.project !== config.project) {
    wiring.log(`refusing to clean up: ${ledgerPath} was made against project ${ledger.project}, and this environment points at ${config.project}`)
    return false
  }
  const report = await cleanupLedger(ledger, wiring.cleanupOps(config))
  for (const line of formatCleanupReport(report)) wiring.log(line)
  return report.failed.length === 0
}

export async function main(argv: string[], wiring: Wiring): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'refuse') {
    wiring.log(parsed.message)
    return 2
  }

  let config: SpikeConfig
  try {
    config = wiring.loadConfig(parsed.mode)
  } catch (err) {
    wiring.log(`configuration: ${errorText(err)}`)
    return 2
  }

  if (parsed.mode === 'cleanup') {
    try {
      return (await cleanupAndReport(parsed.ledgerPath, wiring, config)) ? 0 : 1
    } catch (err) {
      wiring.log(`cleanup could not start: ${errorText(err)}`)
      return 1
    }
  }

  const startedAt = wiring.now()
  const marker = makeMarker(startedAt)
  let ledger: LedgerHandle
  try {
    ledger = openLedger(parsed.ledgerPath, newLedger(marker, config.project, startedAt.toISOString()), wiring.io)
  } catch (err) {
    wiring.log(errorText(err))
    return 2
  }
  wiring.log(`marker ${marker}; ledger ${parsed.ledgerPath}`)

  // One cleanup, shared by the normal path and the signal handlers: a signal
  // that arrives while the normal path is cleaning up waits for that same
  // cleanup, then exits, instead of killing it with rows still present.
  const closers: Array<() => Promise<void>> = []
  let closing = false
  const runCloser = (closer: () => Promise<void>) => closer().catch((err: unknown) => wiring.log(`closing: ${errorText(err)}`))
  const close = async () => {
    closing = true
    for (const closer of closers.splice(0).reverse()) await runCloser(closer)
  }
  // Something started after the cleanup began (a wrangler spawned while the
  // signal was being handled) is stopped at once rather than left running.
  const register = (closer: () => Promise<void>) => {
    if (closing) void runCloser(closer)
    else closers.push(closer)
  }
  let tracked: Tracked<SpikeDeps> | null = null
  let cleaning: Promise<boolean> | null = null
  const cleanupOnce = (): Promise<boolean> => {
    cleaning ??= (async () => {
      // Nothing new is sent, and anything already sent lands, before the
      // cleanup reads the ledger: a create landing after it would be left behind.
      if (tracked) {
        tracked.stop()
        if (!(await tracked.settle(SETTLE_MS))) {
          wiring.log(`a call was still in flight after ${SETTLE_MS / 1000} s; if anything is left below, run --cleanup ${parsed.ledgerPath} again`)
        }
      }
      await close()
      try {
        return await cleanupAndReport(parsed.ledgerPath, wiring, config)
      } catch (err) {
        wiring.log(`cleanup failed: ${errorText(err)}; rerun with --cleanup ${parsed.ledgerPath}`)
        return false
      }
    })()
    return cleaning
  }
  const uninstall = installInterruptCleanup(
    wiring.proc,
    async () => {
      await cleanupOnce()
    },
    (line) => wiring.log(line),
    { hint: `rerun with --cleanup ${parsed.ledgerPath}` },
  )

  let exitCode = 0
  try {
    const live = await wiring.liveDeps(config, ledger, marker, register)
    tracked = trackInflight(live.deps, REMOTE_CALLS)
    const result = await wiring.spike(tracked.deps, {
      ...DEFAULT_OPTIONS,
      samples: parsed.samples,
      selfInterrupt: parsed.selfInterrupt,
    })
    wiring.io.write(`${parsed.ledgerPath}.result.json`, `${JSON.stringify(result, null, 2)}\n`)
    wiring.log(`result written to ${parsed.ledgerPath}.result.json`)
    if (result.problems?.length) {
      for (const p of result.problems) wiring.log(`PROBLEM: ${p}`)
      exitCode = 1
    }
  } catch (err) {
    wiring.log(`spike failed: ${errorText(err)}`)
    exitCode = 1
  } finally {
    // The handlers stay installed until cleanup has finished (see cleanupOnce).
    if (!(await cleanupOnce())) exitCode = 1
    uninstall()
  }
  return exitCode
}
