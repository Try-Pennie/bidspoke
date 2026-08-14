import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Visual-verification artifacts must never be tracked in git.
 *
 * Issue #657. Playwright MCP writes page snapshots into `.playwright-mcp/` and
 * screenshots into the repo ROOT, and both were reachable by a broad `git add`:
 *
 *   - three `.playwright-mcp/page-*.yml` snapshots were committed and tracked, so
 *     tidying that folder deleted tracked files (caught in `git status` and
 *     reverted while working #563, but only by hand)
 *   - `degraded-banner-356.png` was swept into f600782, a commit about classifying
 *     code-node errors, and referenced by nothing anywhere in the repo
 *
 * A `.gitignore` entry alone would not have caught either, because both were
 * already tracked and gitignore does not apply to tracked files. So this asserts
 * the tracked set directly.
 *
 * Real images live under `apps/web/public/`, which is why the rule is scoped to
 * the repo root rather than banning PNGs outright.
 */
const tracked = (pattern: string): string[] =>
  execFileSync('git', ['ls-files', pattern], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

describe('repo artifact hygiene (#657)', () => {
  it('tracks no Playwright MCP snapshots', () => {
    expect(tracked('.playwright-mcp/*'), 'these are scratch output, not source').toEqual([])
  })

  it('tracks no screenshots at the repo root', () => {
    // Scoped to the root: apps/web/public holds the real images.
    const rootPngs = tracked('*.png').filter((f) => !f.includes('/'))
    expect(rootPngs, 'a screenshot swept in by a broad git add').toEqual([])
  })

  it('still tracks the real images, so the rule is not simply banning every png', () => {
    expect(tracked('apps/web/public/*.png').length).toBeGreaterThan(0)
  })

  it('git ls-files works here, so the guard cannot pass vacuously', () => {
    // Every assertion above is an empty-set check, which an unusable git would
    // also satisfy.
    expect(tracked('package.json')).toContain('package.json')
  })
})
