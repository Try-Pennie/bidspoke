/**
 * The backlog walk's own wall budget reaches the repair it calls (#1184).
 *
 * `reArchiveDay` takes the remaining wall time as its third argument, and
 * TypeScript will NOT catch a caller that ignores it: a function of two
 * parameters is assignable to a type of three. So the one production call site
 * can silently drop the budget, the repair goes back to its own fixed 13
 * minutes measured from its own start, and the pair reaches Cloudflare's 900
 * second kill exactly as it did on 2026-08-25, with the type checker green.
 *
 * That is the whole reason this is a guard rather than a type.
 *
 * Mutation checked: removing `wallMs` from the closure's parameters, or the
 * `budget:` it builds, fails this.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const INDEX = path.join(REPO_ROOT, 'apps/worker/src/index.ts')

/** The backlog block, from its deps call to the end of that statement. */
function backlogCallSite(source: string): string {
  const at = source.indexOf('backlogDeps(env, supabase,')
  expect(at, 'the backlog walk must still be wired here').toBeGreaterThan(-1)
  return source.slice(at, at + 1500)
}

describe('the backlog walk hands its budget down (#1184)', () => {
  it('takes the remaining wall time as a parameter', () => {
    const site = backlogCallSite(readFileSync(INDEX, 'utf8'))
    expect(site, 'the closure must accept the wall budget the walk computed').toMatch(
      /\(day,\s*alreadyRecorded,\s*wallMs\)/,
    )
  })

  it('spends it on the run, rather than accepting it and ignoring it', () => {
    // Accepting the parameter and not using it type checks just as cleanly, so
    // the presence of the parameter proves nothing on its own.
    const site = backlogCallSite(readFileSync(INDEX, 'utf8'))
    expect(site, 'the wall budget must reach runExecutionArchive').toMatch(/budget:\s*\{[^}]*wallMs/)
    expect(site, 'and it must be the walk\'s figure, capped rather than replaced').toContain('wallMs)')
  })
})
