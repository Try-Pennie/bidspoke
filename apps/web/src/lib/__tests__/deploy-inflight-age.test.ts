import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Deploy Drift must be able to tell "no deploy is running" from "I could not
 * find out" (#899).
 *
 * All three drift jobs stand down while a deploy is in flight, because a merge
 * landing shortly before the hourly check produces a false page otherwise
 * (#790). They decided that by asking `gh run list` for a queued or running
 * Deploy, and they threw the answer away on failure:
 *
 *     INFLIGHT_AGE=$(gh run list ... 2>/dev/null || true)
 *
 * The job declared no `permissions:` block, and this repository's default
 * workflow token is `read`, which grants contents and packages and nothing else.
 * So the call was refused for want of `actions: read`, the error went to
 * /dev/null, and the empty result reached the gate as "no deploy is running",
 * which is its LOUD side. The gate that exists to prevent a false page was
 * therefore the thing causing one, and it could never have fired since it was
 * written.
 *
 * Both of the only two Deploy Drift failures ever recorded were runs that
 * overlapped a healthy in-flight deploy, and both logged `inflight_age=none`:
 *
 *   2026-08-19 19:38:36  drift ran; deploy of a6c2fac was live 19:33:30-19:39:32
 *   2026-08-18 13:56:20  drift ran; deploy of a401cbf was live 13:51:28-13:57:43
 *
 * This is LESSONS L11 and L98 in one place: a query that failed and a pipeline
 * that is genuinely idle are different facts needing different actions, and
 * folding them onto one value made the broken one indistinguishable from the
 * healthy one. So the query now answers with three distinct states, and
 * `unavailable` is one of them.
 *
 * The three states are driven here through a stub `gh` on the real script, so
 * the branching is exercised against real exit codes rather than asserted about.
 * A stub can only ever confirm our own belief about gh's interface (L52), so the
 * other half of the proof is the live `workflow_dispatch` run recorded on #899,
 * where the query reached GitHub and reported its own outcome out loud.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-inflight-age.sh')

/**
 * Writes a fake `gh` that prints `stdout` and exits with `code`, and returns the
 * age the script prints plus the reason it wrote to stderr.
 */
const askWith = (stdout: string, code: number, stderr = ''): { age: string; reason: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inflight-'))
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    // `%b` so an escape in the fixture becomes a real newline, the way gh's own
    // output arrives. With `%s` the stub wrote a literal backslash-n, which the
    // script correctly read as a non-numeric answer, so two of these tests
    // failed for a reason that had nothing to do with what they claim (L165).
    `#!/usr/bin/env bash\nprintf '%b' ${JSON.stringify(stdout)}\nprintf '%b' ${JSON.stringify(stderr)} >&2\nexit ${code}\n`,
  )
  chmodSync(gh, 0o755)

  const errFile = path.join(dir, 'stderr.txt')
  const age = execFileSync('bash', ['-c', `bash "$0" 2>"$1"`, SCRIPT, errFile], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh },
  }).trim()
  return { age, reason: readFileSync(errFile, 'utf8') }
}

describe('deploy-inflight-age: a deploy really is in flight', () => {
  it('answers with the age in seconds', () => {
    expect(askWith('312\n', 0).age).toBe('312')
  })

  it('says so on stderr, naming the age', () => {
    expect(askWith('312\n', 0).reason).toMatch(/312/)
  })
})

describe('deploy-inflight-age: no deploy is in flight', () => {
  it('answers empty, which is what lets the gate judge the settled state', () => {
    expect(askWith('', 0).age).toBe('')
  })

  it('reports that it asked and got a definite no', () => {
    // The distinction this whole script exists for. An empty answer is only
    // trustworthy when the query is known to have succeeded, so the run log has
    // to be able to show which of the two happened.
    expect(askWith('', 0).reason).toMatch(/none/)
  })
})

describe('deploy-inflight-age: the query itself failed', () => {
  it('answers `unavailable`, never empty', () => {
    // Empty here is the bug being fixed: it reads as "no deploy is running" and
    // pages during a perfectly healthy deploy.
    expect(askWith('', 1, 'HTTP 403: Resource not accessible by integration').age).toBe(
      'unavailable',
    )
  })

  it('quotes what the query said, so the reason is diagnosable from the run log', () => {
    const { reason } = askWith('', 1, 'HTTP 403: Resource not accessible by integration')
    expect(reason).toMatch(/unavailable/)
    expect(reason).toMatch(/403/)
  })

  it('is `unavailable` even when the failing query printed something on stdout', () => {
    // A non-zero exit is the verdict, never the output. Judging by the output
    // would let a tool's own error text stand in for an answer (L184).
    expect(askWith('421\n', 1).age).toBe('unavailable')
  })
})

describe('deploy-inflight-age: the query answered something unusable', () => {
  it('is `unavailable` when the answer is not a whole number of seconds', () => {
    expect(askWith('probably\n', 0).age).toBe('unavailable')
  })

  it('is not fooled into `unavailable` by a warning on stderr of a SUCCEEDING query', () => {
    // gh writes deprecation and upgrade notices to stderr on perfectly good
    // calls. Folding stderr into the answer would turn every one of those into
    // a non-numeric reading, so the check would report itself broken for the
    // rest of its life on a cosmetic notice.
    expect(askWith('96\n', 0, 'gh: a new release is available').age).toBe('96')
  })
})

