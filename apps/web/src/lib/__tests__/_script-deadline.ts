import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'

/**
 * A deadline for a test that runs a shell script synchronously (#2432).
 *
 * Vitest's own timeout cannot stop a test that is blocked in execFileSync: it
 * only judges, after the child has exited, how long the test took. Measured on
 * 2026-10-18: a synchronous 8 s child under the 5 s default ran its full 8010 ms
 * and was then failed as "timed out in 5000ms". So for these tests the default
 * never caught a hang. All it did was fail a healthy run whose processes were
 * slow to start on a busy machine, which is how deploy-inflight-age.test.ts and
 * pages-propagation-sample.test.ts failed in a full web run that day (L290,
 * L293).
 *
 * What catches a hang is a deadline on the child itself, which kills it. The
 * test timeout then sits above the deadline so it never fires first, and a test
 * using this runs the script at most once, so one deadline covers it.
 *
 * The figure is several times the slowest run measured under load (each file
 * records its own measurement beside its use), so reaching it means the script
 * hung rather than ran slowly.
 */
export const SCRIPT_RUN_DEADLINE_MS = 20_000

/** The vitest timeout for a test that makes one run under SCRIPT_RUN_DEADLINE_MS. */
export const SCRIPT_TEST_TIMEOUT_MS = SCRIPT_RUN_DEADLINE_MS + 10_000

/** Thrown when a script outlived its deadline and was killed. */
export class ScriptHungError extends Error {}

/**
 * execFileSync with the deadline applied. A kill at the deadline is reported as
 * the script hanging; any other failure is rethrown unchanged, so a caller can
 * still read a non-zero exit's status and output.
 */
export function execScriptSync(
  label: string,
  file: string,
  args: string[],
  options: Omit<ExecFileSyncOptionsWithStringEncoding, 'timeout' | 'killSignal'>,
): string {
  try {
    return execFileSync(file, args, { ...options, timeout: SCRIPT_RUN_DEADLINE_MS, killSignal: 'SIGKILL' })
  } catch (e) {
    const err = e as { code?: string; signal?: string | null }
    if (err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL') {
      throw new ScriptHungError(`${label} did not finish within ${SCRIPT_RUN_DEADLINE_MS} ms, so it is hung`)
    }
    throw e
  }
}
