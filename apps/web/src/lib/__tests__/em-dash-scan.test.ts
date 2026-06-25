import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { findEmDashes } from '../em-dash-scan'
import { REPO_ROOT, WEB_SRC, listTsxFiles } from './_scan-utils'

describe('findEmDashes — ignores comments, flags everything else', () => {
  it('ignores an em dash in a line comment', () => {
    expect(findEmDashes('const x = 1 // a — b\n')).toEqual([])
  })

  it('ignores an em dash in a block comment (even multi-line)', () => {
    expect(findEmDashes('/* one\n  two — three\n*/\nconst x = 1\n')).toEqual([])
  })

  it('flags an em dash in JSX text', () => {
    const hits = findEmDashes('<p>Saved — done</p>\n')
    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(1)
  })

  it('flags an em dash in single/double/template strings', () => {
    expect(findEmDashes("const a = 'x — y'")).toHaveLength(1)
    expect(findEmDashes('const a = "x — y"')).toHaveLength(1)
    expect(findEmDashes('const a = `x — y`')).toHaveLength(1)
  })

  it('does not treat // inside a string as a comment', () => {
    // The em dash is inside the string literal, not a comment.
    expect(findEmDashes('const a = "http:// — z"')).toHaveLength(1)
  })

  it('reports correct line numbers across multiple lines', () => {
    const hits = findEmDashes('line1\nconst a = "x — y"\nline3 // c — d\n<b>e — f</b>\n')
    expect(hits.map((h) => h.line)).toEqual([2, 4])
  })

  it('ignores en dash and hyphen (only the em dash U+2014 is banned)', () => {
    expect(findEmDashes('<p>range 1–5 and a-b</p>')).toEqual([])
  })

  it('honors an em-dash-ok opt-out on the same line', () => {
    expect(findEmDashes('const a = "x — y" // em-dash-ok: intentional\n')).toEqual([])
  })

  it('exempts a string that is only the em-dash placeholder glyph (no-value cell)', () => {
    expect(findEmDashes("return '—'")).toEqual([])
    expect(findEmDashes("<td>{value ?? '—'}</td>")).toEqual([])
    expect(findEmDashes('const a = "—"')).toEqual([])
    expect(findEmDashes('`—`')).toEqual([])
  })

  it('still flags an em dash embedded in a longer string', () => {
    expect(findEmDashes("const a = 'No winner — reason'")).toHaveLength(1)
  })
})

// ── Integration guard: no em dashes in user-facing copy ─────────────────────
// User-facing surfaces: rendered web UI (.tsx, minus tests) + the Slack message
// builders. Code comments are exempt (handled by findEmDashes); test files aren't
// user-facing so they're skipped.
function userFacingFiles(): string[] {
  return [
    ...listTsxFiles(WEB_SRC),
    path.join(REPO_ROOT, 'apps/worker/src/lib/slack.ts'),
  ]
}

describe('no em dashes in user-facing copy', () => {
  it('UI (.tsx) and Slack message copy use no em dashes (project convention)', () => {
    const violations: string[] = []
    for (const file of userFacingFiles()) {
      const hits = findEmDashes(readFileSync(file, 'utf8'))
      for (const h of hits) {
        violations.push(`  ${path.relative(REPO_ROOT, file)}:${h.line}  ${h.excerpt}`)
      }
    }
    expect(
      violations,
      `Em dash (—) found in user-facing copy. Use a period, colon, or comma instead ` +
        `(or add an "em-dash-ok" comment on the line if it is genuinely not copy):\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
