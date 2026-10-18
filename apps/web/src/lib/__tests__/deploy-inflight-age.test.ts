import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { execScriptSync, SCRIPT_TEST_TIMEOUT_MS } from './_script-deadline'

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
 * Time is SET here, never read off the machine (#2432, L290).
 *
 * The script measures every age as jq's `now` minus a timestamp. The stub gh
 * runs the script's own filters with `now` defined as this instant, so every
 * age and running time is exact. Read off the real clock instead, each answer
 * drifted by however long the machine took to run the script, and the
 * assertions carried windows (312 to 319s, 250 to 270s) that were a statement
 * about how loaded the machine was.
 */
const NOW = 1_792_000_000

/**
 * One run of the script, killed as hung at the shared deadline (#2432, see
 * _script-deadline.ts for why vitest's own timeout cannot do that).
 *
 * The work is bounded: a run is about 15 short processes (the script, the stub
 * gh and jq for the run list, then the same for each in-flight run's jobs), with
 * no sleep and no loop that can spin. Measured on 2026-10-18 on a 14 core
 * MacBook: about 45 ms a test alone, and at most 1.9 s for one test in a full
 * web run with 42 CPU burners beside it (the first test, which also pays the
 * stubs' first exec, below), against a 20 s deadline.
 */
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS })

/**
 * The stub gh executables are written ONCE for the file, and each test tells
 * them where its own fixture lives through STUB_DATA (#2432).
 *
 * On this Mac the first exec of a freshly written executable costs about 100 ms
 * and every later one about 4 ms (measured 2026-10-18 over 10 fresh files: 98 ms
 * first, 4 ms second; 108 ms first with 42 CPU burners running). Writing a new
 * stub per test paid that on every test, and that cost is not this test's CPU,
 * so it grows with whatever else on the machine is starting new executables,
 * which in a full web run is every other script test.
 */
const STUBS = mkdtempSync(path.join(tmpdir(), 'inflight-stubs-'))
const writeStub = (name: string, lines: string[]): string => {
  const file = path.join(STUBS, name)
  writeFileSync(file, lines.join('\n'))
  chmodSync(file, 0o755)
  return file
}

const runScript = (gh: string, data: string): { age: string; reason: string } => {
  const errFile = path.join(data, 'stderr.txt')
  const age = execScriptSync('deploy-inflight-age.sh', 'bash', ['-c', `bash "$0" 2>"$1"`, SCRIPT, errFile], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh, STUB_DATA: data },
  }).trim()
  return { age, reason: readFileSync(errFile, 'utf8') }
}

/** One job of a Deploy run, with its times given as seconds before now. */
type ListedJob = {
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: string
  /** Seconds ago the job was created (and, for a queued job, its started_at too, as GitHub reports it). */
  createdAgo: number
  /** Seconds ago it got a runner. Omitted for a queued job, which GitHub reports as started when created. */
  startedAgo?: number
  /** Seconds ago it finished, or omitted while it has not. */
  completedAgo?: number
}

type ListedRun = {
  id?: number
  status: string
  headBranch: string
  createdAgo: number
  staleUnderBranchFilter?: boolean
  jobs?: ListedJob[]
  /** Makes `gh api` for this run's jobs fail with this text. */
  jobsFail?: string
  /** The total_count GitHub reports, when it should differ from the jobs listed. */
  totalCount?: number
}

type Asked = { age: string; reason: string; calls: string }

