import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkflow, REPO_ROOT, workflowJobBody } from './_scan-utils'

/**
 * Every Pages deploy measures how long its routes take to flip (#901).
 *
 * Deploy Drift pages when a route serves an older commit and no deploy is in
 * flight. A Pages deploy propagates per route for a while AFTER the run has
 * completed, so an hourly check landing in that window pages for a site that is
 * simply still settling. The fix is a grace period, and the issue is explicit
 * that its length must be MEASURED across several real deploys rather than
 * invented: a number written from one reading is a guess with a decimal point
 * (LESSONS L656, L172).
 *
 * So the Deploy Pages job, right after uploading, watches the same routes the
 * drift check samples and logs how many seconds each took to serve the commit
 * it just shipped. The grace constant is then set from those lines, and stays
 * checkable against every later deploy.
 *
 * It is a measurement, never a gate: it cannot fail the deploy (L632), it says
 * so out loud when it measured nothing (L98), and a route that never flipped
 * within the wait is reported as exactly that, a censored reading, rather than
 * dropped (L540). Time is injected so these tests set the clock instead of
 * waiting on it (L290, L524), and the loop is bounded by a count as well as by
 * the clock so a clock that does not advance cannot spin it for ever (L704).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/pages-propagation-sample.sh')
const SHA_NEW = 'a'.repeat(40)
const SHA_OLD = 'b'.repeat(40)

const page = (sha: string): string =>
  `<!DOCTYPE html><html><head><meta name="bidspoke-commit" content="${sha}"></head><body>x</body></html>`

/**
 * What the fake site answers per route, by look number (1-based). A route flips
 * at `flipAt`, is `unreachable` for ever, or serves the old build for ever.
 */
type Plan = Record<string, { flipAt: number } | 'unreachable' | 'never'>

type Result = { out: string; err: string; code: number; summary: string }

