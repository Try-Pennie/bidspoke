import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPublicPath } from '../public-paths'
import { REPO_ROOT } from './_scan-utils'

/**
 * The site half of the stranded-deploy check (#804).
 *
 * Deploy Drift has always watched the Worker only. Nothing watched Cloudflare
 * Pages, so a failed or skipped Pages deploy left the site serving an older
 * build with no signal at all, which is the same defect #327 filed for the
 * Worker.
 *
 * Two things make the site harder than the worker.
 *
 * The worker reports its commit at one endpoint, so one reading answers for the
 * whole deploy. A Pages deploy propagates per route, so a scan can genuinely see
 * the new build on one route and the old build on another (measured, and
 * recorded in the project notes as a prod scan that read as a missed fix). One
 * stamp therefore cannot answer for the site: the check samples several routes,
 * spanning both the prerendered static assets and the edge-rendered functions,
 * because those are two different propagation paths.
 *
 * And a route can fail to answer in ways the worker's single endpoint cannot.
 * Each of those is its own outcome here rather than a shared "something is
 * wrong", because a site that cannot be reached, a site whose build carries no
 * stamp, and a site serving a genuinely older commit need three different
 * actions (LESSONS L11).
 *
 * THE FAIL-SAFE DIRECTION IS AN ALERT. In particular:
 *
 *  - Sampling ZERO routes is its own loud outcome, never a pass. A checker that
 *    found nothing to check is indistinguishable from one that found everything
 *    healthy, and the empty result arrives exactly when the sampling itself has
 *    broken (L98).
 *  - An unreadable in-flight age is mapped to the loud side rather than compared
 *    against the ceiling, where it would silently land on the permissive side
 *    (L50).
 *  - A deploy stuck in flight still pages, so "a deploy is running" cannot
 *    become a permanent excuse for silence.
 *
 * Every outcome the script's own contract enumerates is PRODUCED by a test
 * below, not merely covered in passing (L151).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/pages-drift-decision.sh')

/** Runs the decision script and returns the single word it prints. */
const decide = (...args: string[]): string =>
  execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }).trim()

/** Runs it and returns only what it wrote to stderr, which is where the reason goes. */
const reason = (...args: string[]): string =>
  execFileSync('bash', ['-c', `bash "$0" "$@" 2>&1 >/dev/null`, SCRIPT, ...args], {
    encoding: 'utf8',
  })

describe('pages-drift-decision: the settled healthy state', () => {
  it('is ok when every sampled route serves the latest commit', () => {
    expect(decide('', '/login=current', '/docs=current', '/dev/nodes=current')).toBe('ok')
  })

  it('is still ok when every route is current and a deploy happens to be running', () => {
    // The next deploy starting does not make the current one unshipped. Judging
    // in-flight before "everything is already live" would make the check say
    // less the healthier the site is.
    expect(decide('60', '/login=current', '/docs=current')).toBe('ok')
  })
})

describe('pages-drift-decision: a genuinely stale site', () => {
  it('alerts when a route serves an older commit and no deploy is running', () => {
    expect(decide('', '/login=current', '/docs=behind')).toBe('alert-behind')
  })

  it('alerts on a single behind route even when the others are current', () => {
    // The per-route propagation case. A site that is new on two routes and old
    // on a third is exactly the partial state one endpoint could not reveal.
    expect(decide('', '/login=behind', '/docs=current', '/dev/nodes=current')).toBe('alert-behind')
  })
})

describe('pages-drift-decision: a deploy in flight', () => {
  it('stands down while a young deploy is still running', () => {
    expect(decide('120', '/login=behind', '/docs=current')).toBe('deploy-in-flight')
  })

  it('pages when the in-flight deploy has passed the ceiling', () => {
    // A deploy takes minutes. One that has been in flight far longer is stuck,
    // not slow, and must not buy indefinite silence.
    expect(decide('99999', '/login=behind')).toBe('alert-stuck-deploy')
  })

  it('treats an unreadable in-flight age as loud rather than comparing it', () => {
    // '' means no deploy is running; a non-numeric value means the lookup that
    // answers that question failed. Those are different, and the second must not
    // compare false against the ceiling and buy silence.
    expect(decide('not-a-number', '/login=behind')).toBe('alert-malformed')
  })
})

