import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

/** The one file both drift decision scripts source their in-flight ceilings from (#2409). */
export const CEILING_FILE = path.join(REPO_ROOT, '.github/scripts/deploy-inflight-ceiling.sh')

/**
 * Reads one ceiling from the shared file, so the cases that use it follow the
 * value when it is re-measured rather than pinning a copy of it here.
 */
export function inflightCeiling(
  name: 'MAX_INFLIGHT_RUNNING_SECONDS' | 'MAX_INFLIGHT_AGE_SECONDS',
): number {
  const match = readFileSync(CEILING_FILE, 'utf8').match(new RegExp(`^${name}=(\\d+)$`, 'm'))
  if (!match) throw new Error(`${name} is not set in ${CEILING_FILE}`)
  return Number(match[1])
}
