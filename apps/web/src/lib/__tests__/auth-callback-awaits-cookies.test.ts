import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The sign-in callback must AWAIT cookies().
 *
 * Next 15 made `cookies()` async. Without the await, `cookieStore` is a Promise,
 * `cookieStore.getAll` and `cookieStore.set` are undefined, and the Supabase
 * server client is handed a cookie adapter whose methods do not exist. The
 * session cookie is then never written, so a successful code exchange produces
 * no signed-in session and the person is bounced back to login with nothing
 * saying why. TypeScript catches it today, but the failure it prevents is silent
 * at runtime and lands on the one path everybody uses to get in.
 *
 * This asserts on the source rather than driving the route, for the same reason
 * the sibling redirect guard does: the route is an edge runtime handler that
 * imports Next server modules and cannot run in this environment.
 */
const CALLBACK = path.join(REPO_ROOT, 'apps/web/src/app/auth/callback/route.ts')

function source(): string {
  return readFileSync(CALLBACK, 'utf8')
}

/**
 * The file with comments removed.
 *
 * Scanning the raw text matches the word `cookies()` inside a comment ABOUT
 * cookies, including the ones in this very guard's sibling file, so the check
 * would fail on prose while the code was correct. Judge the code, never the
 * container it sits in (L361).
 */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('auth callback awaits cookies() (Next 15)', () => {
  it('the file still calls cookies(), so this guard is looking at something', () => {
    // Without this, a rename or a refactor that removes the call entirely would
    // leave every assertion below passing over a file that no longer does the
    // thing they describe.
    expect(code()).toMatch(/\bcookies\(\)/)
  })

  it('every cookies() call is awaited', () => {
    const src = code()
    // Each `cookies()` call must have `await` immediately before it. A bare one
    // yields a Promise that reads as a cookie store right up until a method is
    // called on it.
    const unawaited = [...src.matchAll(/\bcookies\(\)/g)].filter((m) => {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 10), m.index)
      return !/await\s+$/.test(before)
    })
    expect(unawaited).toHaveLength(0)
  })

  it('the cookie store is resolved once rather than awaited inside each closure', () => {
    // Both getAll and setAll close over the same store. Awaiting separately in
    // each would make setAll async, which the Supabase adapter does not await,
    // so writes would be dropped without an error.
    expect(code()).toMatch(/const cookieStore = await cookies\(\)/)
  })
})
