import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { listFiles, listTsFiles, listTsxFiles, sanitizeSource, consumeParens, REPO_ROOT, WORKER_SRC, WEB_SRC } from './_scan-utils'

describe('_scan-utils paths (#321)', () => {
  it('resolves repo roots that exist', () => {
    expect(existsSync(REPO_ROOT)).toBe(true)
    expect(existsSync(WORKER_SRC)).toBe(true)
    expect(existsSync(WEB_SRC)).toBe(true)
  })
})

describe('listFiles', () => {
  it('collects .ts files but not .test.ts, and skips __tests__', () => {
    const files = listTsFiles(WORKER_SRC)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))).toBe(true)
    expect(files.some((f) => f.includes('/__tests__/'))).toBe(false)
  })

  it('collects .tsx files but not .test.tsx', () => {
    const files = listTsxFiles(WEB_SRC)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))).toBe(true)
  })

  it('does not match .tsx when only .ts is requested', () => {
    const ts = listFiles(WEB_SRC, { exts: ['.ts'] })
    expect(ts.some((f) => f.endsWith('.tsx'))).toBe(false)
  })
})

describe('sanitizeSource', () => {
  it('blanks line and block comments while preserving offsets and newlines', () => {
    const src = 'a // c\nb /* x */ d'
    const out = sanitizeSource(src)
    expect(out.length).toBe(src.length) // offsets preserved
    expect(out.split('\n').length).toBe(2) // newlines preserved
    // Code chars survive at their positions; comment content ('c', 'x') is blanked.
    expect(out[0]).toBe('a')
    expect(out.startsWith('b ', src.indexOf('\n') + 1) || out.includes('\nb ')).toBe(true)
    expect(out.endsWith('d')).toBe(true)
    expect(out).not.toContain('c')
    expect(out).not.toContain('x')
  })

  it('blanks string contents but keeps the quotes (default)', () => {
    expect(sanitizeSource("x = 'ab'")).toBe("x = '  '")
  })

  it('does not treat // inside a string as a comment', () => {
    expect(sanitizeSource('u = "http://x" // real', { blankStrings: false })).toBe('u = "http://x"        ')
  })

  it('keeps string contents when blankStrings is false', () => {
    expect(sanitizeSource("x = 'ab' // c", { blankStrings: false })).toBe("x = 'ab'     ")
  })
})

describe('consumeParens', () => {
  it('returns the index just past the matching close paren', () => {
    const s = 'f(a, (b))rest'
    expect(s.slice(consumeParens(s, 1))).toBe('rest')
  })

  it('ignores parens inside string literals', () => {
    const s = "f('a)b')x"
    expect(s.slice(consumeParens(s, 1))).toBe('x')
  })
})
