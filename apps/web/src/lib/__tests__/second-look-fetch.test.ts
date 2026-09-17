import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * A second look before Deploy Drift calls a target unreachable (#1371).
 *
 * On 2026-09-16 at 21:01 UTC the site's /dev/nodes route and the cost tail
 * worker both failed to answer within the same second, outlasted curl's own
 * retries a few seconds apart, and paged. Minutes later both answered and were
 * current. Two unrelated services failing together is the network between the
 * runner and Cloudflare, not a stranded deploy, and paging on it is the noise
 * that teaches people to skip alerts (L36).
 *
 * So a target that does not answer is tried once more after a real wait, and only
 * one that fails both times is reported unreachable. A target rescued by the
 * second look is reported as `recovered`, never folded into `ok`, so the blip is
 * still visible in the run log (L11).
 *
 * Every seam is set in every test (L284): the fetch is a fake that answers from a
 * per URL plan, and the wait is a fake that records what it was asked for, so no
 * test reaches the network or sleeps for real (L524).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/second-look-fetch.sh')

/**
 * A deliberately minimal environment, so no variable from the machine running
 * the suite (a real DRIFT_FETCH, a SECOND_LOOK_DELAY) leaks into the script (L439).
 */
const onlyEnv = (vars: Record<string, string>): NodeJS.ProcessEnv =>
  ({ PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...vars }) as NodeJS.ProcessEnv

let dir: string
let out: string

/**
 * Plan for each URL: the outcome of each successive fetch, `ok` or `fail`.
 * A fetch past the end of the plan fails, so a test that fetches more often
 * than it expected is caught rather than quietly answered.
 */
function run(plan: Record<string, string[]>, urls: string[], extraEnv: Record<string, string> = {}) {
  for (const [url, outcomes] of Object.entries(plan)) {
    writeFileSync(path.join(dir, `plan-${encodeURIComponent(url)}`), outcomes.join('\n') + '\n')
  }
  const stdout = execFileSync('bash', [SCRIPT, out, ...urls], {
    encoding: 'utf8',
    env: onlyEnv({
      DRIFT_FETCH: path.join(dir, 'fake-fetch.sh'),
      DRIFT_SLEEP: path.join(dir, 'fake-sleep.sh'),
      SECOND_LOOK_DELAY: '120',
      FAKE_DIR: dir,
      ...extraEnv,
    }),
  })
  return stdout.trim().split('\n').filter(Boolean)
}

const sleeps = (): string[] =>
  existsSync(path.join(dir, 'sleeps')) ? readFileSync(path.join(dir, 'sleeps'), 'utf8').trim().split('\n') : []

const fetchesOf = (url: string): number => {
  const file = path.join(dir, `count-${encodeURIComponent(url)}`)
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'second-look-'))
  out = path.join(dir, 'out')
  // The fake fetch: counts calls per URL and answers from that URL's plan. A
  // successful answer prints a body naming the URL, so a test can prove each
  // body landed in the file for its own URL.
  const fetch = path.join(dir, 'fake-fetch.sh')
  writeFileSync(
    fetch,
    [
      '#!/usr/bin/env bash',
      'url="${@: -1}"',
      'key=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$url")',
      'count_file="$FAKE_DIR/count-$key"',
      'n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))',
      'echo "$n" > "$count_file"',
      'outcome=$(sed -n "${n}p" "$FAKE_DIR/plan-$key" 2>/dev/null)',
      'if [ "$outcome" = "ok" ]; then printf "body of %s" "$url"; exit 0; fi',
      'exit 22',
    ].join('\n'),
  )
  chmodSync(fetch, 0o755)
  const sleep = path.join(dir, 'fake-sleep.sh')
  writeFileSync(sleep, '#!/usr/bin/env bash\necho "$1" >> "$FAKE_DIR/sleeps"\n')
  chmodSync(sleep, 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('second-look-fetch: a target that answers', () => {
  it('reports ok, keeps the body, and does not wait', () => {
    const lines = run({ 'https://a/x': ['ok'] }, ['https://a/x'])
    expect(lines).toEqual(['1 ok'])
    expect(readFileSync(path.join(out, '1'), 'utf8')).toBe('body of https://a/x')
    expect(sleeps(), 'a healthy run must cost no wait at all').toEqual([])
    expect(fetchesOf('https://a/x')).toBe(1)
  })
})

describe('second-look-fetch: a blip', () => {
  it('reports a target that fails once and then answers as recovered, not unreachable and not ok', () => {
    const lines = run({ 'https://a/x': ['fail', 'ok'] }, ['https://a/x'])
    expect(lines).toEqual(['1 recovered'])
    expect(readFileSync(path.join(out, '1'), 'utf8')).toBe('body of https://a/x')
    expect(sleeps()).toEqual(['120'])
  })
})

describe('second-look-fetch: a real outage', () => {
  it('reports a target that fails both looks as unreachable, with no body', () => {
    const lines = run({ 'https://a/x': ['fail', 'fail'] }, ['https://a/x'])
    expect(lines).toEqual(['1 unreachable'])
    expect(existsSync(path.join(out, '1'))).toBe(false)
    expect(fetchesOf('https://a/x'), 'exactly two looks, not more').toBe(2)
  })
})

describe('second-look-fetch: several targets', () => {
  it('waits once for the whole set, and re-fetches only the ones that failed', () => {
    const lines = run(
      {
        'https://a/1': ['ok'],
        'https://a/2': ['fail', 'ok'],
        'https://a/3': ['fail', 'fail'],
      },
      ['https://a/1', 'https://a/2', 'https://a/3'],
    )
    expect(lines).toEqual(['1 ok', '2 recovered', '3 unreachable'])
    expect(sleeps(), 'one wait per call, or a down site multiplies the wait by its route count').toEqual(['120'])
    expect(fetchesOf('https://a/1'), 'a route that answered is not asked again').toBe(1)
    expect(readFileSync(path.join(out, '2'), 'utf8')).toBe('body of https://a/2')
  })
})

describe('second-look-fetch: its own inputs', () => {
  it('falls back to the default wait rather than skipping it when the delay is not a number (L50)', () => {
    run({ 'https://a/x': ['fail', 'ok'] }, ['https://a/x'], { SECOND_LOOK_DELAY: 'soon' })
    expect(sleeps()).toEqual(['120'])
  })

  it('refuses to run with no URLs, rather than reporting nothing as all clear (L98)', () => {
    expect(() =>
      execFileSync('bash', [SCRIPT, out], { encoding: 'utf8', stdio: 'pipe', env: onlyEnv({}) }),
    ).toThrow(/at least one URL/)
  })
})

describe('the drift workflow takes a second look before calling a target unreachable (#1371)', () => {
  const drift = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-drift.yml'), 'utf8')
  const step = (name: string): string => {
    const start = drift.indexOf(`- name: ${name}`)
    expect(start, `the drift workflow has no step named "${name}"`).toBeGreaterThan(-1)
    const next = drift.indexOf('- name:', start + 1)
    return drift.slice(start, next === -1 ? undefined : next)
  }

  it('probes the site routes through the second look', () => {
    const sample = step('Sample the live site')
    expect(sample).toContain('.github/scripts/second-look-fetch.sh')
    expect(sample, 'a bare curl here pages on a single blip again').not.toMatch(/curl\s/)
  })

  it('probes the tail worker through the second look', () => {
    const tail = step('Compare the live tail worker to the latest tail commit')
    expect(tail).toContain('.github/scripts/second-look-fetch.sh')
    expect(tail, 'a bare curl here pages on a single blip again').not.toMatch(/curl\s/)
  })

  it('gives the job time to finish both looks when every target is down, so it can still alert', () => {
    // A job killed by its timeout sends no alert at all, which is the outcome the
    // second look must never buy. Derive the worst case from the script and the
    // route list rather than a literal, so either moving re-checks this (L401).
    const script = readFileSync(SCRIPT, 'utf8')
    const delay = Number(script.match(/DEFAULT_DELAY=(\d+)/)?.[1])
    const maxTime = Number(script.match(/--max-time (\d+)/)?.[1])
    const retries = Number(script.match(/--retry (\d+)/)?.[1])
    const retryDelay = Number(script.match(/--retry-delay (\d+)/)?.[1])
    for (const [label, value] of Object.entries({ delay, maxTime, retries, retryDelay })) {
      expect(Number.isFinite(value) && value > 0, `could not read ${label} from the script`).toBe(true)
    }
    const perFetch = maxTime * (retries + 1) + retryDelay * retries
    // The route list is shared with the deploy's propagation sampler (#901), so
    // it is read from the one file both source rather than from the drift job.
    const routesFile = readFileSync(path.join(REPO_ROOT, '.github/scripts/pages-routes.sh'), 'utf8')
    const routes = routesFile.match(/^PAGES_ROUTES="([^"]+)"/m)![1].trim().split(/\s+/).length
    const worstSite = routes * perFetch * 2 + delay
    // The tail worker and the main worker are one address each (#1373).
    const worstSingle = perFetch * 2 + delay
    const timeoutMinutes = Number(drift.match(/timeout-minutes:\s*(\d+)/)?.[1])
    // Five minutes left over for checkout, the worker build and posting alerts.
    expect(timeoutMinutes * 60).toBeGreaterThanOrEqual(worstSite + worstSingle * 2 + 300)
  })
})