describe('pages-drift-decision: the checker itself has broken', () => {
  it('alerts rather than passing when no routes were sampled at all', () => {
    // The L98 case. Zero subjects is not a clean bill of health.
    expect(decide('')).toBe('alert-no-samples')
  })

  it('alerts when a sampled route carries no usable commit stamp', () => {
    // Either the page has no stamp element at all, or it has one whose value is
    // the placeholder. Both mean the site cannot report what it is serving, so
    // stranding cannot be detected, which is the very condition this job exists for.
    expect(decide('', '/login=current', '/docs=unstamped')).toBe('alert-unstamped')
  })

  it('alerts when a route names a commit this repository does not have', () => {
    // Reported separately from a missing stamp on purpose: a build from outside
    // main's history and a build with no stamp at all send the reader to check
    // two different things.
    expect(decide('', '/login=current', '/docs=unknown')).toBe('alert-unknown-commit')
  })

  it('alerts when a sampled route could not be fetched', () => {
    expect(decide('', '/login=current', '/docs=unreachable')).toBe('alert-unreachable')
  })

  it('reports a broken stamp ahead of a stale route, because the stale reading cannot be trusted', () => {
    // With one route unstamped the sample is not measuring what it claims to,
    // so "behind" is not the finding to report.
    expect(decide('', '/login=behind', '/docs=unstamped')).toBe('alert-unstamped')
  })

  it('reports a broken stamp even while a deploy is running', () => {
    // A deploy in flight explains a route being BEHIND. It does not explain a
    // build that carries no stamp, so it must not silence that.
    expect(decide('60', '/login=behind', '/docs=unstamped')).toBe('alert-unstamped')
  })

  it('reports an unreachable route even while a deploy is running', () => {
    expect(decide('60', '/login=unreachable')).toBe('alert-unreachable')
  })

  it('alerts on an observation that is not path=state', () => {
    expect(decide('', '/login')).toBe('alert-malformed')
  })

  it('alerts on an unrecognised state rather than ignoring it', () => {
    // An unknown word must not fall through every branch and land on ok, which
    // is what a typo in the caller would otherwise produce.
    expect(decide('', '/login=probably-fine')).toBe('alert-malformed')
  })
})

describe('pages-drift-decision: it names the route it is talking about', () => {
  it('puts the offending route in the reason so the alert can be acted on', () => {
    // A message that says the site is stale without saying WHERE sends the
    // reader to check every route by hand.
    expect(reason('', '/login=current', '/docs=behind')).toContain('/docs')
  })

  it('names the unstamped route, not merely that one exists', () => {
    expect(reason('', '/login=current', '/docs=unstamped')).toContain('/docs')
  })
})

/**
 * The job that feeds this script has to ask the same question the deploy asks,
 * and has to sample routes that actually answer with a page.
 *
 * #802 is the record of what the first mistake costs. The worker check decided
 * "the worker changed" from git history over the apps/worker PATH while the
 * deploy decided it from the built bundle, so a commit satisfying one and not
 * the other read as a strand no deploy could ever clear, and it paged hourly for
 * a month with nothing unshipped. Here the two predicates CAN be identical,
 * because Deploy Pages is gated by a paths filter and this job asks git about a
 * path list too, so the only thing needed is that the two lists stay the same
 * (LESSONS L144).
 *
 * The second mistake would be quieter. The login gate redirects a protected path,
 * and curl without -L returns the redirect's empty body at exit 0, which reads as
 * a page carrying no stamp. Sampling one protected route would therefore page
 * forever with the site perfectly healthy.
 */
const readRepoText = (relative: string): string => {
  const file = path.join(REPO_ROOT, relative)
  const text = readFileSync(file, 'utf8')
  expect(text.length, `${file} is empty`).toBeGreaterThan(0)
  return text
}

