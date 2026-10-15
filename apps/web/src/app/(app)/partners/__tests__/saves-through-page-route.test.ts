/**
 * The web app saves a partner only through PUT /api/partners/:id/page (#2133).
 *
 * The page used to save the partner record and the buyer profile in two
 * requests, so a refused profile left the partner half saved. Both halves now
 * go in one request, one transaction. The old PUT /api/partners/:id and PUT
 * /api/partners/:id/buyer-profile are kept one release for pages opened
 * before, and the old profile route counts its calls so it can be removed; a
 * web call to either would keep it alive and bring back the half save.
 *
 * Every PUT in the web source is read with the request path written just
 * before it in the same call, and any PUT under /api/partners must be the page
 * route. Seen red by putting back api.partners.update (PUT /api/partners/${id})
 * and api.buyerProfiles.save (PUT .../buyer-profile).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_SRC, listFiles } from '@/lib/__tests__/_scan-utils'

/** Each PUT in a file, with the last request path literal written before it in the same call. */
function putsIn(file: string): Array<{ file: string; path: string }> {
  const src = readFileSync(file, 'utf8')
  const out: Array<{ file: string; path: string }> = []
  for (const m of src.matchAll(/method:\s*['"`]PUT['"`]/g)) {
    const before = src.slice(Math.max(0, (m.index ?? 0) - 400), m.index)
    const literals = [...before.matchAll(/(`[^`]*\/api\/[^`]*`|'[^']*\/api\/[^']*'|"[^"]*\/api\/[^"]*")/g)]
    const last = literals[literals.length - 1]
    out.push({ file: path.relative(WEB_SRC, file), path: last ? last[1].slice(1, -1) : '(no path found)' })
  }
  return out
}

describe('partner saves go through the one page route (#2133)', () => {
  const puts = listFiles(WEB_SRC).flatMap(putsIn)

  it('finds the page route itself, so the scan is reading real calls', () => {
    expect(puts.some((p) => /\/api\/partners\/\$\{[^}]+\}\/page$/.test(p.path))).toBe(true)
  })

  it('no PUT under /api/partners goes anywhere but /page', () => {
    const elsewhere = puts.filter((p) => p.path.includes('/api/partners') && !/\/page$/.test(p.path))
    expect(elsewhere).toEqual([])
  })
})
