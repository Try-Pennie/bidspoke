import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody, workflowStepBody } from './_scan-utils'

/**
 * Issue #760, the free stand-in for #266.
 *
 * Server-side branch protection is unavailable here: both
 * `repos/Try-Pennie/bidspoke/rulesets` and `.../branches/main/protection` return
 * 403 "Upgrade to GitHub Pro or make this repository public". #266 stays open on
 * that billing decision, but merges to main deploy the production bidding
 * engine, and the husky hooks that partially cover the gap are bypassable with
 * `--no-verify` / `SKIP_TEST_CHECK`.
 *
 * So this reports a direct push after the fact instead of preventing it.
 *
 * THE FAIL-SAFE DIRECTION IS `ok`, and note it is the OPPOSITE of the artifact
 * deploy gate in this same repo, for a reason worth keeping straight. That gate
 * withholds an ACTION, so uncertainty must let the action through. This one
 * makes an ACCUSATION, so uncertainty must stay quiet: an alert that cries wolf
 * trains everyone to ignore it (LESSONS L36), which costs more than the misses.
 *
 * The specific trap, LESSONS L119, is why the accusation needs two independent
 * sources. GitHub's commit-to-PR association index can return empty for a
 * genuinely reviewed, merged PR, and can stay permanently incomplete rather than
 * catch up. It did exactly that on another repo during an API incident and paged
 * "direct push to main, review bypassed" about a squash merge of a green,
 * reviewed PR. So an empty association is confirmed against the PR record itself
 * before anything is reported.
 *
 * Calibrated against real history on 2026-08-14 rather than assumed, both
 * directions (LESSONS L56): of the last 20 commits on main, the 3 PR merges each
 * resolved to a PR by `mergeCommit.oid`, and the 6 with no association also had
 * no PR recording them, so they are true direct pushes and not an index gap.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/main-push-decision.sh')

function decide(...args: string[]): string {
  return execFileSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const SHA = 'c'.repeat(40)

describe('main-push-decision: reports a genuine direct push (#760)', () => {
  it('reports a violation when nothing associates the commit with a merged PR', () => {
    expect(decide(SHA, '0', '0', 'true')).toBe('violation')
  })

  it('is fine when the association index knows the PR', () => {
    expect(decide(SHA, '1', '0', 'true')).toBe('ok')
  })
})

describe('main-push-decision: an empty index is not evidence of a violation (#760, L119)', () => {
  it('is fine when the index is empty but a PR records this commit as its merge commit', () => {
    // The L119 case. This is the shape that produced a false accusation about a
    // properly reviewed squash merge on another repo.
    expect(decide(SHA, '0', '1', 'true')).toBe('ok')
  })

  it('is fine when both sources know the PR', () => {
    expect(decide(SHA, '1', '1', 'true')).toBe('ok')
  })
})

describe('main-push-decision: never accuses on an unreadable signal (#760)', () => {
  it('stays quiet when the lookups failed', () => {
    expect(decide(SHA, '0', '0', 'false')).toBe('ok')
  })

  it('stays quiet when the lookup status is anything other than a clear success', () => {
    for (const status of ['', 'ERR', 'unknown', 'maybe']) {
      expect(decide(SHA, '0', '0', status)).toBe('ok')
    }
  })

  it('stays quiet when a count is non-numeric, as an API error string would be', () => {
    // `gh api ... --jq length` prints nothing on failure and a caller may pass an
    // error marker through. Neither may be read as "zero PRs, therefore guilty".
    for (const bad of ['', 'ERR', 'null', 'not-a-number', '-1']) {
      expect(decide(SHA, bad, '0', 'true')).toBe('ok')
      expect(decide(SHA, '0', bad, 'true')).toBe('ok')
    }
  })

  it('stays quiet when called with too few arguments', () => {
    expect(decide()).toBe('ok')
    expect(decide(SHA)).toBe('ok')
    expect(decide(SHA, '0')).toBe('ok')
    expect(decide(SHA, '0', '0')).toBe('ok')
  })

  it('prints exactly one of ok or violation and nothing else on stdout', () => {
    for (const args of [[SHA, '0', '0', 'true'], [SHA, '1', '0', 'true'], []]) {
      const out = execFileSync('bash', [scriptPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(['ok', 'violation']).toContain(out.trim())
    }
  })

  it('exits 0 on every input, so the script itself never decides the build', () => {
    for (const args of [[SHA, '0', '0', 'true'], [], ['x', 'y', 'z', 'w']]) {
      expect(() => execFileSync('bash', [scriptPath, ...args], { stdio: 'pipe' })).not.toThrow()
    }
  })
})

describe('ci.yml wires the direct-push guard in (#760)', () => {
  const workflowText = () => readWorkflow('.github/workflows/ci.yml')

  /** Blank YAML comments so prose about a setting is never read as the setting (L103). */
  function stripYamlComments(yml: string): string {
    return yml
      .split('\n')
      .map((line) => {
        const m = /^(\s*)#/.exec(line)
        return m ? m[1] : line.replace(/\s+#.*$/, '')
      })
      .join('\n')
  }

  /**
   * The guard's step inside the Security scans job, comments blanked. It was a
   * job of its own until the short guards were folded in to stop each billing a
   * full minute. Comments are blanked AFTER the slice, because blanking first
   * moves every offset the slicer would work from.
   */
  function guardStep(): string {
    return stripYamlComments(
      workflowStepBody(workflowJobBody(workflowText(), 'security'), 'Main has no unreviewed direct push'),
    )
  }

  it('has a step that calls the decision script', () => {
    expect(guardStep()).toContain('main-push-decision.sh')
  })

  it('runs only on a push to main, never on a pull request', () => {
    // On a PR the head commit legitimately has no merged PR yet, so running there
    // would fail every single PR: a guard that is always red is a guard nobody reads.
    const job = guardStep()
    expect(job).toMatch(/github\.event_name\s*==\s*'push'/)
    expect(job).toMatch(/github\.ref\s*==\s*'refs\/heads\/main'/)
  })

  it('consults the PR record as well as the association index', () => {
    // Both sources, or the L119 false accusation is reintroduced.
    const job = guardStep()
    expect(job).toContain('/pulls')
    // The --json flag must actually REQUEST mergeCommit, not merely mention it.
    // Found by mutation-checking: swapping `--json mergeCommit` for
    // `--json number` left this green, because the jq expression still names
    // mergeCommit. At runtime that field would be absent, the count would always
    // be 0, and every merge would be accused: the exact L119 failure, arrived at
    // through a guard that claimed to prevent it.
    expect(job).toMatch(/--json\s+[\w,]*\bmergeCommit\b/)
    expect(job).toMatch(/\.mergeCommit\.oid/)
  })

  it('fails the build on a violation, so the report is not merely a log line', () => {
    expect(guardStep()).toMatch(/exit 1/)
  })
})
