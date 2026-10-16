/**
 * Every path the buyer profile validator can name an error by, read from the
 * validator's own source (every err() call, and the bound, cap and unsupported
 * cap helpers), so a path added there is held by every test that uses this
 * without anyone listing it (#2133, #2137). Not a test file.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '@/lib/__tests__/_scan-utils'

export function validatorPaths(): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, 'packages/buyer-profile/src/validate.ts'), 'utf8')
  const found = new Set<string>()
  for (const re of [/\berr\([^,]+,\s*'([A-Za-z.]+)'/g, /\berr\([^,]+,\s*`([^`]+)`/g, /check(?:Bound|Cap)\([^,]+,\s*'([A-Za-z]+)'/g, /\[profile\.\w+,\s*'([A-Za-z]+)'/g]) {
    for (const m of source.matchAll(re)) found.add(m[1].replace(/\$\{i\}/g, '0'))
  }
  return found
}

/** The validator paths the page save route names a database refusal by (REFUSAL_PATHS in routes/api/partners.ts), read from its source. */
export function refusalPaths(): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, 'apps/worker/src/routes/api/partners.ts'), 'utf8')
  const block = /const REFUSAL_PATHS[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? ''
  return new Set([...block.matchAll(/:\s*'([A-Za-z.]+)'/g)].map((m) => m[1]))
}
