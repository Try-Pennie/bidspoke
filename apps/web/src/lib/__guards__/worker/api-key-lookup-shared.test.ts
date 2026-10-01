import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every worker route that authenticates an X-API-Key goes through the one
 * lookup in `apps/worker/src/lib/api-key-map.ts` (#1702).
 *
 * Both routes used to check the key with `keyMap[apiKey]` on the object
 * JSON.parse returns, which also finds inherited members: `constructor`,
 * `toString` and `__proto__` passed authentication on the live partner
 * endpoints. The fix is only as good as the next route that parses the map,
 * so this fails on a route that parses API_KEY_MAP without the shared lookup,
 * and on any bracket lookup of a key map anywhere in the worker.
 */

// Reads API_KEY_MAP to REBUILD the stored map from api_sources; it never
// decides whether a caller is authenticated, so it has no key to look up.
const REBUILDS_THE_MAP = path.join('routes', 'api', 'sources.ts')
const SHARED_LOOKUP = path.join('lib', 'api-key-map.ts')

const files = listTsFiles(WORKER_SRC).map((full) => ({
  rel: path.relative(WORKER_SRC, full),
  code: sanitizeSource(readFileSync(full, 'utf8')),
}))

describe('API key lookups share one own-property check (#1702)', () => {
  it('every file that parses API_KEY_MAP uses sourceForApiKey', () => {
    const parsers = files.filter((f) => /JSON\.parse\(\s*c\.env\.API_KEY_MAP/.test(f.code))
    const missing = parsers
      .filter((f) => f.rel !== REBUILDS_THE_MAP)
      .filter((f) => !/\bsourceForApiKey\(/.test(f.code))
      .map((f) => f.rel)
    expect(missing).toEqual([])
  })

  it('finds the routes it exists to protect, so it cannot pass by matching nothing', () => {
    const parsers = files.filter((f) => /JSON\.parse\(\s*c\.env\.API_KEY_MAP/.test(f.code)).map((f) => f.rel)
    expect(parsers).toEqual(
      expect.arrayContaining([path.join('middleware', 'api-key-auth.ts'), path.join('routes', 'custom-endpoint.ts')])
    )
  })

  it('no file indexes a key map with brackets outside the shared lookup', () => {
    const offenders = files
      .filter((f) => f.rel !== SHARED_LOOKUP)
      .filter((f) => /\bkeyMap\s*\[/.test(f.code))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })
})
