/**
 * The header of apps/worker/src/lib/org-workflows.ts names every caller of
 * readOrgWorkflows (#2137, L244): a reader deciding whether a change to the one
 * scoped workflows read is safe takes that list as the truth, so a caller it
 * leaves out, or one it names that no longer calls it, misleads them. The list
 * is checked against the files that import it, both ways. Seen red with the
 * header PR11 wrote on its branch, which names five callers not on this branch
 * and leaves out the usage route.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, WORKER_SRC } from '../../__tests__/_scan-utils'

const HOME = path.join(WORKER_SRC, 'lib/org-workflows.ts')
const rel = (file: string) => path.relative(WORKER_SRC, file).split(path.sep).join('/')

/** The worker files that call readOrgWorkflows, product source only. */
function callers(): string[] {
  return listFiles(WORKER_SRC)
    .filter((f) => f !== HOME && /\breadOrgWorkflows\s*\(/.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort()
}

/** The caller paths the header names, as `routes/...` or `lib/...` in backticks. */
function named(): string[] {
  const header = /^\/\*\*([\s\S]*?)\*\//.exec(readFileSync(HOME, 'utf8'))?.[1] ?? ''
  return [...new Set([...header.matchAll(/`((?:routes|lib|engine)\/[\w/.-]+\.ts)`/g)].map((m) => m[1]))].sort()
}

describe('org-workflows.ts names its callers (#2137)', () => {
  it('finds the callers (a positive control: the usage route is one)', () => {
    expect(callers()).toContain('routes/api/partner-usage.ts')
  })

  it('names exactly the files that call it', () => {
    expect(named()).toEqual(callers())
  })
})
