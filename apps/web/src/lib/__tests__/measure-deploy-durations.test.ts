import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CEILING_FILE } from './_deploy-inflight-ceiling'
import { REPO_ROOT } from './_scan-utils'

/**
 * The measurement the in-flight ceilings are set from (#2409, L316).
 *
 * The ceilings in deploy-inflight-ceiling.sh carry the numbers they came from,
 * and this script is how those numbers are re-taken. It must measure running
 * time through the same deploy-running-seconds.jq the drift check judges a live
 * run by (L107), and it must refuse to print a distribution over fewer runs
 * than it says, because a ceiling set from a quietly partial sample is the
 * wrong ceiling.
 *
 * Driven through a stub `gh` that answers the run list and each run's jobs in
 * GitHub's shapes and applies the script's own `--jq` filters with jq.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/measure-deploy-durations.sh')

type Run = {
  id: number
  status?: string
  conclusion?: string
  headBranch?: string
  attempt?: number
  /** Seconds from creation to finish. */
  age: number
  /** Seconds of running, laid down as one job from creation. */
  running: number
  jobsFail?: boolean
}

const measure = (runs: Run[], limit?: string): { code: number; out: string; err: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'measure-deploys-'))
  const base = Date.parse('2026-10-18T00:00:00Z') / 1000
  const iso = (s: number): string => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    path.join(dir, 'runs.json'),
    JSON.stringify(
      runs.map((r, i) => ({
        databaseId: r.id,
        status: r.status ?? 'completed',
        conclusion: r.conclusion ?? 'success',
        headBranch: r.headBranch ?? 'main',
        attempt: r.attempt ?? 1,
        headSha: `abcdef${i}`.padEnd(40, '0'),
        createdAt: iso(base + i * 3600),
        updatedAt: iso(base + i * 3600 + r.age),
      })),
    ),
  )
  runs.forEach((r, i) => {
    if (r.jobsFail) return
    const start = base + i * 3600
    writeFileSync(
      path.join(dir, `jobs-${r.id}.json`),
      JSON.stringify({
        jobs: [
          {
            status: 'completed',
            conclusion: 'success',
            created_at: iso(start),
            started_at: iso(start),
            completed_at: iso(start + r.running),
          },
        ],
      }),
    )
  })
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
      'jq -r "$FILTER" "$DIR/runs.json"',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
  const result = spawnSync('bash', limit === undefined ? [SCRIPT] : [SCRIPT, limit], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh },
  })
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr }
}

const TEN = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, age: (i + 1) * 300, running: (i + 1) * 100 }))

describe('measure-deploy-durations', () => {
  it('prints the distribution of running time and age over the qualifying runs', () => {
    const { code, out } = measure(TEN)
    expect(code).toBe(0)
    expect(out).toMatch(/^deploy-durations: runs=10 /m)
    expect(out).toMatch(/^running min=100 p50=500 p90=900 p95=1000 p99=1000 max=1000$/m)
    expect(out).toMatch(/^age min=300 p50=1500 p90=2700 p95=3000 p99=3000 max=3000$/m)
  })

  it('prints one line per run, so a reading can be traced to the run it came from', () => {
    const { out } = measure(TEN)
    expect(out.match(/^run /gm)).toHaveLength(10)
    expect(out).toMatch(/^run 104 abcdef4 \S+ age=1500 running=500$/m)
  })

  it('measures only successful first attempts on main', () => {
    const { out } = measure([
      ...TEN,
      { id: 201, conclusion: 'failure', age: 99999, running: 99999 },
      { id: 202, attempt: 2, age: 99999, running: 99999 },
      { id: 203, headBranch: 'feature', age: 99999, running: 99999 },
      { id: 204, status: 'in_progress', conclusion: '', age: 99999, running: 99999 },
    ])
    expect(out).toMatch(/runs=10 /)
    expect(out).not.toMatch(/99999/)
  })

  it('fails, naming the run, rather than measuring fewer runs than it says when a jobs list cannot be read', () => {
    const { code, out, err } = measure([...TEN, { id: 301, age: 600, running: 500, jobsFail: true }])
    expect(code).not.toBe(0)
    expect(err).toMatch(/301/)
    expect(out).not.toMatch(/^running /m)
  })

  it('fails when no run qualifies, since an empty measurement is not a measurement', () => {
    const { code, err } = measure([{ id: 401, conclusion: 'failure', age: 600, running: 500 }])
    expect(code).not.toBe(0)
    expect(err).toMatch(/nothing to measure/)
  })

  it('refuses a run count that is not a number', () => {
    expect(measure(TEN, 'lots').code).not.toBe(0)
  })

  it('measures running time through the same filter the drift check judges by (L107)', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/deploy-running-seconds\.jq/)
    expect(
      readFileSync(path.join(REPO_ROOT, '.github/scripts/deploy-inflight-age.sh'), 'utf8'),
    ).toMatch(/deploy-running-seconds\.jq/)
  })

  it('is the command the ceilings name as their measurement, so they can be re-taken (L316)', () => {
    expect(readFileSync(CEILING_FILE, 'utf8')).toMatch(/measure-deploy-durations\.sh/)
  })
})
