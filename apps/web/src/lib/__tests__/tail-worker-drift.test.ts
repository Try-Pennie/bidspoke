import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The tail worker must say which commit it is running, and the drift check must
 * be able to fail on it (#739).
 *
 * `apps/worker-tail` computes per-execution cost attribution and writes
 * `workflow_executions.cost_usd`. A stranded one under-reports what executions
 * cost while the dashboard keeps showing numbers that look fine, which is the
 * worst shape a stranded deploy can take: not an outage, a quietly wrong number
 * that nobody has reason to doubt.
 *
 * It had no way to be checked at all. It has no HTTP surface, so there was
 * nothing to ask. It now has the same one the engine worker has: a fetch handler
 * returning the commit it was deployed from. That is a deliberate choice over
 * reading the deployment metadata through the Cloudflare API, which the issue
 * suggested: one curl needs no token, no wrangler install in an hourly job, and
 * no second way of answering the same question (LESSONS L16).
 *
 * It lives with the general guards rather than in the worker guard directory,
 * whose rule is guards about `apps/worker/src` specifically. `apps/worker-tail`
 * is a different package, and it has no test scope of its own yet (#499), so this
 * runs in the web suite. The placement guard from #502 caught the mistake, which
 * is now twice in one session that it has earned its keep.
 *
 * What is asserted here is the DELIVERY, which is the half that failed for the
 * engine worker and went unnoticed for months (#327). The handler itself is
 * three lines and is exercised end to end every hour by the live check, whose
 * unstamped branch is loud.
 */
const readRepoFile = (relative: string): string => {
  const file = path.join(REPO_ROOT, relative)
  const text = readFileSync(file, 'utf8')
  expect(text.length, `${file} is empty`).toBeGreaterThan(0)
  return text
}

describe('the tail worker reports the commit it is running (#739)', () => {
  it('has a fetch handler', () => {
    const src = readRepoFile('apps/worker-tail/src/index.ts')
    expect(
      src,
      'the tail worker has no fetch handler, so nothing can ask it which commit it is running',
    ).toMatch(/\bfetch\s*\(_?request/)
  })

  it('answers with DEPLOYED_SHA', () => {
    const src = readRepoFile('apps/worker-tail/src/index.ts')
    expect(src).toMatch(/DEPLOYED_SHA/)
  })

  it('declares DEPLOYED_SHA on its Env, so a rename cannot silently read undefined', () => {
    const src = readRepoFile('apps/worker-tail/src/index.ts')
    const env = src.slice(src.indexOf('interface Env'), src.indexOf('}', src.indexOf('interface Env')))
    expect(env, 'DEPLOYED_SHA is read but not declared on Env').toMatch(/DEPLOYED_SHA/)
  })
})

describe('the tail deploy actually delivers the stamp (#739)', () => {
  /** Every line that stamps DEPLOYED_SHA onto a deploy. */
  const stampLines = (yml: string): string[] =>
    yml.split('\n').filter((line) => line.includes('DEPLOYED_SHA') && line.includes('--var'))

  it('stamps the commit on the tail worker deploy', () => {
    const lines = stampLines(readRepoFile('.github/workflows/deploy.yml'))
    expect(
      lines.some((line) => line.includes('worker-tail')),
      'deploy.yml no longer stamps DEPLOYED_SHA on the tail worker, so it cannot report its commit',
    ).toBe(true)
  })

  it('does not hide the stamp behind pnpm argument forwarding', () => {
    // The whole of #327 in one assertion, applied to the second worker. `run
    // <script> --` makes pnpm forward the separator verbatim; wrangler reads it
    // as end of options, discards every flag after it, and exits 0. The deploy is
    // green and the worker is unstamped, and both halves fail quietly.
    for (const line of stampLines(readRepoFile('.github/workflows/deploy.yml'))) {
      expect(
        line,
        'the DEPLOYED_SHA flag is passed after a bare `--`, which wrangler silently ignores',
      ).not.toMatch(/run\s+\S+\s+--\s+--var/)
    }
  })
})

describe('the tail drift check asks the same question the deploy asks (#739)', () => {
  /** The `worker_tail:` paths filter that gates Deploy Worker Tail. */
  const deployFilterPaths = (): string[] => {
    const lines = readRepoFile('.github/workflows/deploy.yml').split('\n')
    const start = lines.findIndex((line) => /^\s{12}worker_tail:\s*$/.test(line))
    expect(start, 'deploy.yml no longer has a `worker_tail:` paths filter').toBeGreaterThan(-1)
    const paths: string[] = []
    for (const line of lines.slice(start + 1)) {
      const match = line.match(/^\s+-\s+'([^']+)'\s*$/)
      if (!match) break
      paths.push(match[1])
    }
    expect(paths.length, 'the filter matched no paths, so this guard asserts nothing').toBeGreaterThan(0)
    return paths
  }

  it('reads history over exactly the paths that gate Deploy Worker Tail', () => {
    // #802 is what the mismatch costs: the engine check asked git about a path
    // while the deploy decided from the built bundle, so it paged hourly for a
    // month with nothing unshipped. Here the two CAN be identical, because the
    // tail deploy has no artifact gate and fires on the paths filter alone, so
    // the only thing needed is that the two lists stay the same (L144).
    const drift = readRepoFile('.github/workflows/deploy-drift.yml')
    const gitLog = drift.match(/LAST_TAIL_COMMIT=\$\(git log -1 --format=%H -- ([^)\n]+)\)/)
    expect(gitLog, 'the tail drift job no longer derives the latest tail commit from git').not.toBeNull()

    const asked = gitLog![1].trim().split(/\s+/).sort()
    const gating = deployFilterPaths()
      .map((p) => p.replace(/\/\*\*$/, ''))
      .sort()
    expect(
      asked,
      'the drift check and Deploy Worker Tail now judge "the tail worker changed" by different path lists, which is the #802 shape',
    ).toEqual(gating)
  })

  it('treats a missing stamp as a failure rather than a reason to skip', () => {
    // The specific defect #327 fixed for the engine worker. An unstamped worker
    // is the signal that stamping itself has broken, which is exactly what this
    // job exists to report, so skipping on it makes the job unable to go red.
    const lines = readRepoFile('.github/workflows/deploy-drift.yml').split('\n')
    const start = lines.findIndex((line) => line.includes('LAST_TAIL_COMMIT='))
    expect(start, 'no tail drift job found').toBeGreaterThan(-1)

    const body = lines.slice(start).join('\n')
    const branch = body.indexOf('TAIL_SHA')
    expect(branch, 'the tail job never reads a reported commit').toBeGreaterThan(-1)
    // The unstamped branch must reach an error, not an exit 0.
    expect(
      body.slice(0, body.indexOf('- name: ', branch) + 1 || undefined),
      'a missing tail stamp no longer fails the check',
    ).toMatch(/unstamped|::error/)
  })
})
