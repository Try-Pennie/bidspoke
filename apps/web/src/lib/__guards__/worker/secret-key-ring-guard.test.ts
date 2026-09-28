import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, WORKER_SRC } from '../../__tests__/_scan-utils'

/**
 * Every use of SECRET_ENCRYPTION_KEY goes through `secretKeys(env)` (#384).
 *
 * The key is rotated by setting SECRET_ENCRYPTION_KEY_NEXT, re-locking the stored
 * rows, then swapping the primary. That only works if every read accepts both
 * keys and every write locks with NEXT, which `secretKeys(env)` provides. A call
 * site handing the raw key to the crypto helpers, the env loader or the Slack
 * cache reads only the primary: during a rotation it would fail to decrypt the
 * rows already re-locked, and the env loader skips a secret it cannot decrypt,
 * so a live workflow would lose that credential with no error.
 *
 * So this scans worker source for the raw key passed as an ARGUMENT. Checking
 * whether it is set (`if (!env.SECRET_ENCRYPTION_KEY)`) is fine and not matched.
 */
const RAW_KEY_AS_ARGUMENT = /(?:(?<!if\s?)\(|,)\s*(?:c\.)?env\.SECRET_ENCRYPTION_KEY\s*[,)]/

function offenders(source: string): number[] {
  return source
    .split('\n')
    .map((line, i) => (RAW_KEY_AS_ARGUMENT.test(line) ? i + 1 : 0))
    .filter(Boolean)
}

describe('SECRET_ENCRYPTION_KEY is only used through secretKeys(env)', () => {
  it('matches the shapes it exists to catch, and not a presence check', () => {
    // Positive and negative controls for the pattern (L1, L104).
    expect(offenders('await decryptSecret(row.value, c.env.SECRET_ENCRYPTION_KEY)')).toEqual([1])
    expect(offenders('loadEnvVars(org, env.WORKFLOW_CACHE, supabase, env.SECRET_ENCRYPTION_KEY)')).toEqual([1])
    expect(offenders('readLastGoodSlackConnections(env.IDEMPOTENCY, env.SECRET_ENCRYPTION_KEY),')).toEqual([1])
    expect(offenders('if (!env.SECRET_ENCRYPTION_KEY) {')).toEqual([])
    expect(offenders('if (env.SECRET_ENCRYPTION_KEY) {')).toEqual([])
    expect(offenders('await decryptSecret(row.value, secretKeys(c.env))')).toEqual([])
  })

  it('finds no worker source passing the raw key', () => {
    const found: string[] = []
    for (const file of listFiles(WORKER_SRC)) {
      for (const line of offenders(readFileSync(file, 'utf8'))) {
        found.push(`${path.relative(WORKER_SRC, file)}:${line}`)
      }
    }
    expect(found, 'pass secretKeys(env) instead of the raw key').toEqual([])
  })
})
