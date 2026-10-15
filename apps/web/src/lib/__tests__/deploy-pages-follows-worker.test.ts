/**
 * Pages deploys after the Worker, and a separate check says when the partners
 * page has followed it (#2132, L111, L754, L542).
 *
 * A partners page opened before the versioned save shipped sends no version,
 * and the Worker refuses its save with a reload message (428). That is only
 * survivable if the page the person reloads into is the new one, so the site
 * must not deploy ahead of a Worker that failed, and something must say when
 * the site has not caught up. The propagation sampler (#901) is a recorded
 * measurement that never gates and PAGES_ROUTES is public by a recorded
 * decision, so neither is touched: a new job signs in and reads /partners.
 *
 * The `if:` conditions are evaluated here, by a small evaluator for the subset
 * of the GitHub expression language they use, so "a web only change still
 * deploys Pages" is a computed answer rather than a reading of the text.
 */
import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody } from './_scan-utils'

const deploy = readWorkflow('.github/workflows/deploy.yml')
const pagesJob = workflowJobBody(deploy, 'deploy-pages')
// Empty when the job is missing, so each case below reports its own failure.
const followsJob = (() => { try { return workflowJobBody(deploy, 'partners-page-follows') } catch { return '' } })()

/** The job's `if:` on one line, or null when it has none. */
function ifOf(job: string): string | null {
  const m = job.match(/^ {4}if: (.+)$/m)
  return m ? m[1].trim() : null
}

function needsOf(job: string): string[] {
  const m = job.match(/^ {4}needs: \[([^\]]*)\]/m)
  return m ? m[1].split(',').map((s) => s.trim()) : []
}

type Ctx = Record<string, unknown>

/** Evaluates always(), &&, ||, parentheses, == and != on dotted lookups and quoted strings. */
function evaluate(expr: string, ctx: Ctx): boolean {
  const tokens = expr.match(/always\(\)|&&|\|\||==|!=|\(|\)|'[^']*'|[A-Za-z_][\w.-]*/g) ?? []
  let i = 0
  const peek = () => tokens[i]
  const take = () => tokens[i++]
  const lookup = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)
  function primary(): unknown {
    const t = take()
    if (t === '(') { const v = or(); take(); return v }
    if (t === 'always()') return true
    if (t?.startsWith("'")) return t.slice(1, -1)
    if (t === 'true') return true
    if (t === 'false') return false
    return lookup(t ?? '')
  }
  function comparison(): unknown {
    const left = primary()
    if (peek() === '==' || peek() === '!=') {
      const op = take()
      const right = primary()
      return op === '==' ? left === right : left !== right
    }
    return left
  }
  function and(): unknown {
    let v = comparison()
    while (peek() === '&&') { take(); const r = comparison(); v = Boolean(v) && Boolean(r) }
    return v
  }
  function or(): unknown {
    let v = and()
    while (peek() === '||') { take(); const r = and(); v = Boolean(v) || Boolean(r) }
    return v
  }
  return Boolean(or())
}

const pagesRuns = (worker: string, pagesChanged = 'true', verify = 'success') =>
  evaluate(ifOf(pagesJob) ?? 'false', {
    needs: {
      verify: { result: verify },
      changes: { outputs: { pages: pagesChanged } },
      'deploy-worker': { result: worker },
    },
  })

describe('Deploy Pages waits for the Worker (#2132)', () => {
  it('needs deploy-worker, so the site never goes live ahead of it', () => {
    expect(needsOf(pagesJob)).toEqual(expect.arrayContaining(['verify', 'changes', 'deploy-worker']))
  })

  it('a web only change still deploys Pages: the Worker deploy was skipped', () => {
    expect(pagesRuns('skipped')).toBe(true)
  })

  it('a change to both deploys Pages once the Worker deploy succeeded', () => {
    expect(pagesRuns('success')).toBe(true)
  })

  it.each(['failure', 'cancelled'])('a Worker deploy that ended %s holds Pages back', (result) => {
    expect(pagesRuns(result)).toBe(false)
  })

  it('still needs a passing Verify and a site change', () => {
    expect(pagesRuns('skipped', 'true', 'failure')).toBe(false)
    expect(pagesRuns('skipped', 'false')).toBe(false)
  })
})

describe('the propagation sampler is untouched (#2132)', () => {
  it('is still continue-on-error, so it can never fail the deploy', () => {
    const step = pagesJob.slice(pagesJob.lastIndexOf('- name:', pagesJob.indexOf('pages-propagation-sample.sh')))
    expect(step).toMatch(/continue-on-error: true/)
  })

  it('PAGES_ROUTES is unchanged: public routes only, by a recorded decision', () => {
    const routes = readWorkflow('.github/scripts/pages-routes.sh').match(/^PAGES_ROUTES="([^"]*)"/m)?.[1]
    expect(routes).toBe('/login /access-denied /dev/nodes /docs')
  })
})

describe('partners-page-follows: a separate check that the partners page followed the Worker (#2132)', () => {
  it('runs after Deploy Pages, and only when it succeeded', () => {
    expect(needsOf(followsJob)).toEqual(['deploy-pages'])
    const runs = (result: string) => evaluate(ifOf(followsJob) ?? 'false', { needs: { 'deploy-pages': { result } } })
    expect(runs('success')).toBe(true)
    expect(runs('skipped')).toBe(false)
    expect(runs('failure')).toBe(false)
  })

  it('runs the script against the live site and this commit, signed in as the e2e user', () => {
    expect(followsJob).toMatch(/partners-page-commit\.mjs/)
    expect(followsJob).toMatch(/SITE_URL: \$\{\{ vars\.SITE_URL \}\}/)
    expect(followsJob).toMatch(/EXPECTED_SHA: \$\{\{ github\.sha \}\}/)
    expect(followsJob).toMatch(/E2E_EMAIL: \$\{\{ vars\.E2E_EMAIL \}\}/)
    expect(followsJob).toMatch(/E2E_PASSWORD: \$\{\{ secrets\.E2E_PASSWORD \}\}/)
  })

  it('is not continue-on-error: a page that did not follow fails the run', () => {
    expect(followsJob).not.toMatch(/continue-on-error/)
  })

  it('its timeout covers its wait budget, derived here rather than guessed', () => {
    const budget = Number(followsJob.match(/BUDGET_SECONDS: '(\d+)'/)?.[1])
    const timeout = Number(followsJob.match(/timeout-minutes:\s*(\d+)/)?.[1])
    expect(budget, 'could not read BUDGET_SECONDS from the job').toBeGreaterThan(0)
    // Checkout and node setup measured under 30 s on this repo's other small
    // jobs; sign in and one fetch are seconds. Two minutes of headroom over the
    // budget, so a slow propagation is reported by the script, not killed.
    expect(timeout * 60).toBeGreaterThanOrEqual(budget + 120)
    // And not wildly over, so a hang is still bounded (#1062).
    expect(timeout * 60).toBeLessThanOrEqual(budget + 600)
  })

  it('the budget is well above the slowest propagation the sampler recorded (18 s over 8 deploys, 2026-10-13 to 15)', () => {
    const budget = Number(followsJob.match(/BUDGET_SECONDS: '(\d+)'/)?.[1])
    expect(budget).toBeGreaterThanOrEqual(18 * 5)
  })
})
