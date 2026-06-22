/**
 * Guard against the recurring "untyped JSON-response cast" debt (#300).
 *
 * `Response.json<T>()` is generic, so response bodies should be parsed through
 * the typed helpers in `apps/worker/src/lib/json.ts` (`parseJson<T>`,
 * `parseJsonSafe<T>`, `fetchJson<T>`) — never with `await res.json() as T`. The
 * cast form is what eslint flags as an unnecessary assertion (the `as T`
 * contextually pins the generic) while tsc still needs it; the helpers drop the
 * cast entirely. #300 paid this down across 15 files. This test fails if the
 * pattern reappears in worker source so it can't quietly re-accumulate.
 *
 * A genuinely unavoidable cast can opt out with a `// json-cast-ok: <reason>`
 * comment on the same statement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')
const WORKER_SRC = path.join(REPO_ROOT, 'apps/worker/src')
const SCAN_DIRS = ['lib', 'engine', 'routes', 'middleware'].map((d) => path.join(WORKER_SRC, d))
// The helper module documents the banned pattern in a comment — never scan it.
const HELPER_FILE = path.join(WORKER_SRC, 'lib/json.ts')

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

// Replace line/block comments and string/template contents with spaces so the
// scanner never trips on a `.json() as X` written inside a comment or string,
// while preserving offsets (so reported line numbers stay accurate).
function blankCommentsAndStrings(src: string): string {
  const out = src.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
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
      blank(i + 1, j)
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

// Flag any `.json()` whose result is cast with `as` — directly, through an outer
// `(await ...)`, or through a `.catch(...)` fallback. These are exactly the
// shapes #300 removed: `res.json() as T`, `(await res.json()) as T`,
// `(await res.json().catch(() => null)) as T`.
function findJsonCastViolations(rawSrc: string, file: string): Finding[] {
  const src = blankCommentsAndStrings(rawSrc)
  const findings: Finding[] = []
  const needle = '.json()'
  let from = 0
  for (;;) {
    const idx = src.indexOf(needle, from)
    if (idx === -1) break
    from = idx + needle.length
    let i = from
    const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++ }
    skipWs()
    if (src.startsWith('.catch', i)) {
      const paren = src.indexOf('(', i)
      if (paren !== -1) i = consumeParens(src, paren)
    }
    // Skip trailing whitespace and the closing parens of any wrapping `(await …)`.
    while (i < src.length && (/\s/.test(src[i]) || src[i] === ')')) i++
    if (src.startsWith('as', i) && !/\w/.test(src[i + 2] ?? ' ')) {
      // Allow an explicit opt-out comment on the statement.
      const lineStart = src.lastIndexOf('\n', idx) + 1
      const lineEnd = src.indexOf('\n', i)
      const stmt = rawSrc.slice(lineStart, lineEnd === -1 ? rawSrc.length : lineEnd)
      if (/json-cast-ok/.test(stmt)) continue
      findings.push({ file: path.relative(WORKER_SRC, file), line: src.slice(0, idx).split('\n').length })
    }
  }
  return findings
}

describe('findJsonCastViolations (detector)', () => {
  it('flags the simple cast form', () => {
    expect(findJsonCastViolations('const x = await res.json() as Foo', 'f.ts')).toHaveLength(1)
  })
  it('flags the parenthesized await form', () => {
    expect(findJsonCastViolations('const x = (await res.json()) as Foo', 'f.ts')).toHaveLength(1)
  })
  it('flags the .catch fallback cast form', () => {
    expect(findJsonCastViolations('const x = (await res.json().catch(() => null)) as Foo | null', 'f.ts')).toHaveLength(1)
  })
  it('does not flag the typed helpers', () => {
    expect(findJsonCastViolations('const x = await parseJson<Foo>(res)', 'f.ts')).toHaveLength(0)
    expect(findJsonCastViolations('const x = await parseJsonSafe<Foo>(res)', 'f.ts')).toHaveLength(0)
  })
  it('does not flag an uncast .json() (e.g. a typed return)', () => {
    expect(findJsonCastViolations('return res.json()', 'f.ts')).toHaveLength(0)
  })
  it('does not flag a cast written inside a comment', () => {
    expect(findJsonCastViolations('// replaces res.json() as Foo\nconst x = await parseJson<Foo>(res)', 'f.ts')).toHaveLength(0)
  })
  it('honors the json-cast-ok opt-out', () => {
    expect(findJsonCastViolations('const x = await res.json() as Foo // json-cast-ok: legacy', 'f.ts')).toHaveLength(0)
  })
})

describe('worker source has no untyped JSON-response casts (#300)', () => {
  it('parses every fetch Response through the typed json helpers', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d))
      .filter((f) => f !== HELPER_FILE)
      .flatMap((f) => findJsonCastViolations(readFileSync(f, 'utf8'), f))
    expect(
      findings,
      `Use parseJson<T>/parseJsonSafe<T>/fetchJson<T> from lib/json.ts instead of casting res.json():\n` +
        findings.map((f) => `  ${f.file}:${f.line}`).join('\n')
    ).toEqual([])
  })
})