const iso = (now: number, ago: number): string =>
  new Date((now - ago) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Runs the real script against a stub `gh` that behaves like GitHub.
 *
 * `gh run list` answers from the run fixtures. Asked with `--branch` it answers
 * from a stale index that has not seen a run that just started (#1650), asked
 * without it the run is there. It honours `--json` and `--jq` for real, so the
 * script's own filter runs over the fixture and a field the script forgets to
 * request is absent, as it would be from gh.
 *
 * `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs` answers with that run's
 * jobs in GitHub's shape and applies the script's `--jq` filter to them, which
 * is the shared deploy-running-seconds.jq. A queued job carries a started_at
 * equal to its created_at, as GitHub's does (read live from run 39141958054).
 *
 * Both run the script's filter with jq's `now` defined as NOW, so the clock is
 * set rather than read. The stub does its own parsing with shell builtins and
 * runs one jq per call, because every extra process it starts is time the test
 * spends waiting on the machine (#2432).
 */
const GH_LIKE_GITHUB = writeStub('gh-like-github', [
  '#!/usr/bin/env bash',
  'DIR="$STUB_DATA"',
  'printf \'%s\\n\' "$*" >>"$DIR/calls.txt"',
  'SUB="$1"; shift',
  'FILE="$DIR/full.json"; BRANCH=""; FIELDS=""; FILTER="."; ENDPOINT=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    --branch|-b) FILE="$DIR/stale.json"; BRANCH="$2"; shift ;;',
  '    --branch=*) FILE="$DIR/stale.json"; BRANCH="${1#--branch=}" ;;',
  '    --json) FIELDS="$2"; shift ;;',
  '    --jq) FILTER="$2"; shift ;;',
  '    --*) ;;',
  '    *) [ "$SUB" = api ] && [ -z "$ENDPOINT" ] && ENDPOINT="$1" ;;',
  '  esac',
  '  shift',
  'done',
  // jq reads `now` as this fixed instant, so the clock is set, not read.
  `CLOCK='def now: ${NOW};'`,
  'if [ "$SUB" = api ]; then',
  '  PREFIX="repos/{owner}/{repo}/actions/runs/"',
  '  ID=${ENDPOINT#"$PREFIX"}; ID=${ID%%/jobs*}',
  '  case "$ENDPOINT" in "$PREFIX"*/jobs*) ;; *) ID="" ;; esac',
  '  case "$ID" in "" | *[!0-9]*) echo "stub gh: unexpected endpoint $ENDPOINT" >&2; exit 9 ;; esac',
  '  if [ -f "$DIR/jobs-$ID.fail" ]; then IFS= read -r WHY <"$DIR/jobs-$ID.fail"; printf \'%s\\n\' "$WHY" >&2; exit 1; fi',
  '  jq -r "$CLOCK $FILTER" "$DIR/jobs-$ID.json"',
  '  exit $?',
  'fi',
  'if [ -f "$DIR/list-stderr" ]; then IFS= read -r -d \'\' E <"$DIR/list-stderr"; printf \'%s\' "$E" >&2; fi',
  'jq -r --arg b "$BRANCH" --arg f "$FIELDS" "$CLOCK"\' map(select($b == "" or .headBranch == $b)) | ($f | split(",")) as $k | map(with_entries(select(.key as $x | $k | index($x)))) | \'"($FILTER)" "$FILE"',
  '',
])

const askLikeGitHub = (runs: ListedRun[], listStderr = ''): Asked => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inflight-index-'))
  const now = NOW
  const withIds = runs.map((r, i) => ({ ...r, id: r.id ?? 1000 + i }))
  const asJson = (rs: typeof withIds): string =>
    JSON.stringify(
      rs.map((r) => ({
        status: r.status,
        headBranch: r.headBranch,
        createdAt: iso(now, r.createdAgo),
        databaseId: r.id,
      })),
    )
  writeFileSync(path.join(dir, 'full.json'), asJson(withIds))
  writeFileSync(path.join(dir, 'stale.json'), asJson(withIds.filter((r) => !r.staleUnderBranchFilter)))
  for (const r of withIds) {
    if (r.jobsFail !== undefined) {
      writeFileSync(path.join(dir, `jobs-${r.id}.fail`), r.jobsFail)
      continue
    }
    const jobs = (r.jobs ?? []).map((j, k) => ({
      id: k,
      name: `job ${k}`,
      status: j.status,
      conclusion: j.conclusion ?? (j.status === 'completed' ? 'success' : null),
      created_at: iso(now, j.createdAgo),
      started_at: iso(now, j.startedAgo ?? j.createdAgo),
      completed_at: j.completedAgo === undefined ? null : iso(now, j.completedAgo),
    }))
    writeFileSync(path.join(dir, `jobs-${r.id}.json`), JSON.stringify({ total_count: r.totalCount ?? jobs.length, jobs }))
  }
  if (listStderr) writeFileSync(path.join(dir, 'list-stderr'), listStderr)
  const { age, reason } = runScript(GH_LIKE_GITHUB, dir)
  let calls = ''
  try {
    calls = readFileSync(path.join(dir, 'calls.txt'), 'utf8')
  } catch {
    calls = ''
  }
  return { age, reason, calls }
}

/** Splits `age=<s>,running=<s|unknown>` into its two parts, failing loudly on any other shape. */
const parse = (answer: string): { age: number; running: number | 'unknown' } => {
  const m = answer.match(/^age=(\d+),running=(\d+|unknown)$/)
  if (!m) throw new Error(`not an in-flight answer: '${answer}'`)
  return { age: Number(m[1]), running: m[2] === 'unknown' ? 'unknown' : Number(m[2]) }
}

/**
 * A fake `gh` that prints a fixed stdout and stderr and exits with a fixed code
 * for every call, for the cases where the run list itself fails or answers
 * nonsense. Each test's answer is read from its STUB_DATA directory.
 *
 * `%b` so an escape in the fixture becomes a real newline, the way gh's own
 * output arrives. With `%s` the stub wrote a literal backslash-n, which the
 * script correctly read as a non-numeric answer, so two of these tests failed
 * for a reason that had nothing to do with what they claim (L165).
 */
const GH_FIXED = writeStub('gh-fixed', [
  '#!/usr/bin/env bash',
  'DIR="$STUB_DATA"',
  'IFS= read -r -d \'\' OUT <"$DIR/gh-stdout"',
  'IFS= read -r -d \'\' ERR <"$DIR/gh-stderr"',
  'IFS= read -r CODE <"$DIR/gh-code"',
  'printf \'%b\' "$OUT"',
  'printf \'%b\' "$ERR" >&2',
  'exit "$CODE"',
  '',
])

const askWith = (stdout: string, code: number, stderr = ''): { age: string; reason: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inflight-'))
  writeFileSync(path.join(dir, 'gh-stdout'), stdout)
  writeFileSync(path.join(dir, 'gh-stderr'), stderr)
  writeFileSync(path.join(dir, 'gh-code'), `${code}\n`)
  return runScript(GH_FIXED, dir)
}

/** A run that has been in flight 312s, one job finished after 200s of running and one still going for 50s. */
const RUN_312: ListedRun = {
  status: 'in_progress',
  headBranch: 'main',
  createdAgo: 312,
  jobs: [
    { status: 'completed', createdAgo: 312, startedAgo: 310, completedAgo: 110 },
    { status: 'in_progress', createdAgo: 110, startedAgo: 50 },
  ],
}

describe('deploy-inflight-age: a deploy really is in flight', () => {
  it('answers with its age and how long it has been running', () => {
    const { age, running } = parse(askLikeGitHub([RUN_312]).age)
    expect(age).toBe(312)
    expect(running).toBe(250)
  })

  it('says so on stderr, naming the age', () => {
    expect(askLikeGitHub([RUN_312]).reason).toMatch(/in flight 312s/)
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
    expect(askWith('7 421\n', 1).age).toBe('unavailable')
  })
})

describe('deploy-inflight-age: the query answered something unusable', () => {
  // One run of the script per test, so no test holds more than one deadline's
  // worth of work under the test timeout (#2432).
  it.each(['probably\n', '7 soon\n', '421\n'])(
    'is `unavailable` when the answer is not a run id and a whole number of seconds (%j)',
    (answer) => {
      expect(askWith(answer, 0).age).toBe('unavailable')
    },
  )

  it('is not fooled into `unavailable` by a warning on stderr of a SUCCEEDING query', () => {
    // gh writes deprecation and upgrade notices to stderr on perfectly good
    // calls. Folding stderr into the answer would turn every one of those into
    // a non-numeric reading, so the check would report itself broken for the
    // rest of its life on a cosmetic notice.
    expect(askLikeGitHub([RUN_312], 'gh: a new release is available').age).toMatch(/^age=\d+,running=\d+$/)
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
 * applies the branch and status predicate itself.
 */
describe('deploy-inflight-age: a run the branch filtered index has not caught up with (#1650)', () => {
  it('still sees the Deploy run that has just started on main', () => {
    const { age } = askLikeGitHub([
      { status: 'in_progress', headBranch: 'main', createdAgo: 70, staleUnderBranchFilter: true },
      { status: 'completed', headBranch: 'main', createdAgo: 3600 },
    ])
    const parsed = parse(age)
    expect(parsed.age).toBe(70)
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
    const parsed = parse(age)
    expect(parsed.age).toBe(400)
  })
})

/**
 * Running time, as distinct from age (#2409).
 *
 * The 15:01:03 UTC drift run on 2026-10-18 paged a stuck deploy at 1483s while
 * Deploy for 50841f3 was healthy. Its jobs had held a runner for 753s by then;
 * the rest was jobs created and waiting for a runner that Deploy for 49c3f3c and
 * pull request CI were using. The fixture below is that run at that instant,
 * from its real job timings (run 39136855091), as seconds before the instant.
 */
const RUN_50841F3_AT_1483: ListedRun = {
  status: 'in_progress',
  headBranch: 'main',
  createdAgo: 1483,
  jobs: [
    // The four Verify legs and Detect changed paths, 14:37:49 to 14:44:47.
    { status: 'completed', createdAgo: 1483, startedAgo: 1481, completedAgo: 1063 },
    { status: 'completed', createdAgo: 1483, startedAgo: 1481, completedAgo: 1476 },
    { status: 'completed', createdAgo: 1483, startedAgo: 1481, completedAgo: 1224 },
    { status: 'completed', createdAgo: 1483, startedAgo: 1456, completedAgo: 1065 },
    { status: 'completed', createdAgo: 1483, startedAgo: 1474, completedAgo: 1427 },
    // Verify, after waiting 36s.
    { status: 'completed', createdAgo: 1063, startedAgo: 1027, completedAgo: 1025 },
    // Four jobs created 14:45:26 that waited 490s to 609s for a runner.
    { status: 'completed', createdAgo: 1024, startedAgo: 447, completedAgo: 404 },
    { status: 'completed', createdAgo: 1024, startedAgo: 534, completedAgo: 497 },
    { status: 'completed', createdAgo: 1024, startedAgo: 486, completedAgo: 441 },
    { status: 'completed', createdAgo: 1024, startedAgo: 415, completedAgo: 376 },
    // Deploy Worker, then Deploy Ops Worker and Deploy Pages, still running.
    { status: 'completed', createdAgo: 441, startedAgo: 296, completedAgo: 259 },
    { status: 'completed', createdAgo: 259, startedAgo: 147, completedAgo: 89 },
    { status: 'in_progress', createdAgo: 259, startedAgo: 149 },
  ],
}

describe('deploy-inflight-age: time spent waiting for a runner is not running time (#2409)', () => {
  it('reads the 2026-10-18 run as 1483s old and about 753s running', () => {
    const { age, running } = parse(askLikeGitHub([RUN_50841F3_AT_1483]).age)
    expect(age).toBe(1483)
    expect(running).toBe(753)
  })

  it('does not count a queued job as running from when it was created, though GitHub gives it a started_at', () => {
    const { running } = parse(
      askLikeGitHub([
        {
          status: 'queued',
          headBranch: 'main',
          createdAgo: 900,
          jobs: [
            { status: 'completed', createdAgo: 900, startedAgo: 898, completedAgo: 800 },
            { status: 'queued', createdAgo: 800 },
          ],
        },
      ]).age,
    )
    expect(running).toBe(98)
  })

  it('counts a job that overlaps another once, not twice', () => {
    const { running } = parse(
      askLikeGitHub([
        {
          status: 'in_progress',
          headBranch: 'main',
          createdAgo: 600,
          jobs: [
            { status: 'completed', createdAgo: 600, startedAgo: 600, completedAgo: 300 },
            { status: 'completed', createdAgo: 600, startedAgo: 500, completedAgo: 400 },
            { status: 'completed', createdAgo: 600, startedAgo: 350, completedAgo: 200 },
          ],
        },
      ]).age,
    )
    expect(running).toBe(400)
  })

  it('ignores a skipped job, which GitHub reports as finishing before it started', () => {
    const { running } = parse(
      askLikeGitHub([
        {
          status: 'in_progress',
          headBranch: 'main',
          createdAgo: 600,
          jobs: [
            { status: 'completed', createdAgo: 600, startedAgo: 600, completedAgo: 500 },
            { status: 'completed', conclusion: 'skipped', createdAgo: 400, startedAgo: 400, completedAgo: 401 },
          ],
        },
      ]).age,
    )
    expect(running).toBe(100)
  })

  it('ends a job at its completed_at even when its status still reads in_progress', () => {
    // Read from run 39080707265: "Detect changed paths" reported in_progress
    // with completed_at set long after the run had finished. Ending it at now
    // measured a 10 minute run as 16 hours of running.
    const { running } = parse(
      askLikeGitHub([
        {
          status: 'in_progress',
          headBranch: 'main',
          createdAgo: 60000,
          jobs: [{ status: 'in_progress', conclusion: 'success', createdAgo: 60000, startedAgo: 59998, completedAgo: 59992 }],
        },
      ]).age,
    )
    expect(running).toBe(6)
  })

  it('reports the longest running of several in-flight runs, with the age of the oldest', () => {
    const { age, running } = parse(
      askLikeGitHub([
        {
          status: 'in_progress',
          headBranch: 'main',
          createdAgo: 1200,
          jobs: [
            { status: 'completed', createdAgo: 1200, startedAgo: 1200, completedAgo: 1100 },
            { status: 'queued', createdAgo: 1100 },
          ],
        },
        {
          status: 'in_progress',
          headBranch: 'main',
          createdAgo: 700,
          jobs: [{ status: 'in_progress', createdAgo: 700, startedAgo: 650 }],
        },
      ]).age,
    )
    expect(age).toBe(1200)
    expect(running).toBe(650)
  })

  it('asks for the jobs of exactly the runs in flight on main', () => {
    const { calls } = askLikeGitHub([
      { id: 11, status: 'in_progress', headBranch: 'main', createdAgo: 100, jobs: [] },
      { id: 22, status: 'completed', headBranch: 'main', createdAgo: 3000 },
      { id: 33, status: 'in_progress', headBranch: 'other', createdAgo: 100 },
    ])
    expect(calls).toMatch(/actions\/runs\/11\/jobs/)
    expect(calls).not.toMatch(/actions\/runs\/(22|33)\/jobs/)
  })

  it('answers the running time as unknown, not the whole query as unavailable, when a run\'s jobs cannot be read', () => {
    // The run list did answer, so a deploy IS in flight. The gate then judges
    // the age in place of the running time, which can only overstate it.
    const { age, reason } = askLikeGitHub([
      { id: 44, status: 'in_progress', headBranch: 'main', createdAgo: 300, jobsFail: 'HTTP 502: Bad Gateway' },
    ])
    expect(parse(age).running).toBe('unknown')
    expect(reason).toMatch(/44/)
    expect(reason).toMatch(/502/)
  })

  it('answers the running time as unknown when the jobs list holds fewer jobs than GitHub says the run has', () => {
    // One page of 100 jobs is read. A run with more would have the rest dropped,
    // which undercounts its running time, the permissive direction.
    const { age, reason } = askLikeGitHub([
      {
        id: 77,
        status: 'in_progress',
        headBranch: 'main',
        createdAgo: 300,
        totalCount: 101,
        jobs: [{ status: 'completed', createdAgo: 300, startedAgo: 300, completedAgo: 200 }],
      },
    ])
    expect(parse(age).running).toBe('unknown')
    expect(reason).toMatch(/77/)
  })

  it('is unknown if ANY in-flight run cannot be read, since that run may be the stuck one', () => {
    const { age } = askLikeGitHub([
      { id: 55, status: 'in_progress', headBranch: 'main', createdAgo: 300, jobs: [] },
      { id: 66, status: 'in_progress', headBranch: 'main', createdAgo: 200, jobsFail: 'HTTP 500' },
    ])
    expect(parse(age).running).toBe('unknown')
  })
})
