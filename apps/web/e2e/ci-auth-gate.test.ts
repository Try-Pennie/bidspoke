/**
 * Issue #728. The auth-gate probe is only worth anything while CI actually runs
 * it, so this asserts the wiring the same way the a11y gate guard does. An
 * unenforced guard is indistinguishable from no guard, and this one protects the
 * login gate.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readCi(): string {
  return fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8')
}

/** The `auth-gate:` job's block, up to the next top-level job key. */
function gateJob(ci: string): string {
  const start = ci.indexOf('\n  auth-gate:')
  expect(start, 'ci.yml no longer defines an `auth-gate:` job').toBeGreaterThan(-1)
  const rest = ci.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** Strip comments before matching, so a comment ABOUT a rule cannot satisfy it. */
function withoutComments(text: string): string {
  return text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
}

describe('CI auth-gate probe', () => {
  it('runs on every PR and push to main', () => {
    const ci = readCi()
    const triggers = ci.slice(0, ci.indexOf('jobs:'))
    expect(triggers).toMatch(/pull_request:/)
    expect(triggers).toMatch(/push:/)
    expect(withoutComments(gateJob(ci))).toMatch(/playwright test --config=playwright\.gate\.config\.ts/)
  })

  it('points at a config and a probe file that exist', () => {
    // `playwright test` exits 0 when its filter matches nothing, so a renamed
    // path would report success having tested nothing.
    const job = withoutComments(gateJob(readCi()))
    const config = job.match(/--config=(\S+)/)
    expect(config, 'the job no longer passes --config').not.toBeNull()
    const configPath = path.resolve(__dirname, '..', config![1])
    expect(fs.existsSync(configPath), `the job uses ${config![1]}, which does not exist`).toBe(true)

    const configSource = fs.readFileSync(configPath, 'utf8')
    const match = configSource.match(/testMatch:\s*\/(.+?)\//)
    expect(match, 'the gate config no longer declares a testMatch').not.toBeNull()
    const probe = path.resolve(__dirname, 'auth-gate.probe.ts')
    expect(fs.existsSync(probe), 'e2e/auth-gate.probe.ts does not exist').toBe(true)
    expect(new RegExp(match![1]).test('auth-gate.probe.ts'), 'the config testMatch no longer matches the probe').toBe(true)
  })

  it('lets a gate failure fail the build', () => {
    const job = withoutComments(gateJob(readCi()))
    expect(job).not.toMatch(/continue-on-error:\s*true/)
    // No credential check means no skip path: the probe never signs in, so there
    // is no legitimate reason for it to opt out of running.
    expect(job).not.toMatch(/steps\.creds\.outputs\.have/)
  })

  it('fails loudly when the build-time public config is missing', () => {
    // Without those values createServerClient throws on every request, the
    // catch-deny turns that into a /login redirect, and a probe asserting only
    // "307 to /login" would pass while proving nothing.
    const job = withoutComments(gateJob(readCi()))
    expect(job).toMatch(/::error::[^\n]*Missing build-time config/)
  })

  it('probes the artifact production serves, not the dev server', () => {
    // Whether the middleware runs BEFORE static assets is a property of the
    // built worker, so a dev-server probe could pass while production failed open.
    const job = withoutComments(gateJob(readCi()))
    expect(job).toMatch(/pages:build/)
    expect(job).toMatch(/wrangler" pages dev/)
  })
})

describe('the probe itself', () => {
  const probeSource = () => fs.readFileSync(path.resolve(__dirname, 'auth-gate.probe.ts'), 'utf8')
  const probeCode = () =>
    probeSource()
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n')

  it('refuses a gate-unavailable verdict rather than counting it as a pass', () => {
    expect(probeCode()).toMatch(/not\.toBe\('gate-unavailable'\)/)
  })

  it('asserts the positive gate header, not only the redirect', () => {
    expect(probeCode()).toMatch(/toBe\('redirect-login'\)/)
  })

  it('follows no redirects, so it observes the gate response itself', () => {
    expect(probeCode()).toMatch(/maxRedirects:\s*0/)
  })

  it('covers every gated route group the app exposes', () => {
    const code = probeCode()
    for (const route of ['/workflows', '/env', '/sources', '/endpoints', '/partners', '/integrations', '/settings', '/dashboard']) {
      expect(code, `the probe does not cover ${route}`).toContain(`'${route}'`)
    }
  })
})
