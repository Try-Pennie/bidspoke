import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * What the drift alert says happened to the newest Deploy on main (#3152).
 *
 * On 2026-10-30 Deploy Drift posted "Worker code is committed but not deployed"
 * a minute after the Deploy of 463814f failed at Verify (worker tests), and the
 * message could only say "a deploy failed at Verify, or a merge started no
 * Deploy". The newest Deploy run on main already answers which, so the alert
 * now quotes it. Every answer is one sentence, and a lookup that fails says the
 * cause is unknown rather than guessing (L11).
 *
 * Driven through a stub `gh` that answers the run list and a run's jobs in
 * GitHub's shapes and applies the script's own `--jq` filters with jq.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-latest-outcome.sh')

type Run = {
  id: number
  status?: string
  conclusion?: string
  headBranch?: string
  createdAt: string
  /** Job names and conclusions of the run's latest attempt, or 'fail' when the jobs cannot be read. */
  jobs?: Array<{ name: string; conclusion: string | null }> | 'fail'
}

const outcome = (runs: Run[] | 'fail'): { code: number; out: string; err: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-outcome-'))
  if (runs !== 'fail') {
    writeFileSync(
      path.join(dir, 'runs.json'),
      JSON.stringify(
        runs.map((r) => ({
          databaseId: r.id,
          status: r.status ?? 'completed',
          conclusion: r.conclusion ?? 'success',
          headBranch: r.headBranch ?? 'main',
          headSha: `${r.id}`.padEnd(40, 'a'),
          createdAt: r.createdAt,
          url: `https://github.com/o/r/actions/runs/${r.id}`,
        })),
      ),
    )
    for (const r of runs) {
      if (r.jobs === 'fail') continue
      writeFileSync(
        path.join(dir, `jobs-${r.id}.json`),
        JSON.stringify({ jobs: (r.jobs ?? []).map((j) => ({ ...j, status: 'completed' })) }),
      )
    }
  }
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `DIR=${JSON.stringify(dir)}`,
      'SUB="$1"; shift',
      'FILTER="."; ENDPOINT=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --jq) FILTER="$2"; shift ;;',
      '    --json|--limit) shift ;;',
      '    --*) ;;',
      '    *) [ -z "$ENDPOINT" ] && ENDPOINT="$1" ;;',
      '  esac',
      '  shift',
      'done',
      'if [ "$SUB" = api ]; then',
      '  ID=$(printf \'%s\' "$ENDPOINT" | sed -n \'s|^repos/{owner}/{repo}/actions/runs/\\([0-9]*\\)/jobs.*|\\1|p\')',
      '  [ -f "$DIR/jobs-$ID.json" ] || { echo "HTTP 502 for run $ID" >&2; exit 1; }',
      '  jq -r "$FILTER" "$DIR/jobs-$ID.json"; exit $?',
      'fi',
      '[ -f "$DIR/runs.json" ] || { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }',
      'jq -r "$FILTER" "$DIR/runs.json"',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, GH_BIN: gh }, timeout: 20_000 })
  return { code: result.status ?? -1, out: result.stdout.trim(), err: result.stderr }
}

const FAILED_AT_VERIFY: Run = {
  id: 41141109203,
  conclusion: 'failure',
  createdAt: '2026-10-30T22:54:03Z',
  jobs: [
    { name: 'Detect changed paths', conclusion: 'success' },
    { name: 'Verify (worker tests)', conclusion: 'failure' },
    { name: 'Deploy', conclusion: 'skipped' },
  ],
}
const OLDER_SUCCESS: Run = { id: 41136865150, createdAt: '2026-10-30T22:15:11Z' }

describe('deploy-latest-outcome: what happened to the newest Deploy on main (#3152)', () => {
  it('names the step that failed, links the run and gives its commit', () => {
    const r = outcome([OLDER_SUCCESS, FAILED_AT_VERIFY])
    expect(r.code).toBe(0)
    expect(r.out).toBe(
      'The newest Deploy run on main, <https://github.com/o/r/actions/runs/41141109203|run 41141109203> for `4114110`, failed at Verify (worker tests).',
    )
  })

  it('names every failed job when more than one failed', () => {
    const jobs = [
      { name: 'Verify (web tests)', conclusion: 'failure' },
      { name: 'Verify (worker tests)', conclusion: 'failure' },
    ]
    expect(outcome([{ ...FAILED_AT_VERIFY, jobs }]).out).toMatch(/failed at Verify \(web tests\), Verify \(worker tests\)\.$/)
  })

  it('says the run failed but the step is unknown when its jobs cannot be read', () => {
    const r = outcome([{ ...FAILED_AT_VERIFY, jobs: 'fail' }])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/run 41141109203> for `4114110`, failed, and which step failed could not be read\.$/)
  })

  it('reports a newest run that succeeded as success, which means no Deploy has run since its commit', () => {
    expect(outcome([OLDER_SUCCESS]).out).toBe(
      'The newest Deploy run on main, <https://github.com/o/r/actions/runs/41136865150|run 41136865150> for `4113686`, succeeded, so no Deploy has run on main since that commit.',
    )
  })

  it('reports a cancelled run by its conclusion', () => {
    expect(outcome([{ ...OLDER_SUCCESS, conclusion: 'cancelled' }]).out).toMatch(/, finished as cancelled\.$/)
  })

  it('reports a run still going as still running', () => {
    expect(outcome([{ ...OLDER_SUCCESS, status: 'in_progress', conclusion: '' }]).out).toMatch(/, is still running\.$/)
  })

  it('judges only runs on main, newest by creation time', () => {
    const branch: Run = { id: 99, headBranch: 'feature', conclusion: 'failure', createdAt: '2026-10-30T23:30:00Z' }
    expect(outcome([FAILED_AT_VERIFY, branch, OLDER_SUCCESS]).out).toContain('run 41141109203>')
  })

  it('says so when no Deploy run on main is listed', () => {
    expect(outcome([]).out).toBe('No Deploy run on main is among the newest 20 Deploy runs, so no Deploy has run for this commit.')
  })

  it('says the cause is unknown when the run list cannot be read, and logs why', () => {
    const r = outcome('fail')
    expect(r.code).toBe(0)
    expect(r.out).toBe('The newest Deploy run on main could not be read, so why the deploy did not land is unknown.')
    expect(r.err).toContain('Resource not accessible by integration')
  })
})
