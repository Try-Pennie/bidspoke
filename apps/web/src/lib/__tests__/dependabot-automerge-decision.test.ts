import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

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


describe('the branch pre-filter stays a pre-filter (#1065)', () => {
  /**
   * The workflow's job-level `if:` skips anything not on a `dependabot/` branch,
   * so a human pull request costs nothing instead of billing a minute to reach
   * the same answer.
   *
   * The hazard is that a cheap filter which happens to give the right answer
   * starts being treated as the answer. A branch name is chosen by whoever
   * opened the branch; the AUTHOR check is what makes this safe, and it lives in
   * the script above. So this asserts both halves stay in place: the filter is
   * present (or the saving is silently gone), and the script is still what
   * decides (or the safety is silently gone).
   */
  const job = () => workflowJobBody(readWorkflow('.github/workflows/dependabot-auto-merge.yml'), 'auto-merge')

  it('skips a run whose head branch is not a Dependabot branch', () => {
    const jobIf = job().slice(0, job().indexOf('steps:'))
    expect(jobIf).toMatch(/startsWith\(github\.event\.workflow_run\.head_branch, 'dependabot\/'\)/)
  })

  it('still delegates the actual merge decision to the tested script', () => {
    // If the pre-filter ever became the decision, a branch name alone would
    // authorise a merge. The script checks the author too.
    //
    // Comments are stripped first, and that is not pedantry: this file's own
    // prose names the script twice, so before stripping, replacing the real
    // invocation with `DECISION=merge` left this assertion GREEN. Caught by
    // mutation-checking it. A comment ABOUT a rule is not the rule (L103).
    const withoutComments = job()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(withoutComments).toMatch(/DECISION=\$\(bash [^\n]*dependabot-automerge-decision\.sh/)
  })

  it('has a script that refuses on the branch prefix alone', () => {
    // The property the workflow now leans on, asserted against the real script:
    // a dependabot-shaped branch from a non-Dependabot author is still a skip.
    expect(decide('some-human', 'dependabot/npm_and_yarn/minor-and-patch-abc123')).toBe('skip')
  })
})