const sample = (
  plan: Plan,
  opts: { maxWait?: number; interval?: number; routes?: string[]; clockAdvances?: boolean } = {},
): Result => {
  const dir = mkdtempSync(path.join(tmpdir(), 'propagation-'))
  const routes = opts.routes ?? Object.keys(plan)
  const maxWait = opts.maxWait ?? 300
  const interval = opts.interval ?? 15

  // A simulated clock: `now` reads it and `sleep N` advances it by N, so the
  // elapsed seconds the script reports are exact and no test waits for real.
  const clock = path.join(dir, 'clock')
  writeFileSync(clock, '1000')
  const now = path.join(dir, 'now')
  writeFileSync(now, `#!/usr/bin/env bash\ncat ${JSON.stringify(clock)}\n`)
  const sleep = path.join(dir, 'sleep')
  writeFileSync(
    sleep,
    opts.clockAdvances === false
      ? '#!/usr/bin/env bash\nexit 0\n'
      : `#!/usr/bin/env bash\nC=$(cat ${JSON.stringify(clock)}); echo $((C + $1)) > ${JSON.stringify(clock)}\n`,
  )

  // A fake curl keyed on the URL (its last argument) with a per-route look counter.
  const curl = path.join(dir, 'curl')
  const cases = Object.entries(plan)
    .map(([route, what]) => {
      const body = JSON.stringify(page(SHA_NEW))
      const old = JSON.stringify(page(SHA_OLD))
      if (what === 'unreachable') return `    *${route}) exit 7 ;;`
      if (what === 'never') return `    *${route}) printf '%s' ${old} ;;`
      return `    *${route}) if [ "$N" -ge ${what.flipAt} ]; then printf '%s' ${body}; else printf '%s' ${old}; fi ;;`
    })
    .join('\n')
  writeFileSync(
    curl,
    [
      '#!/usr/bin/env bash',
      'URL="${@: -1}"',
      `COUNTS=${JSON.stringify(dir)}/counts`,
      'mkdir -p "$COUNTS"',
      'KEY=$(printf \'%s\' "$URL" | tr -c \'a-zA-Z0-9\' _)',
      'N=$(( $(cat "$COUNTS/$KEY" 2>/dev/null || echo 0) + 1 ))',
      'echo "$N" > "$COUNTS/$KEY"',
      'case "$URL" in',
      cases,
      '    *) echo "no plan for $URL" >&2; exit 22 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  for (const f of [now, sleep, curl]) chmodSync(f, 0o755)

  const summary = path.join(dir, 'summary.md')
  writeFileSync(summary, '')
  const errFile = path.join(dir, 'stderr.txt')
  let out = ''
  let code = 0
  try {
    out = execFileSync(
      'bash',
      ['-c', `bash "$0" "$@" 2>"${errFile}"`, SCRIPT, 'https://site.test', SHA_NEW, String(maxWait), String(interval), ...routes],
      {
        encoding: 'utf8',
        env: { ...process.env, CURL_BIN: curl, SLEEP_BIN: sleep, NOW_BIN: now, GITHUB_STEP_SUMMARY: summary },
      },
    )
  } catch (e) {
    const err = e as { status: number; stdout: string }
    code = err.status
    out = err.stdout
  }
  return { out, err: readFileSync(errFile, 'utf8'), code, summary: readFileSync(summary, 'utf8') }
}

const line = (out: string, route: string): string =>
  out.split('\n').find((l) => l.startsWith('pages-propagation:') && l.includes(`route=${route} `)) ?? ''

describe('pages-propagation-sample: routes that flip', () => {
  it('reports zero seconds for a route already serving the new commit on the first look', () => {
    const { out } = sample({ '/login': { flipAt: 1 } })
    expect(line(out, '/login')).toMatch(/result=flipped seconds=0\b/)
  })

  it('reports the elapsed seconds at the look that first saw the new commit', () => {
    // Third look: two intervals of 15s have passed on the simulated clock.
    const { out } = sample({ '/login': { flipAt: 3 } })
    expect(line(out, '/login')).toMatch(/result=flipped seconds=30\b/)
  })

  it('keeps looking at the routes still behind while leaving alone the ones that flipped', () => {
    const { out } = sample({ '/login': { flipAt: 1 }, '/docs': { flipAt: 4 } })
    expect(line(out, '/login')).toMatch(/seconds=0\b/)
    expect(line(out, '/docs')).toMatch(/seconds=45\b/)
  })

  it('summarises the count that flipped and the slowest reading, which is the number the grace is set from', () => {
    const { out } = sample({ '/login': { flipAt: 1 }, '/docs': { flipAt: 4 }, '/dev/nodes': { flipAt: 2 } })
    expect(out).toMatch(/pages-propagation: summary .*flipped=3\/3/)
    expect(out).toMatch(/slowest_seconds=45\b/)
    expect(out).toMatch(/interval=15\b/)
  })
})

describe('pages-propagation-sample: routes that never flip within the wait', () => {
  it('reports the route as not flipped within the wait, naming what it last served', () => {
    // A censored reading is still a reading (L540): the grace must not be set
    // from the routes that happened to be quick.
    const { out } = sample({ '/docs': 'never' }, { maxWait: 60 })
    expect(line(out, '/docs')).toMatch(/result=not-within seconds=60\b/)
    expect(line(out, '/docs')).toMatch(new RegExp(`last=${SHA_OLD.slice(0, 7)}`))
  })

  it('reports a route that never answered as such, not as slow', () => {
    const { out } = sample({ '/access-denied': 'unreachable' }, { maxWait: 30 })
    expect(line(out, '/access-denied')).toMatch(/result=not-within .*last=unreachable/)
  })

  it('counts them out of the flipped total in the summary', () => {
    const { out } = sample({ '/login': { flipAt: 1 }, '/docs': 'never' }, { maxWait: 30 })
    expect(out).toMatch(/flipped=1\/2/)
  })

  it('stops after a bounded number of looks even when the clock does not advance', () => {
    // A loop bounded only by wall time does unbounded work when the clock is
    // stuck (L704). With a sleep that advances nothing this would never end.
    const { out, code } = sample({ '/docs': 'never' }, { maxWait: 30, interval: 10, clockAdvances: false })
    expect(code).toBe(0)
    expect(line(out, '/docs')).toMatch(/result=not-within/)
  })
})

describe('pages-propagation-sample: it is a measurement, never a gate', () => {
  it('exits 0 even when every route stayed behind', () => {
    expect(sample({ '/login': 'never', '/docs': 'unreachable' }, { maxWait: 30 }).code).toBe(0)
  })

  it('says loudly that it measured nothing when given no routes, and still exits 0', () => {
    const { out, code } = sample({}, { routes: [] })
    expect(code).toBe(0)
    expect(out).toMatch(/pages-propagation: .*no routes/i)
  })

  it('writes the per-route lines to the step summary so they are read without opening the log', () => {
    const { summary } = sample({ '/login': { flipAt: 2 } })
    expect(summary).toMatch(/\/login/)
    expect(summary).toMatch(/15/)
  })
})

describe('pages-propagation-sample: it is wired into the Deploy Pages job', () => {
  const job = workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'deploy-pages')

  it('runs the sampler in the Deploy Pages job, after the upload step', () => {
    const upload = job.indexOf('- name: Deploy to Cloudflare Pages')
    const sampler = job.indexOf('pages-propagation-sample.sh')
    expect(upload, 'the upload step is gone or renamed').toBeGreaterThan(-1)
    expect(sampler, 'the sampler is not in the Deploy Pages job').toBeGreaterThan(upload)
  })

  it('cannot fail the deploy', () => {
    // A reporting step must never fail the stage it reports on (L632).
    const sampler = job.slice(job.lastIndexOf('- name:', job.indexOf('pages-propagation-sample.sh')))
    expect(sampler).toMatch(/continue-on-error: true/)
  })

  it('measures against the commit the run shipped and the site the drift check watches', () => {
    const sampler = job.slice(job.lastIndexOf('- name:', job.indexOf('pages-propagation-sample.sh')))
    expect(sampler).toMatch(/github\.sha/)
    expect(sampler).toMatch(/vars\.SITE_URL/)
  })

  it('samples the routes from the one shared list, the same one the drift check reads', () => {
    // The measurement calibrates a window the drift check applies. Sampling
    // different routes would measure one thing and excuse another (L209, L41).
    const drift = readWorkflow('.github/workflows/deploy-drift.yml')
    for (const [label, text] of [
      ['deploy.yml', job],
      ['deploy-drift.yml', drift],
    ] as const) {
      expect(text, `${label} does not source pages-routes.sh`).toMatch(/\. \.github\/scripts\/pages-routes\.sh/)
      expect(text, `${label} carries its own literal route list`).not.toMatch(/ROUTES="\//)
    }
  })

  it('finishes well inside the job timeout even when a route never flips', () => {
    // The sampler waits up to its ceiling. Deploy Pages measured 135s to build
    // and upload; the ceiling plus that must leave headroom under the timeout,
    // or a slow propagation kills the deploy job by timeout (L353).
    const wait = Number(job.match(/pages-propagation-sample\.sh[^\n]*?"\$SITE_URL" "\$GITHUB_SHA" (\d+) (\d+)/)?.[1])
    const timeout = Number(job.match(/timeout-minutes:\s*(\d+)/)?.[1])
    expect(wait, 'could not read the sampler ceiling from deploy.yml').toBeGreaterThan(0)
    expect(timeout * 60).toBeGreaterThanOrEqual(135 + wait + 120)
  })
})
