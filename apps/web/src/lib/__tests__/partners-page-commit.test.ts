/**
 * .github/scripts/partners-page-commit.mjs: whether the signed in partners page
 * serves the commit just deployed (#2132). Each outcome has its own message
 * (L11): followed, not followed within the budget, could not sign in (the gate
 * redirected), no stamp, and no password. Time is set, never waited on (L290):
 * the clock and the sleep are injected.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { followPartnersPage } from '../../../../../.github/scripts/partners-page-commit.mjs'
import { buildCookieChunks, sessionCookieHeader, sessionStorageKey } from '../../../e2e/session-cookies'

const SHA = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const page = (sha: string | null) => `<html><head>${sha ? `<meta name="bidspoke-commit" content="${sha}"/>` : ''}</head><body>Partners</body></html>`

interface Look { status?: number; gate?: string; html?: string; error?: string }

function run(looks: Look[], opts: { budget?: number; interval?: number; signInError?: string } = {}) {
  let t = 0
  let i = 0
  const fetched: Array<{ url: string; cookie: string }> = []
  return followPartnersPage({
    siteUrl: 'https://bidspoke.example.test',
    expectedSha: SHA,
    budgetSeconds: opts.budget ?? 180,
    intervalSeconds: opts.interval ?? 15,
    signIn: async () => { if (opts.signInError) throw new Error(opts.signInError); return 'sb-x-auth-token=abc' },
    fetchPage: async (url: string, cookie: string) => {
      fetched.push({ url, cookie })
      const look = looks[Math.min(i++, looks.length - 1)]
      if (look.error) throw new Error(look.error)
      return { status: look.status ?? 200, headers: { get: (h: string) => (h === 'x-bidspoke-gate' ? look.gate ?? 'allow' : null) }, text: async () => look.html ?? '' }
    },
    now: () => t,
    sleep: async (ms: number) => { t += ms },
  }).then((r: { outcome: string; message: string; seconds: number }) => ({ ...r, fetched }))
}

describe('partners-page-commit: the outcomes', () => {
  it('passes once /partners serves this commit, fetched signed in and without cache busting', async () => {
    const r = await run([{ html: page(OLD) }, { html: page(OLD) }, { html: page(SHA) }])
    expect(r.outcome).toBe('flipped')
    expect(r.seconds).toBe(30)
    expect(r.fetched.every((f) => f.url === 'https://bidspoke.example.test/partners')).toBe(true)
    expect(r.fetched[0].cookie).toBe('sb-x-auth-token=abc')
  })

  it('fails with its own sentence when the page has not followed within the budget', async () => {
    const r = await run([{ html: page(OLD) }], { budget: 60, interval: 15 })
    expect(r.outcome).toBe('not-followed')
    expect(r.message).toMatch(/^Pages has not followed the Worker; open partners pages will refuse saves with a reload message until it does\./)
    expect(r.message).toMatch(/bbbbbbb/)
    expect(r.fetched.length).toBeLessThanOrEqual(60 / 15 + 1)
  })

  it('says it measured nothing when the gate redirects, rather than reading the login page', async () => {
    const r = await run([{ status: 307, gate: 'redirect-login' }])
    expect(r.outcome).toBe('not-signed-in')
    expect(r.message).toMatch(/could not sign in, so it measured nothing/)
    expect(r.message).toMatch(/redirect-login/)
  })

  it('says it measured nothing when signing in itself fails', async () => {
    const r = await run([{ html: page(SHA) }], { signInError: 'Invalid login credentials' })
    expect(r.outcome).toBe('not-signed-in')
    expect(r.message).toMatch(/could not sign in, so it measured nothing/)
    expect(r.fetched).toEqual([])
  })

  it('reports an unstamped page as its own outcome, never as followed or not', async () => {
    const r = await run([{ html: page(null) }], { budget: 30 })
    expect(r.outcome).toBe('unstamped')
    expect(r.message).toMatch(/no commit stamp/)
  })

  it('keeps looking through a failed fetch, and names it if the budget runs out on one', async () => {
    const flips = await run([{ error: 'fetch failed' }, { html: page(SHA) }])
    expect(flips.outcome).toBe('flipped')
    const never = await run([{ error: 'fetch failed' }], { budget: 30 })
    expect(never.outcome).toBe('not-followed')
    expect(never.message).toMatch(/unreachable/)
  })
})

describe('partners-page-commit: as CI runs it', () => {
  const script = path.join(REPO_ROOT, '.github/scripts/partners-page-commit.mjs')
  const exec = (env: Record<string, string>) => {
    try {
      execFileSync(process.execPath, ['--experimental-strip-types', script], { env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', stdio: 'pipe' })
      return { code: 0, out: '' }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: `${err.stdout}${err.stderr}` }
    }
  }

  it('a missing E2E_PASSWORD is an error, never a skip', () => {
    const r = exec({ SITE_URL: 'https://bidspoke.example.test', EXPECTED_SHA: SHA, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', E2E_EMAIL: 'e2e@example.test', BUDGET_SECONDS: '30', INTERVAL_SECONDS: '15' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/E2E_PASSWORD is not set/)
  })
})

describe('one cookie builder for the e2e setup and the deploy check (L613)', () => {
  it('global-setup.ts and the deploy check import the shared module, and neither carries its own copy', () => {
    const setup = readFileSync(path.join(REPO_ROOT, 'apps/web/e2e/global-setup.ts'), 'utf8')
    const script = readFileSync(path.join(REPO_ROOT, '.github/scripts/partners-page-commit.mjs'), 'utf8')
    expect(setup).toMatch(/from '\.\/session-cookies'/)
    expect(script).toMatch(/apps\/web\/e2e\/session-cookies\.ts/)
    for (const [label, text] of [['global-setup.ts', setup], ['partners-page-commit.mjs', script]] as const) {
      expect(text, `${label} defines its own cookie chunker`).not.toMatch(/function buildCookieChunks/)
      expect(text, `${label} carries its own chunk size`).not.toMatch(/3180/)
    }
  })

  it('builds the cookie @supabase/ssr reads: one cookie under the size, numbered chunks over it', () => {
    expect(sessionStorageKey('https://xvrmivmpfykwwtriqwpg.supabase.co')).toBe('sb-xvrmivmpfykwwtriqwpg-auth-token')
    expect(buildCookieChunks('k', 'small')).toEqual([{ name: 'k', value: 'small' }])
    const big = buildCookieChunks('k', 'x'.repeat(7000))
    expect(big.map((c) => c.name)).toEqual(['k.0', 'k.1', 'k.2'])
    expect(big.map((c) => c.value).join('')).toBe('x'.repeat(7000))
    expect(sessionCookieHeader('https://abc.supabase.co', { a: 1 })).toBe(`sb-abc-auth-token=${encodeURIComponent('{"a":1}')}`)
  })
})
