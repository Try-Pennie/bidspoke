/**
 * Issue #729, contract phase. The browser's read access to `user_allowlist` is
 * revoked: `allowlist_read` is dropped and SELECT is revoked from `authenticated`
 * and `anon`, leaving `is_allowlisted()` as the only route.
 *
 * That makes a direct table read from the web app a runtime failure rather than
 * a compile error, and the failure is the dangerous kind: the middleware's
 * classifier would score it `error`, which fails closed to /access-denied, so
 * reintroducing a direct read would lock every employee out of the app with a
 * message that says nothing about the cause.
 *
 * Nothing in TypeScript can catch it, because the table name is a string. So
 * the invariant is asserted here instead: no shipping web source reads that
 * table through a Supabase client.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listFiles, sanitizeSource, WEB_SRC } from './_scan-utils'

/** Files that mention the table at all, with string contents preserved. */
function filesReferencingAllowlist(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = []
  // Include .ts and .tsx; skip __tests__ (this file names the table on purpose).
  for (const file of listFiles(WEB_SRC, { exts: ['.ts', '.tsx'] })) {
    const raw = readFileSync(file, 'utf8')
    // Blank COMMENTS but keep string contents, since the table name we are
    // hunting for lives inside a string literal. A comment discussing the
    // table must not trip the guard (LESSONS L103).
    const src = sanitizeSource(raw, { blankStrings: false })
    const re = /\.from\(\s*['"`]user_allowlist['"`]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      hits.push({
        file: path.relative(WEB_SRC, file),
        line: src.slice(0, m.index).split('\n').length,
        text: m[0],
      })
    }
  }
  return hits
}

describe('the web app never reads user_allowlist directly (#729)', () => {
  it('has no .from("user_allowlist") anywhere in shipping web source', () => {
    expect(filesReferencingAllowlist()).toEqual([])
  })

  it('detects the pattern it exists to catch, so it cannot pass vacuously', () => {
    // Guards that scan source can pass because their matcher is wrong rather
    // than because the codebase is clean. This pins the matcher itself.
    const sample = `const x = supabase.from('user_allowlist').select('email')`
    const re = /\.from\(\s*['"`]user_allowlist['"`]\s*\)/
    expect(re.test(sanitizeSource(sample, { blankStrings: false }))).toBe(true)
  })

  it('is not fooled by a comment mentioning the table', () => {
    const commented = `// we used to call supabase.from('user_allowlist') here\nconst y = 1`
    expect(
      /\.from\(\s*['"`]user_allowlist['"`]\s*\)/.test(
        sanitizeSource(commented, { blankStrings: false }),
      ),
    ).toBe(false)
  })
})
