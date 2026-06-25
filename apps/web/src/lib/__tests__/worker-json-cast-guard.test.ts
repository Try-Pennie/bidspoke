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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, consumeParens } from './_scan-utils'

const SCAN_DIRS = ['lib', 'engine', 'routes', 'middleware'].map((d) => path.join(WORKER_SRC, d))
// The helper module documents the banned pattern in a comment — never scan it.
const HELPER_FILE = path.join(WORKER_SRC, 'lib/json.ts')

interface Finding { file: string; line: number }

// Flag any `.json()` whose result is cast with `as` — directly, through an outer
// `(await ...)`, or through a `.catch(...)` fallback. These are exactly the
// shapes #300 removed: `res.json() as T`, `(await res.json()) as T`,
// `(await res.json().catch(() => null)) as T`.
function findJsonCastViolations(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc)
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
