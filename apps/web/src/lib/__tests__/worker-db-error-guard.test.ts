/**
 * Guard against the swallowed-Supabase-error / false-404 class (#303, #315).
 *
 * A `.single()` existence lookup that conflates a DB error with "not found"
 * (`if (error || !data) return …404`) turns a TRANSIENT database failure into a
 * 404. On a lead path a 404 makes the lead source treat the endpoint as gone
 * and stop retrying — the lead is dropped. The correct gate splits the two:
 * a real error is a retryable 5xx (`dbErrorUnlessNotFound`), only genuine
 * zero-rows (PGRST116) is a 404. #303 fixed ~24 sites; this test stops the
 * class from recurring.
 *
 * Two checks:
 *   (g1) No `if (<error> || !<data>) return …404` conflation.
 *   (g2) The PGRST116 magic string lives only in lib/api-error.ts — everywhere
 *        else must go through isNotFoundError()/dbErrorUnlessNotFound().
 *
 * A deliberate exception can opt out with a `// db-guard-ok: <reason>` comment
 * on the same statement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')
const WORKER_SRC = path.join(REPO_ROOT, 'apps/worker/src')
const SCAN_DIRS = ['lib', 'engine', 'routes', 'middleware'].map((d) => path.join(WORKER_SRC, d))
// The one place the PGRST116 code is allowed to appear (it defines the helpers).
const HELPER_FILE = path.join(WORKER_SRC, 'lib/api-error.ts')

function listTsFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...listTsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// Replace comments — and optionally string/template contents — with spaces,
// preserving offsets (so line numbers stay accurate). Strings are always
// *skipped* so a `//` inside a URL string isn't mistaken for a comment; they're
// only blanked when blankStrings is set.
function sanitize(src: string, blankStrings: boolean): string {
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < src.length && src[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      blank(i, j + 2)
      i = j + 2
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      if (blankStrings) blank(i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

// Consume a balanced (...) starting at src[open] === '('. Returns the index just
// past the matching ')'.
function consumeParens(src: string, open: number): number {
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth++
    else if (src[k] === ')') { depth--; if (depth === 0) return k + 1 }
  }
  return src.length
}

interface Finding { file: string; line: number }

// (g1) Flag `if (<…error… || …>) … 404` — an error-or-missing-data condition
// that returns a 404. The fix is to split: dbErrorUnlessNotFound(c, error) for a
// real error (5xx), then `if (!data) return 404` only for genuine zero-rows.
function findConflation(rawSrc: string, file: string): Finding[] {
  const src = sanitize(rawSrc, true)
  const findings: Finding[] = []
  const re = /\bif\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const close = consumeParens(src, open)
    const cond = src.slice(open + 1, close - 1)
    const nl = src.indexOf('\n', close)
    const body = src.slice(close, nl === -1 ? src.length : nl)
    re.lastIndex = close
    if (!/\|\|/.test(cond) || !/error/i.test(cond) || !/\b404\b/.test(body)) continue
    const stmt = rawSrc.slice(m.index, nl === -1 ? rawSrc.length : nl)
    if (/db-guard-ok/.test(stmt)) continue
    findings.push({ file: path.relative(WORKER_SRC, file), line: src.slice(0, m.index).split('\n').length })
  }
  return findings
}

// (g2) Flag the PGRST116 code literal in application code (comments stripped,
// strings preserved) anywhere outside the helper module.
function findPgrstLiteral(rawSrc: string, file: string): Finding[] {
  const src = sanitize(rawSrc, false)
  const findings: Finding[] = []
  const re = /PGRST116/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    findings.push({ file: path.relative(WORKER_SRC, file), line: src.slice(0, m.index).split('\n').length })
  }
  return findings
}

describe('findConflation (detector)', () => {
  it('flags `if (error || !data) return …404` (the real bug)', () => {
    expect(findConflation(`if (error || !config) return c.json({ error: 'Config not found' }, 404)`, 'f.ts')).toHaveLength(1)
    expect(findConflation(`if (error || !execution) return c.json({ error: 'Execution not found' }, 404)`, 'f.ts')).toHaveLength(1)
  })
  it('does NOT flag the corrected split (real error → 5xx, then !data → 404)', () => {
    const fixed = `const blocked = dbErrorUnlessNotFound(c, error)\n  if (blocked) return blocked\n  if (!config) return c.json({ error: 'Config not found' }, 404)`
    expect(findConflation(fixed, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag an error-conflation that returns a non-404 (e.g. 401 auth)', () => {
    expect(findConflation(`if (error || !user) return c.json({ error: 'unauthorized' }, 401)`, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag a 404 with no error in the condition', () => {
    expect(findConflation(`if (!data) return c.json({ error: 'Not found' }, 404)`, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag a 404 condition inside a comment or string', () => {
    expect(findConflation(`// if (error || !data) return 404\nconst x = 1`, 'f.ts')).toHaveLength(0)
    expect(findConflation(`const msg = 'if (error || !data) return 404'`, 'f.ts')).toHaveLength(0)
  })
  it('honors the db-guard-ok opt-out', () => {
    expect(findConflation(`if (error || !data) return c.json({}, 404) // db-guard-ok: error can't be transient here`, 'f.ts')).toHaveLength(0)
  })
})

describe('findPgrstLiteral (detector)', () => {
  it('flags an inline PGRST116 code literal', () => {
    expect(findPgrstLiteral(`if (error && error.code !== 'PGRST116') return dbError(c, error)`, 'f.ts')).toHaveLength(1)
  })
  it('does NOT flag a PGRST116 mention inside a comment', () => {
    expect(findPgrstLiteral(`// PGRST116 is the zero-rows code\nconst x = 1`, 'f.ts')).toHaveLength(0)
  })
})

describe('worker source has no swallowed-error / false-404 patterns (#315)', () => {
  it('never conflates a DB error with a 404', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d)).flatMap((f) => findConflation(readFileSync(f, 'utf8'), f))
    expect(
      findings,
      `Split the gate: dbErrorUnlessNotFound(c, error) for a real error, then ` +
        `if (!data) return 404 only for genuine zero-rows:\n` +
        findings.map((f) => `  ${f.file}:${f.line}`).join('\n')
    ).toEqual([])
  })

  it('keeps the PGRST116 code in lib/api-error.ts only', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d))
      .filter((f) => f !== HELPER_FILE)
      .flatMap((f) => findPgrstLiteral(readFileSync(f, 'utf8'), f))
    expect(
      findings,
      `Use isNotFoundError()/dbErrorUnlessNotFound() from lib/api-error.ts instead of the raw PGRST116 code:\n` +
        findings.map((f) => `  ${f.file}:${f.line}`).join('\n')
    ).toEqual([])
  })
})