/**
 * GitHub answers a run list filtered on two fields at once from an index that can
 * lag the run itself (#1650, LESSONS L1014). On 2026-09-30 Deploy Drift run
 * 36731631369 asked `gh run list --workflow <Deploy> --branch main` a minute
 * after Deploy run 36731518395 started, was told nothing was running, and paged
 * a stranded worker that was mid deploy. The site and tail jobs asked the same
 * question a minute later and saw the run at 126s and 131s.
 *
 * So the script lists the workflow's recent runs by the workflow alone and
 * applies the branch and status predicate itself. The stub below behaves like
 * that stale index: asked with `--branch` it omits the run that has just
 * started, asked without it the run is there. It also honours `--json` and
 * `--jq` for real, so the script's own filter runs over the fixture and a field
 * the script forgets to request is absent, as it would be from gh.
 */
type ListedRun = {
  status: string
  headBranch: string
  createdAgo: number
  staleUnderBranchFilter?: boolean
}

const askLikeGitHub = (runs: ListedRun[]): { age: string; reason: string; calls: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inflight-index-'))
  const now = Math.floor(Date.now() / 1000)
  const asJson = (rs: ListedRun[]): string =>
    JSON.stringify(
      rs.map((r) => ({
        status: r.status,
        headBranch: r.headBranch,
        createdAt: new Date((now - r.createdAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        databaseId: 1,
      })),
    )
  writeFileSync(path.join(dir, 'full.json'), asJson(runs))
  writeFileSync(path.join(dir, 'stale.json'), asJson(runs.filter((r) => !r.staleUnderBranchFilter)))
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `DIR=${JSON.stringify(dir)}`,
      'printf \'%s\\n\' "$*" >>"$DIR/calls.txt"',
      // Asked with a branch, answer as gh would (only that branch) but from the
      // stale index, which has not yet seen the run that just started.
      'FILE="$DIR/full.json"; BRANCH=""; FIELDS=""; FILTER="."',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --branch|-b) FILE="$DIR/stale.json"; BRANCH="$2"; shift ;;',
      '    --branch=*) FILE="$DIR/stale.json"; BRANCH="${1#--branch=}" ;;',
      '    --json) FIELDS="$2"; shift ;;',
      '    --jq) FILTER="$2"; shift ;;',
      '  esac',
      '  shift',
      'done',
      'jq -c --arg b "$BRANCH" --arg f "$FIELDS" \'map(select($b == "" or .headBranch == $b)) | ($f | split(",")) as $k | map(with_entries(select(.key as $x | $k | index($x))))\' "$FILE" | jq -r "$FILTER"',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
  const errFile = path.join(dir, 'stderr.txt')
  const age = execFileSync('bash', ['-c', `bash "$0" 2>"$1"`, SCRIPT, errFile], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh },
  }).trim()
  return {
    age,
    reason: readFileSync(errFile, 'utf8'),
    calls: readFileSync(path.join(dir, 'calls.txt'), 'utf8'),
  }
}

describe('deploy-inflight-age: a run the branch filtered index has not caught up with (#1650)', () => {
  it('still sees the Deploy run that has just started on main', () => {
    const { age } = askLikeGitHub([
      { status: 'in_progress', headBranch: 'main', createdAgo: 70, staleUnderBranchFilter: true },
      { status: 'completed', headBranch: 'main', createdAgo: 3600 },
    ])
    expect(age).toMatch(/^\d+$/)
    expect(Number(age)).toBeGreaterThanOrEqual(65)
    expect(Number(age)).toBeLessThan(200)
  })

  it('asks by the workflow alone, never with a branch filter', () => {
    const { calls } = askLikeGitHub([{ status: 'completed', headBranch: 'main', createdAgo: 3600 }])
    expect(calls).toMatch(/run list/)
    expect(calls).not.toMatch(/--branch|(^|\s)-b(\s|$)/)
  })

  it('ignores a run in flight on another branch, and says the answer is about main', () => {
    const { age, reason } = askLikeGitHub([
      { status: 'in_progress', headBranch: 'some-feature', createdAgo: 40 },
      { status: 'completed', headBranch: 'main', createdAgo: 3600 },
    ])
    expect(age).toBe('')
    expect(reason).toMatch(/none/)
    expect(reason).toMatch(/main/)
  })

  it('measures the oldest in-flight run on main, not a newer queued one or another branch', () => {
    const { age } = askLikeGitHub([
      { status: 'queued', headBranch: 'main', createdAgo: 20 },
      { status: 'in_progress', headBranch: 'other', createdAgo: 5000 },
      { status: 'in_progress', headBranch: 'main', createdAgo: 400, staleUnderBranchFilter: true },
    ])
    expect(Number(age)).toBeGreaterThanOrEqual(395)
    expect(Number(age)).toBeLessThan(600)
  })
})