/** The `pages:` paths filter that gates Deploy Pages in deploy.yml. */
const deployPagesFilterPaths = (): string[] => {
  const lines = readRepoText('.github/workflows/deploy.yml').split('\n')
  const start = lines.findIndex((line) => /^\s{12}pages:\s*$/.test(line))
  expect(start, 'deploy.yml no longer has a `pages:` paths filter').toBeGreaterThan(-1)
  const paths: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+-\s+'([^']+)'\s*$/)
    if (!match) break
    paths.push(match[1])
  }
  expect(paths.length, 'the pages filter matched no paths, so this guard is asserting nothing').toBeGreaterThan(0)
  return paths
}

describe('the site drift job asks the same question the deploy asks (#804)', () => {
  it('reads history over exactly the paths that gate Deploy Pages', () => {
    const filter = deployPagesFilterPaths()
    const drift = readRepoText('.github/workflows/deploy-drift.yml')
    const gitLog = drift.match(/LAST_WEB_COMMIT=\$\(git log -1 --format=%H -- ([^)\n]+)\)/)
    expect(gitLog, 'the pages drift job no longer derives the latest site commit from git').not.toBeNull()

    // The filter lists globs (`apps/web/**`); git log takes the path. Compare on
    // the path, so the two cannot drift while still reading as equivalent.
    const asked = gitLog![1].trim().split(/\s+/).sort()
    const gating = filter.map((p) => p.replace(/\/\*\*$/, '')).sort()
    expect(
      asked,
      'the drift check and Deploy Pages now judge "the site changed" by different path lists, which is the #802 shape: one can report a strand the other can never clear',
    ).toEqual(gating)
  })
})

describe('the site drift job samples routes that actually serve a page (#804)', () => {
  it('samples only paths the login gate lets through unauthenticated', () => {
    // A protected path answers with a redirect. curl without -L returns its empty
    // body at exit 0, which reads as a page with no stamp, so one protected route
    // in this list would page forever against a perfectly healthy site.
    const drift = readRepoText('.github/workflows/deploy-drift.yml')
    const routesLine = drift.match(/^\s*ROUTES="([^"]+)"/m)
    expect(routesLine, 'the pages drift job no longer declares a ROUTES list').not.toBeNull()

    const routes = routesLine![1].trim().split(/\s+/)
    expect(routes.length, 'a single route cannot reveal a partial per-route propagation').toBeGreaterThan(1)

    for (const route of routes) {
      expect(isPublicPath(route), `${route} is behind the login gate, so it answers with a redirect and not a page`).toBe(true)
    }
  })

  it('samples both a prerendered route and the edge-rendered docs route', () => {
    // The two propagation paths. A sample confined to one of them cannot see the
    // partial state that made a prod scan read like a missed fix.
    const drift = readRepoText('.github/workflows/deploy-drift.yml')
    const routes = drift.match(/^\s*ROUTES="([^"]+)"/m)![1].trim().split(/\s+/)
    expect(routes, 'no edge-rendered route is sampled, so the functions bundle is never checked').toContain('/docs')
    expect(
      routes.some((route) => route !== '/docs'),
      'only the edge route is sampled, so the static assets are never checked',
    ).toBe(true)
  })
})

describe('the site drift job refuses to scan nothing (#804)', () => {
  it('fails on an unset SITE_URL instead of defaulting it', () => {
    // An unset repository variable arrives as the empty string, not as absent, so
    // a `${SITE_URL:-...}` default would silently accept it (L138) and the job
    // would scan a URL nobody chose.
    const drift = readRepoText('.github/workflows/deploy-drift.yml')
    expect(drift).toMatch(/if \[ -z "\$\{SITE_URL:-\}" \]/)
    const guard = drift.slice(drift.indexOf('if [ -z "${SITE_URL:-}" ]'))
    const body = guard.slice(0, guard.indexOf('fi'))
    expect(body, 'an unset SITE_URL no longer fails the job').toMatch(/exit 1/)
  })
})

