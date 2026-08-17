import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The sign-in callback must not send anyone to a host of the caller's choosing
 * (#730).
 *
 * The callback took a `next` query parameter and redirected to `origin + next`.
 * `origin` carries no trailing slash, so the concatenation is the whole bug: a
 * value beginning with `@` produces `https://bidspoke.trypennie.dev@evil.com`,
 * where everything before the `@` is userinfo and the browser goes to evil.com.
 * A value beginning with `.` produces `https://bidspoke.trypennie.dev.evil.com`,
 * a host an attacker can own outright. Both land the user on an attacker's page
 * immediately after a successful sign-in, which is the most convincing possible
 * moment to be asked for something.
 *
 * The parameter is DELETED rather than validated. Nothing in the app ever emitted
 * it: login/page.tsx sets redirectTo with no `next`, and no other source file
 * mentions it. So it was attacker-only surface, and removing it makes this test
 * exhaustive in a way that no allowlist of forbidden prefixes could be. Every
 * guard written as a list of bad shapes is one shape short of the next report.
 *
 * This asserts on the source rather than driving the route, because the route is
 * an edge runtime handler that imports Next server modules and cannot run in this
 * environment. What it proves is the property that matters: no caller-supplied
 * value reaches the redirect.
 */
const CALLBACK = path.join(REPO_ROOT, 'apps/web/src/app/auth/callback/route.ts')

const source = (): string => {
  const text = readFileSync(CALLBACK, 'utf8')
  expect(text.length, `${CALLBACK} is empty`).toBeGreaterThan(0)
  return text
}

/** Source with comments stripped, so prose about the rule cannot satisfy it. */
const code = (): string => source().replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the sign-in callback redirects only to fixed destinations (#730)', () => {
  it('reads no destination from the query string', () => {
    expect(
      code(),
      'the callback reads a redirect destination from the caller again, which is how the open redirect worked',
    ).not.toMatch(/searchParams\.get\(\s*['"]next['"]\s*\)/)
  })

  it('interpolates nothing but literals into a redirect', () => {
    // The actual property. Every redirect target must be `origin` plus a path
    // written here, never a value that arrived with the request.
    const redirects = [...code().matchAll(/NextResponse\.redirect\(([^)]*)\)/g)].map((m) => m[1].trim())
    expect(redirects.length, 'the callback no longer redirects at all').toBeGreaterThan(0)

    for (const target of redirects) {
      // Allowed: `${origin}/some/path` with an optional literal query string.
      expect(
        target,
        `redirect target ${target} is not a fixed path, so a caller could influence where sign-in lands`,
      ).toMatch(/^`\$\{origin\}\/[A-Za-z0-9/_?=-]*`$/)
    }
  })

  it('still sends a refused domain to the access-denied page', () => {
    // The removal must not take the domain reject with it. Someone signing in
    // with a personal account has to be told, not dropped somewhere generic.
    expect(code()).toMatch(/access-denied/)
  })

  it('still sends a failed exchange back to login with a reason', () => {
    expect(code()).toMatch(/login\?error=auth_callback_failed/)
  })
})
