import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * A pull request must actually CLOSE the issue its title names.
 *
 * THE DEFECT THIS EXISTS FOR, measured rather than assumed. This repo's title
 * convention names the issue in parentheses:
 *
 *   Give the execution retention window one source of truth (#1017)
 *
 * 191 of 360 merged pull requests do that. A parenthesised mention closes
 * NOTHING: GitHub acts only on a keyword such as `Closes #1017`. So the title
 * reads as a link, the work ships, and the issue stays open forever.
 *
 * Measured across all 360 merged pull requests on 2026-09-03: zero open issues
 * carry a closing keyword from a merged pull request, so the keyword never fails
 * when it is present. 119 merged pull requests (34%) carry no keyword at all,
 * and seven open issues are named in a merged pull request's title with no
 * keyword anywhere. Two of those seven, #986 and #1017, were confirmed shipped
 * and closed by hand that day. The failure is entirely that the keyword is never
 * written, never that GitHub ignored it.
 *
 * WHY THIS ONE BLOCKS, unlike `main-push-decision.sh` beside it. That guard
 * makes an ACCUSATION about something already merged, so uncertainty must stay
 * quiet (LESSONS L36). This one WITHHOLDS a merge while the author is still
 * there, and the whole remedy is one line in the body, so the cheap moment is
 * before the merge rather than after it.
 *
 * IT MUST ONLY REFUSE WHAT IS GENUINELY WRONG (LESSONS L54). A pull request
 * whose title names no issue is untouched, which is every Dependabot bump and
 * every chore. And a reference is not always a closure: a phase issue, a partial
 * fix or a related note legitimately names an issue it does not finish, which is
 * this repo's commonest shape. Without an escape hatch the guard would be wrong
 * about exactly those, so `Refs only: #875` marks the intent and is honoured PER
 * ISSUE, not per pull request: naming three issues and exempting one still
 * requires the other two to be closed.
 *
 * The fail direction on unreadable input is `ok`, and it falls out of the design
 * rather than being bolted on: no readable title means no candidate issues means
 * nothing to demand. A blocker that fires on garbage blocks good work.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/issue-closure-decision.sh')

/** Drive the real script. Title is an argument, body arrives on stdin. */
function decide(prNumber: string, title: string, body = ''): string {
  return execFileSync('bash', [scriptPath, prNumber, title], {
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

describe('issue-closure-decision: catches the #986 and #1017 case', () => {
  it('refuses a title naming an issue that no keyword closes', () => {
    expect(decide('1124', 'Read every Snowflake result partition, and refuse a short one (#986)')).toBe(
      'missing:986',
    )
  })

  it('accepts the same pull request once the body closes it', () => {
    expect(
      decide('1124', 'Read every Snowflake result partition, and refuse a short one (#986)', 'Closes #986'),
    ).toBe('ok')
  })

  it('names every uncovered issue, not only the first', () => {
    expect(decide('1131', 'Fix the three defects (#1111, #1112, #1113)')).toBe('missing:1111,1112,1113')
  })

  it('names only the issues actually left uncovered', () => {
    // The partial case is the one worth getting right: closing two of three
    // reads as a finished pull request to a reviewer skimming the body.
    expect(decide('1131', 'Fix the three defects (#1111, #1112, #1113)', 'Closes #1111\nFixes #1112')).toBe(
      'missing:1113',
    )
  })
})

describe('issue-closure-decision: reads every form GitHub itself honours', () => {
  const title = 'Some real work (#1017)'

  it('accepts each closing keyword and each inflection', () => {
    for (const keyword of [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ]) {
      expect(decide('1125', title, `${keyword} #1017`)).toBe('ok')
    }
  })

  it('is case insensitive, because GitHub is', () => {
    for (const written of ['Closes #1017', 'CLOSES #1017', 'cLoSeS #1017']) {
      expect(decide('1125', title, written)).toBe('ok')
    }
  })

  it('accepts a keyword in the title itself, not only the body', () => {
    expect(decide('1125', 'Closes #1017 by giving retention one source of truth')).toBe('ok')
  })

  it('accepts the full issue URL form, which GitHub also honours', () => {
    expect(decide('1125', title, 'Closes https://github.com/Try-Pennie/bidspoke/issues/1017')).toBe('ok')
  })

  it('accepts the owner/repo#number form', () => {
    expect(decide('1125', title, 'Closes Try-Pennie/bidspoke#1017')).toBe('ok')
  })

  it('requires the keyword to be a whole word, so a word merely ending in one does not close', () => {
    // `prefix #986` ends in `fix`. Without a word boundary it reads as
    // `fix #986` and silently satisfies the guard. Written as `(^|[^A-Za-z])`
    // rather than `\b` because CI runs GNU grep and a developer machine runs
    // BSD grep, which spell `\b` differently.
    for (const body of ['prefix #986', 'The prefix #986 is unrelated', 'unfixed #986', 'postfix #986']) {
      expect(decide('1124', 'Some work (#986)', body)).toBe('missing:986')
    }
  })

  it('still reads a keyword that follows punctuation or a bullet', () => {
    for (const body of ['- Closes #986', '(Closes #986)', 'Done. Closes #986', 'Closes: #986']) {
      expect(decide('1124', 'Some work (#986)', body)).toBe('ok')
    }
  })

  it("does not read a bare verb as a closure, so this repo's usual title is not self satisfying", () => {
    // `Fix the three defects behind the finalize alert (#1111)` must NOT count
    // as `Fix #1111`. Every title in this repo opens with a verb, so reading one
    // loosely would make the guard permanently silent while looking active.
    expect(decide('1131', 'Fix the three defects behind the finalize alert (#1111)')).toBe('missing:1111')
    expect(decide('1131', 'Resolve the drift (#1111)')).toBe('missing:1111')
  })
})

describe('issue-closure-decision: only refuses what is genuinely wrong (L54)', () => {
  it('is silent on a title naming no issue at all', () => {
    expect(decide('1122', 'Cap the grouped field alert so a mass failure still sends')).toBe('ok')
  })

  it('is silent on a Dependabot bump', () => {
    expect(decide('1079', 'chore(deps): bump the minor-and-patch group across 1 directory')).toBe('ok')
  })

  it("ignores the pull request's own number, which the squash merge appends", () => {
    // After a squash merge the title carries both: the issue the author wrote
    // and the pull request number GitHub added.
    expect(decide('1124', 'Read every Snowflake result partition (#986) (#1124)', 'Closes #986')).toBe('ok')
    expect(decide('1124', 'Some work (#1124)')).toBe('ok')
  })

  it('is silent when the title names nothing but the body closes something', () => {
    expect(decide('1122', 'Cap the grouped field alert', 'Closes #1123')).toBe('ok')
  })

  it('only counts a number written in PARENTHESES, which is how this repo names an issue', () => {
    // 191 of 360 merged pull requests name the issue as `... (#1017)`. A number
    // loose in the prose is a reference to something, not a claim to be the
    // pull request that finishes it, so demanding a closure for it would refuse
    // work that is not wrong (L54).
    expect(decide('1124', 'Stop the #986 regression from recurring')).toBe('ok')
    expect(decide('1124', 'Follow up to #986 with the missing case')).toBe('ok')
    // And the parenthesised form is still caught, so this is a restriction
    // rather than a hole.
    expect(decide('1124', 'Stop the regression from recurring (#986)')).toBe('missing:986')
  })
})

describe('issue-closure-decision: the Refs only escape hatch', () => {
  it('exempts an issue the author deliberately only references', () => {
    expect(decide('1009', 'Phase A7 groundwork (#875)', 'Refs only: #875')).toBe('ok')
  })

  it('accepts the hyphenated spelling too', () => {
    expect(decide('1009', 'Phase A7 groundwork (#875)', 'Refs-only: #875')).toBe('ok')
  })

  it('exempts per issue, never per pull request', () => {
    // The trap: an exemption that waves through the whole pull request would let
    // one `Refs only` line silence every other issue in the title.
    expect(decide('1009', 'Phase groundwork (#870, #871, #875)', 'Refs only: #875')).toBe(
      'missing:870,871',
    )
  })

  it('honours several exempted issues on one line and across lines', () => {
    expect(decide('1009', 'Phase groundwork (#870, #871, #875)', 'Refs only: #870, #871\nRefs only: #875')).toBe(
      'ok',
    )
  })

  it('lets an exemption and a closure cover a title between them', () => {
    expect(decide('1009', 'Phase groundwork (#870, #875)', 'Closes #870\nRefs only: #875')).toBe('ok')
  })
})

describe('issue-closure-decision: never blocks on input it cannot read', () => {
  it('is silent on an empty title and an empty body', () => {
    expect(decide('1124', '')).toBe('ok')
    expect(decide('', '')).toBe('ok')
  })

  it('is silent when called with no arguments at all', () => {
    expect(execFileSync('bash', [scriptPath], { encoding: 'utf8', input: '', stdio: 'pipe' }).trim()).toBe(
      'ok',
    )
  })

  it('is silent when the pull request number is not a number', () => {
    // A non-numeric number means the caller's lookup failed. That is not
    // evidence that a title reference is unclosed.
    for (const bad of ['', 'ERR', 'null', 'abc']) {
      expect(decide(bad, 'Some work (#986)')).toBe('ok')
    }
  })

  it('prints exactly one line, and it is ok or a missing list', () => {
    for (const [pr, title, body] of [
      ['1124', 'Some work (#986)', ''],
      ['1124', 'Some work (#986)', 'Closes #986'],
      ['1122', 'No reference at all', ''],
    ]) {
      const out = execFileSync('bash', [scriptPath, pr, title], {
        encoding: 'utf8',
        input: body,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      expect(out.trim().split('\n')).toHaveLength(1)
      expect(out.trim()).toMatch(/^(ok|missing:\d+(,\d+)*)$/)
    }
  })

  it('exits 0 on every input, so the script never decides the build itself', () => {
    for (const args of [['1124', 'Some work (#986)'], [], ['x', 'y']]) {
      expect(() => execFileSync('bash', [scriptPath, ...args], { input: '', stdio: 'pipe' })).not.toThrow()
    }
  })

  it('handles a body containing shell metacharacters without misreading it', () => {
    const nasty = 'Closes #986\n$(echo pwned) `whoami` "quoted" && | ; $HOME'
    expect(decide('1124', 'Some work (#986)', nasty)).toBe('ok')
  })
})

describe('issue-closure-decision: the guard is wired into CI', () => {
  // A guard nothing calls is the classic silent failure: it passes its own tests
  // forever while checking nothing at all.
  const ci = readWorkflow('.github/workflows/ci.yml')

  it('has a job that runs the decision script', () => {
    const body = workflowJobBody(ci, 'issue-closure-guard')
    expect(body).toContain('.github/scripts/issue-closure-decision.sh')
  })

  it('runs on pull requests, which is the only moment the remedy is cheap', () => {
    const body = workflowJobBody(ci, 'issue-closure-guard')
    expect(body).toMatch(/pull_request/)
  })

  it('fails the build when the decision is missing, rather than only logging it', () => {
    const body = workflowJobBody(ci, 'issue-closure-guard')
    expect(body).toContain('exit 1')
  })

  it('carries a timeout, because a hang is worse than a failure', () => {
    expect(workflowJobBody(ci, 'issue-closure-guard')).toMatch(/timeout-minutes:\s*\d+/)
  })
})