describe('pages-drift-decision: the in-flight answer could not be obtained (#899)', () => {
  /**
   * The state that caused the false page. The job asked `gh run list` whether a
   * Deploy was running, the call was refused for want of `actions: read`, and the
   * empty answer arrived here as "no deploy is running" and produced
   * `alert-behind` five minutes into a perfectly healthy deploy.
   *
   * `unavailable` is now its own outcome rather than being folded into either
   * neighbour. Not `deploy-in-flight`, which would let a broken query silence the
   * check for good, and not `alert-behind`, which sends the reader to re-run a
   * deploy that was never the problem (L11).
   */
  it('is its own outcome when routes are behind and the query failed', () => {
    expect(decide('unavailable', '/login=behind', '/docs=current')).toBe('alert-inflight-unknown')
  })

  it('names the permission in the reason, so the fix is in front of the reader', () => {
    const why = reason('unavailable', '/login=behind')
    expect(why).toMatch(/actions: read/)
    expect(why).toMatch(/\/login/)
  })

  it('is still ok when every route is current, because the answer changes nothing', () => {
    // A failed query is only worth reporting when it is standing between us and a
    // verdict. With nothing behind there is nothing for an in-flight deploy to
    // excuse, so paging here would make the check noisiest when the site is
    // healthiest.
    expect(decide('unavailable', '/login=current', '/docs=current')).toBe('ok')
  })

  it('does not mask a route that will not answer or carries no stamp', () => {
    // Those are faults in the site itself and need their own actions. A broken
    // in-flight query must not overwrite the more specific finding.
    expect(decide('unavailable', '/login=unstamped', '/docs=behind')).toBe('alert-unstamped')
    expect(decide('unavailable', '/login=unreachable', '/docs=behind')).toBe('alert-unreachable')
    expect(decide('unavailable', '/login=unknown', '/docs=behind')).toBe('alert-unknown-commit')
  })

  it('is not confused with a genuinely malformed reading', () => {
    // Before #899 `unavailable` would have landed on alert-malformed, which says
    // the check itself is miswired and sends the reader to the sampling step. The
    // sampling was fine; the permission was not.
    expect(decide('probably', '/login=behind')).toBe('alert-malformed')
  })
})

describe('the drift jobs can actually ask whether a deploy is running (#899)', () => {
  const drift = () => readRepoText('.github/workflows/deploy-drift.yml')

  it('gives every job the actions: read the query needs', () => {
    // The whole defect in one line. The repository's default workflow token is
    // `read`, which grants contents and packages and nothing else, so without
    // this the query is refused every time and the gate can never fire.
    //
    // Scoped to each job's HEADER, meaning the lines between the job key and its
    // `steps:`, rather than searched over the whole job. Written the loose way
    // this guard passed with the grant deleted, because every one of these jobs
    // now carries a Slack message that NAMES `actions: read` while explaining the
    // failure, and a whole-block match is answered by any occurrence in the block
    // including copy ABOUT the thing (LESSONS L103, L135). Verified by deleting
    // the real grant and watching this fail.
    const text = drift()
    for (const name of ['drift', 'pages', 'worker_tail']) {
      const start = text.indexOf(`\n  ${name}:\n`)
      expect(start, `deploy-drift.yml has no job called ${name}`).toBeGreaterThan(-1)
      const steps = text.indexOf('\n    steps:\n', start)
      expect(steps, `job ${name} has no steps:, so the header cannot be bounded`).toBeGreaterThan(start)
      const header = text.slice(start, steps)
      expect(header, `job ${name} cannot read Actions, so its in-flight gate can never fire`).toMatch(
        /^      actions: read$/m,
      )
    }
  })

  it('asks through the one shared script rather than three inline copies', () => {
    // Three copies is three chances to get the failure handling wrong, and all
    // three had it wrong the same way (L16).
    const text = drift()
    expect(text).not.toMatch(/gh run list --workflow=deploy\.yml/)
    const uses = text.match(/deploy-inflight-age\.sh/g) ?? []
    expect(uses.length, 'not every drift job asks through the shared script').toBe(3)
  })

  it('never swallows the in-flight query the way that caused the false page', () => {
    // `2>/dev/null || true` is what turned a refused call into "no deploy is
    // running". The shared script always exits 0 and answers `unavailable`, so no
    // caller needs to suppress anything.
    expect(drift()).not.toMatch(/deploy-inflight-age\.sh[^\n]*(2>\/dev\/null|\|\| true)/)
  })
})
