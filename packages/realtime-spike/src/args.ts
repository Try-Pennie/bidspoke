/**
 * Command line of scripts/realtime-spike/run.mjs (#2131).
 *
 *   run.mjs --i-have-approval --ledger <path> [--samples N] [--self-interrupt]
 *   run.mjs --cleanup <ledger>
 *
 * A creating run refuses without --i-have-approval: it makes an organization, an
 * allowlist row and an auth user in production, which Dan approved as decision 1
 * of the #2114 plan (2026-10-15). --cleanup needs no approval, because it only
 * removes what a ledger names, and only rows carrying the spike's marker.
 */
export type Parsed =
  | { mode: 'run'; ledgerPath: string; samples: number; selfInterrupt: boolean }
  | { mode: 'cleanup'; ledgerPath: string }
  | { mode: 'refuse'; message: string }

const USAGE = 'usage: run.mjs --i-have-approval --ledger <path> [--samples N] [--self-interrupt]\n       run.mjs --cleanup <ledger>'

export function parseArgs(argv: string[]): Parsed {
  let approved = false
  let selfInterrupt = false
  let ledgerPath: string | null = null
  let cleanupPath: string | null = null
  let samples = 20

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[i + 1]
      i += 1
      return v
    }
    switch (arg) {
      case '--i-have-approval':
        approved = true
        break
      case '--self-interrupt':
        selfInterrupt = true
        break
      case '--ledger':
        ledgerPath = value() ?? null
        break
      case '--cleanup':
        cleanupPath = value() ?? null
        break
      case '--samples': {
        const raw = value()
        if (!raw || !/^[1-9]\d*$/.test(raw)) return { mode: 'refuse', message: `--samples must be a positive whole number, got '${raw ?? ''}'\n${USAGE}` }
        samples = Number(raw)
        break
      }
      default:
        return { mode: 'refuse', message: `unknown argument '${arg}'\n${USAGE}` }
    }
  }

  if (cleanupPath !== null) return { mode: 'cleanup', ledgerPath: cleanupPath }
  if (!approved) {
    return {
      mode: 'refuse',
      message: `refusing to create anything without --i-have-approval: this run creates an organization, an allowlist row and an auth user in production (decision 1 of #2114).\n${USAGE}`,
    }
  }
  if (!ledgerPath) return { mode: 'refuse', message: `a creating run needs --ledger <path>, written before anything is created\n${USAGE}` }
  return { mode: 'run', ledgerPath, samples, selfInterrupt }
}
