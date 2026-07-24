import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

// The Dependabot auto-merge workflow delegates its "should this PR merge?"
// decision to a shell script so the logic is unit-testable. Regression context:
// the gh CLI changed how it renders a bot author's login from `dependabot[bot]`
// to `app/dependabot`, which silently broke the inline author guard and left
// every routine Dependabot PR unmerged (2026-07-24). These tests lock in both
// author spellings plus the branch allowlist, including the skip paths.
const scriptPath = path.join(REPO_ROOT, '.github/scripts/dependabot-automerge-decision.sh')

function decide(author: string, branch: string): string {
  return execFileSync('bash', [scriptPath, author, branch], { encoding: 'utf8' }).trim()
}

describe('dependabot-automerge-decision', () => {
  it('merges the npm minor-and-patch group PR opened as app/dependabot (the regression case)', () => {
    expect(decide('app/dependabot', 'dependabot/npm_and_yarn/minor-and-patch-4be87234b2')).toBe('merge')
  })

  it('still merges when gh renders the author as the legacy dependabot[bot]', () => {
    expect(decide('dependabot[bot]', 'dependabot/npm_and_yarn/minor-and-patch-abc123')).toBe('merge')
  })

  it('merges github-actions ecosystem bumps (CI-only, fail loudly)', () => {
    expect(decide('app/dependabot', 'dependabot/github_actions/actions/setup-node-7')).toBe('merge')
  })

  it('skips a major-version npm bump (not in the grouped branch) for manual review', () => {
    expect(decide('app/dependabot', 'dependabot/npm_and_yarn/eslint-10')).toBe('skip')
  })

  it('skips a PR not authored by Dependabot even on a dependabot-shaped branch', () => {
    expect(decide('some-human', 'dependabot/npm_and_yarn/minor-and-patch-abc123')).toBe('skip')
  })

  it('skips when the author is empty (PR lookup failed upstream)', () => {
    expect(decide('', 'dependabot/npm_and_yarn/minor-and-patch-abc123')).toBe('skip')
  })
})
