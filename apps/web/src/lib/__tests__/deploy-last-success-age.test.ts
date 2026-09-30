import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkflow, REPO_ROOT, workflowJobBody } from './_scan-utils'

/**
 * How long ago the last Pages deploy finished, for the propagation grace (#901).
 *
 * A Pages deploy propagates per route, so for a while after the Deploy run has
 * COMPLETED some routes still serve the previous build. The in-flight gate
 * (#790) cannot cover that window, because the run is over. Deploy Drift needs a
 * second reading: the age of the most recent successful Pages upload, so it can
 * excuse a route that is behind while that age is under a measured window.
 *
 * Three rules shape this script, each from a recorded failure:
 *
 *  - It answers with THREE states, like deploy-inflight-age.sh: seconds, an empty
 *    definite "no deploy to excuse", and `unavailable` for a query that failed.
 *    Folding the last two together is what made the in-flight gate cause the
 *    false page it existed to prevent (#899, LESSONS L98).
 *  - It anchors on the Pages upload STEP, not the run or the job, because the job
 *    now goes on to watch the routes flip after uploading, and the run goes on
 *    to check the database. Measuring the window from either end would apply a
 *    grace calibrated against a different instant (L209).
 *  - It reads the NEWEST attempt, not the newest success. A grace that excused a
 *    stale site because an OLDER deploy had succeeded, after a newer one failed,
 *    would hide the very stranding the check exists to report (L458).
 *
 * The stub `gh` below answers with JSON shaped like the live API (captured from
 * run 35241487601 on 2026-09-17), and the script's own jq filters run for real
 * over it, so the fixture exercises the parsing rather than the belief (L52).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-last-success-age.sh')

/** A frozen clock so a fixture's age is exact rather than "about" (L130). */
const NOW = 1_800_000_000

// Whole seconds, as the live API renders them: jq's fromdateiso8601 refuses a
// fractional part, and a fixture the API never produces would fail for a reason
// the test does not claim.
const iso = (secondsAgo: number): string =>
  new Date((NOW - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

type Run = {
  id: number
  status: 'completed' | 'in_progress' | 'queued'
  /** Defaults to main. */
  branch?: string
  /**
   * Absent from a list filtered by branch as well as workflow, the way GitHub's
   * two field index lags a run that has just changed (#1650, LESSONS L1014).
   */
  staleUnderBranchFilter?: boolean
}
type PagesJob =
  | { kind: 'skipped' }
  | { kind: 'failed' }
  | { kind: 'succeeded'; completedAgo: number }
  | { kind: 'succeeded-without-step' }
  | { kind: 'unreadable' }

const jobsJson = (job: PagesJob): string => {
  if (job.kind === 'skipped') {
    return JSON.stringify({ jobs: [{ name: 'Deploy Pages', conclusion: 'skipped', steps: [] }] })
  }
  if (job.kind === 'failed') {
    return JSON.stringify({
      jobs: [
        {
          name: 'Deploy Pages',
          conclusion: 'failure',
          steps: [{ name: 'Deploy to Cloudflare Pages', conclusion: 'failure', completed_at: iso(10) }],
        },
      ],
    })
  }
  if (job.kind === 'succeeded-without-step') {
    return JSON.stringify({
      jobs: [{ name: 'Deploy Pages', conclusion: 'success', steps: [{ name: 'Build', conclusion: 'success' }] }],
    })
  }
  if (job.kind === 'unreadable') return ''
  return JSON.stringify({
    jobs: [
      { name: 'Deploy Worker', conclusion: 'success', steps: [] },
      {
        name: 'Deploy Pages',
        conclusion: 'success',
        steps: [
          { name: 'Build (next-on-pages)', conclusion: 'success', completed_at: iso(job.completedAgo + 40) },
          { name: 'Deploy to Cloudflare Pages', conclusion: 'success', completed_at: iso(job.completedAgo) },
          { name: 'Watch the routes flip', conclusion: 'success', completed_at: iso(job.completedAgo - 90) },
        ],
      },
    ],
  })
}

type Stub = {
  runs?: Run[]
  jobs?: Record<number, PagesJob>
  listFails?: string
  listStderr?: string
}

/** Writes a fake `gh` answering `run list` and `api .../jobs`, and runs the script. */
const askWith = (stub: Stub): { age: string; reason: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'last-success-'))
  const listed = (runs: Run[]): string =>
    JSON.stringify(runs.map((r) => ({ databaseId: r.id, status: r.status, headBranch: r.branch ?? 'main' })))
  const list = listed(stub.runs ?? [])
  // What a branch filtered query would answer: main only, from the lagging index.
  const staleMainList = listed(
    (stub.runs ?? []).filter((r) => (r.branch ?? 'main') === 'main' && !r.staleUnderBranchFilter),
  )
  for (const [id, job] of Object.entries(stub.jobs ?? {})) {
    if (job.kind !== 'unreadable') writeFileSync(path.join(dir, `jobs-${id}.json`), jobsJson(job))
  }
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `DIR=${JSON.stringify(dir)}`,
      'case "$1 $2" in',
      '  "run list")',
      `    printf '%s' ${JSON.stringify(stub.listStderr ?? '')} >&2`,
      stub.listFails !== undefined
        ? `    printf '%s' ${JSON.stringify(stub.listFails)} >&2; exit 1`
        : `    case " $* " in *" --branch"*|*" -b "*) printf '%s' ${JSON.stringify(staleMainList)} ;; *) printf '%s' ${JSON.stringify(list)} ;; esac`,
      '    ;;',
      '  api*)',
      '    ID=$(printf \'%s\' "$2" | sed -E \'s#.*/runs/([0-9]+)/jobs.*#\\1#\')',
      '    [ -f "$DIR/jobs-$ID.json" ] || { echo "HTTP 500: jobs for run $ID could not be read" >&2; exit 1; }',
      '    cat "$DIR/jobs-$ID.json"',
      '    ;;',
      '  *) echo "unexpected gh call: $*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)

  const errFile = path.join(dir, 'stderr.txt')
  const age = execFileSync('bash', ['-c', `bash "$0" 2>"$1"`, SCRIPT, errFile], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh, CLOCK_EPOCH: String(NOW) },
  }).trim()
  return { age, reason: readFileSync(errFile, 'utf8') }
}

describe('deploy-last-success-age: the newest Pages attempt succeeded', () => {
  it('answers with the seconds since the upload step finished', () => {
    const { age } = askWith({
      runs: [{ id: 2, status: 'completed' }],
      jobs: { 2: { kind: 'succeeded', completedAgo: 420 } },
    })
    expect(age).toBe('420')
  })

  it('anchors on the upload step, not the job or the run that went on after it', () => {
    // The job goes on to watch the routes flip and the run goes on to check the
    // database, so their completion times are later than the upload. A grace
    // measured from the upload and applied from a later instant is a longer
    // grace than anybody calibrated (L209). The fixture puts the job's last
    // step 90s after the upload; the answer must not be 330.
    const { age } = askWith({
      runs: [{ id: 2, status: 'completed' }],
      jobs: { 2: { kind: 'succeeded', completedAgo: 420 } },
    })
    expect(age).toBe('420')
  })

  it('names the run it read on stderr', () => {
    const { reason } = askWith({
      runs: [{ id: 77, status: 'completed' }],
      jobs: { 77: { kind: 'succeeded', completedAgo: 5 } },
    })
    expect(reason).toMatch(/77/)
    expect(reason).toMatch(/5s/)
  })

  it('walks past a newer run whose Pages job was skipped, since that run shipped nothing to the site', () => {
    // A worker-only change skips Deploy Pages by its paths filter. That run
    // propagates nothing to the site, so it is not the deploy whose propagation
    // a grace would be excusing.
    const { age } = askWith({
      runs: [
        { id: 3, status: 'completed' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 3: { kind: 'skipped' }, 2: { kind: 'succeeded', completedAgo: 200 } },
    })
    expect(age).toBe('200')
  })

  it('considers only completed runs, leaving a run still in flight to the in-flight gate', () => {
    const { age } = askWith({
      runs: [
        { id: 4, status: 'in_progress' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 4: { kind: 'succeeded', completedAgo: 10 }, 2: { kind: 'succeeded', completedAgo: 200 } },
    })
    expect(age).toBe('200')
  })
})

describe('deploy-last-success-age: there is no deploy to excuse', () => {
  it('answers empty when no recent run attempted a Pages deploy', () => {
    const { age, reason } = askWith({
      runs: [
        { id: 3, status: 'completed' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 3: { kind: 'skipped' }, 2: { kind: 'skipped' } },
    })
    expect(age).toBe('')
    expect(reason).toMatch(/none/)
  })

  it('answers empty when the NEWEST Pages attempt failed, even though an older one succeeded', () => {
    // L458. The site is behind because the newest deploy failed. Excusing it on
    // the strength of the deploy before that would hide the stranding for the
    // whole grace window, which is precisely the case the check exists for.
    const { age, reason } = askWith({
      runs: [
        { id: 3, status: 'completed' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 3: { kind: 'failed' }, 2: { kind: 'succeeded', completedAgo: 60 } },
    })
    expect(age).toBe('')
    expect(reason).toMatch(/3/)
    expect(reason).toMatch(/fail/)
  })

  it('answers empty when the query succeeded and listed no runs at all', () => {
    expect(askWith({ runs: [] }).age).toBe('')
  })
})

describe('deploy-last-success-age: the query could not be answered', () => {
  it('is `unavailable` when listing the runs fails, quoting why', () => {
    const { age, reason } = askWith({ listFails: 'HTTP 403: Resource not accessible by integration' })
    expect(age).toBe('unavailable')
    expect(reason).toMatch(/403/)
  })

  it('is `unavailable` when the jobs of a run cannot be read, never a skip to the next run', () => {
    // A failed read is not "this run attempted nothing". Walking on to an older
    // run would answer with a deploy that is not the newest attempt, which is
    // the L458 mistake reached by a different road (L173, L211).
    const { age } = askWith({
      runs: [
        { id: 3, status: 'completed' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 3: { kind: 'unreadable' }, 2: { kind: 'succeeded', completedAgo: 60 } },
    })
    expect(age).toBe('unavailable')
  })

  it('is `unavailable` when a successful Pages job has no step by the expected name', () => {
    // The step name is load-bearing. If somebody renames it in deploy.yml, this
    // must say so rather than answer "no deploy to excuse" for ever (L305).
    const { age, reason } = askWith({
      runs: [{ id: 2, status: 'completed' }],
      jobs: { 2: { kind: 'succeeded-without-step' } },
    })
    expect(age).toBe('unavailable')
    expect(reason).toMatch(/Deploy to Cloudflare Pages/)
  })

  it('is not fooled into `unavailable` by a warning on stderr of a succeeding query', () => {
    const { age } = askWith({
      runs: [{ id: 2, status: 'completed' }],
      jobs: { 2: { kind: 'succeeded', completedAgo: 30 } },
      listStderr: 'gh: a new release is available',
    })
    expect(age).toBe('30')
  })
})

describe('deploy-last-success-age: a run the branch filtered index has not caught up with (#1650)', () => {
  it('reads the newest completed run even when a branch filtered list would omit it', () => {
    // A branch filtered list would fall back to run 2's older upload, so the
    // grace would be measured from the wrong deploy.
    const { age } = askWith({
      runs: [
        { id: 3, status: 'completed', staleUnderBranchFilter: true },
        { id: 2, status: 'completed' },
      ],
      jobs: { 3: { kind: 'succeeded', completedAgo: 30 }, 2: { kind: 'succeeded', completedAgo: 900 } },
    })
    expect(age).toBe('30')
  })

  it('ignores a completed run on another branch', () => {
    const { age } = askWith({
      runs: [
        { id: 5, status: 'completed', branch: 'some-feature' },
        { id: 2, status: 'completed' },
      ],
      jobs: { 5: { kind: 'succeeded', completedAgo: 10 }, 2: { kind: 'succeeded', completedAgo: 200 } },
    })
    expect(age).toBe('200')
  })
})

describe('deploy-last-success-age: the names it reads are the names deploy.yml declares', () => {
  // Job and step names are load-bearing and nothing else checks them (L305). The
  // script's constants are read here rather than repeated, so this fails on
  // either side moving.
  const script = readFileSync(SCRIPT, 'utf8')
  const jobName = script.match(/^PAGES_JOB_NAME="([^"]+)"/m)?.[1]
  const stepName = script.match(/^PAGES_UPLOAD_STEP_NAME="([^"]+)"/m)?.[1]
  const deploy = readWorkflow('.github/workflows/deploy.yml')

  it('reads the job by a name deploy.yml gives a job', () => {
    expect(jobName, 'the script no longer declares PAGES_JOB_NAME').toBeTruthy()
    expect(deploy).toMatch(new RegExp(`^\\s+name: ${jobName}\\s*$`, 'm'))
  })

  it('reads the upload step by a name deploy.yml gives a step in that job', () => {
    expect(stepName, 'the script no longer declares PAGES_UPLOAD_STEP_NAME').toBeTruthy()
    const job = workflowJobBody(deploy, 'deploy-pages')
    expect(job).toMatch(new RegExp(`^\\s+name: ${jobName}\\s*$`, 'm'))
    expect(job).toMatch(new RegExp(`- name: ${stepName}\\s*$`, 'm'))
  })
})
