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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, consumeParens } from '../../__tests__/_scan-utils'

const SCAN_DIRS = ['lib', 'engine', 'routes', 'middleware'].map((d) => path.join(WORKER_SRC, d))
// The one place the PGRST116 code is allowed to appear (it defines the helpers).
const HELPER_FILE = path.join(WORKER_SRC, 'lib/api-error.ts')

interface Finding { file: string; line: number }

// (g1) Flag `if (<...error...>) ... 404`, a condition that mentions an error and
// returns a 404. This covers BOTH the combined form (`if (error || !data) ...404`)
// and the bare form (`if (error) ...404`, #596): for a `.single()` lookup `error`
// is PGRST116 (zero rows) OR a real DB failure, so returning 404 on any error
// tells the caller a row is gone during a transient blip. The fix is the same
// split: dbErrorUnlessNotFound(c, error) for a real error (5xx), then
// `if (!data) return 404` only for genuine zero-rows.
//
// A condition that narrows on not-found (`isNotFoundError(...)`) is the correct
// shape (it 404s ONLY on a genuine zero-rows), so it is not flagged. So is
// `instanceof WorkflowNotFoundError`: the definition loader throws it only for
// zero rows and a plain Error for a real database failure (#303, #1780).
function findConflation(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc)
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
    if (!/error/i.test(cond) || !/\b404\b/.test(body)) continue
    // Narrowing on a genuine not-found is the correct gate, not a conflation:
    // isNotFoundError (read side, PGRST116), isNoRowMatchedError (write side), or
    // the definition loader's own zero-rows error.
    if (/isNotFoundError|isNoRowMatchedError|instanceof WorkflowNotFoundError\b/.test(cond)) continue
    const stmt = rawSrc.slice(m.index, nl === -1 ? rawSrc.length : nl)
    if (/db-guard-ok/.test(stmt)) continue
    findings.push({ file: path.relative(WORKER_SRC, file), line: src.slice(0, m.index).split('\n').length })
  }
  return findings
}

// (g2) Flag the PGRST116 code literal in application code (comments stripped,
// strings preserved) anywhere outside the helper module.
function findPgrstLiteral(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc, { blankStrings: false })
  const findings: Finding[] = []
  const re = /PGRST116/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    findings.push({ file: path.relative(WORKER_SRC, file), line: src.slice(0, m.index).split('\n').length })
  }
  return findings
}

// (g3) Flag the related case #319: a `.single()`/`.maybeSingle()` destructure
// that drops `error` entirely (`const { data } = await …`) whose result is later
// gated with a 404. With no `error` binding, a transient DB failure surfaces as
// `data == null` and 404s the same way — the same lead-loss class. The fix is to
// destructure `error` and split via dbErrorUnlessNotFound() before the !data 404.
interface Decl { line: number; dataVar: string; hasError: boolean; isSingle: boolean }

function findDroppedError(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc)
  const rawLines = rawSrc.split('\n')
  const lines = src.split('\n')

  // Collect every `const|let { … } = await …` destructure, with whether it binds
  // `error`, the data var it binds, and whether its chain ends in single()/
  // maybeSingle(). Keyed by line so a `!var` gate can resolve the NEAREST
  // preceding declaration of that var — two handlers reusing the name `existing`
  // must not cross-contaminate (one may handle error, the other drop it).
  const decls: Decl[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b(?:const|let)\s*\{([^}]*)\}\s*=\s*await\b/)
    if (!m) continue
    const pattern = m[1]
    const dataMatch = pattern.match(/\bdata\b\s*(?::\s*(\w+))?/)
    if (!dataMatch) continue
    // Window = this line through the end of its await chain (stop at a blank line
    // or the next `= await`), so a later query's .single() can't bleed in.
    let end = i + 1
    while (end < lines.length && end < i + 12 && lines[end].trim() !== '' && !/=\s*await\b/.test(lines[end])) end++
    const windowText = lines.slice(i, end).join('\n')
    decls.push({
      line: i,
      dataVar: dataMatch[1] ?? 'data',
      hasError: /\berror\b/.test(pattern),
      isSingle: /\.(single|maybeSingle)\s*\(\s*\)/.test(windowText),
    })
  }
  if (decls.length === 0) return []

  // A `if (!<var>) … 404` whose nearest preceding declaration of <var> was a
  // single()/maybeSingle() lookup that dropped `error` is the bug.
  const findings: Finding[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bif\s*\(\s*!\s*(\w+)\s*\)/)
    if (!m) continue
    const body = lines.slice(i, i + 3).join('\n') // body may wrap a couple of lines
    if (!/\b404\b/.test(body)) continue
    const decl = decls.filter((d) => d.dataVar === m[1] && d.line <= i).pop()
    if (!decl || decl.hasError || !decl.isSingle) continue
    if (/db-guard-ok/.test(rawLines[i]) || /db-guard-ok/.test(rawLines[decl.line])) continue
    findings.push({ file: path.relative(WORKER_SRC, file), line: i + 1 })
  }
  return findings
}

describe('findConflation (detector)', () => {
  it('flags `if (error || !data) return …404` (the combined form)', () => {
    expect(findConflation(`if (error || !config) return c.json({ error: 'Config not found' }, 404)`, 'f.ts')).toHaveLength(1)
    expect(findConflation(`if (error || !execution) return c.json({ error: 'Execution not found' }, 404)`, 'f.ts')).toHaveLength(1)
  })
  it('flags the bare `if (error) return …404` form with no || (#596)', () => {
    expect(findConflation(`if (error) return c.json({ error: 'Workflow not found' }, 404)`, 'f.ts')).toHaveLength(1)
    expect(findConflation(`if (ownerError) return c.json({ error: 'Execution not found' }, 404)`, 'f.ts')).toHaveLength(1)
  })
  it('does NOT flag a condition that narrows on not-found (isNotFoundError)', () => {
    expect(findConflation(`if (isNotFoundError(error)) return c.json({ error: 'Not found' }, 404)`, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag the write-side not-found narrowing (isNoRowMatchedError)', () => {
    expect(findConflation(`if (isNoRowMatchedError(error)) return c.json({ error: notFoundMessage }, 404)`, 'f.ts')).toHaveLength(0)
  })
  // The definition loader throws WorkflowNotFoundError only for a genuine
  // zero-rows lookup, and a plain Error for a real database failure (#303), so
  // narrowing on it is the same correct gate as isNotFoundError (#1780).
  it("does NOT flag a narrowing on the definition loader's WorkflowNotFoundError", () => {
    expect(findConflation(`if (err instanceof WorkflowNotFoundError) return c.json({ error: 'Workflow not found' }, 404)`, 'f.ts')).toHaveLength(0)
  })

  it('still flags any other error class answered with a 404', () => {
    expect(findConflation(`if (err instanceof Error) return c.json({ error: 'Workflow not found' }, 404)`, 'f.ts')).toHaveLength(1)
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

describe('findDroppedError (detector)', () => {
  it('flags a single() destructure that omits error then 404s on !data', () => {
    const bad = `const { data } = await supabase.from('x').select('*').single()\n  if (!data) return c.json({ error: 'Not found' }, 404)`
    expect(findDroppedError(bad, 'f.ts')).toHaveLength(1)
  })
  it('flags an aliased maybeSingle() destructure (const { data: config }) gated with 404', () => {
    const bad = `const { data: config } = await supabase.from('x').select('*').maybeSingle()\n  if (!config) return c.json({ error: 'Config not found' }, 404)`
    expect(findDroppedError(bad, 'f.ts')).toHaveLength(1)
  })
  it('does NOT flag when error IS destructured', () => {
    const ok = `const { data, error } = await supabase.from('x').select('*').single()\n  if (!data) return c.json({ error: 'Not found' }, 404)`
    expect(findDroppedError(ok, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag a list query (no single/maybeSingle) gated with 404', () => {
    const ok = `const { data } = await supabase.from('x').select('*')\n  if (!data) return c.json({ error: 'Not found' }, 404)`
    expect(findDroppedError(ok, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag a single() destructure when there is no 404 gate', () => {
    const ok = `const { data } = await supabase.from('x').select('*').single()\n  if (!data) return null`
    expect(findDroppedError(ok, 'f.ts')).toHaveLength(0)
  })
  it('honors the db-guard-ok opt-out on the gate', () => {
    const ok = `const { data } = await supabase.from('x').select('*').single()\n  if (!data) return c.json({}, 404) // db-guard-ok: list endpoint, error handled above`
    expect(findDroppedError(ok, 'f.ts')).toHaveLength(0)
  })
  it('does NOT flag a pattern that lives inside a comment or string', () => {
    expect(findDroppedError(`// const { data } = await x.single()\n// if (!data) return 404`, 'f.ts')).toHaveLength(0)
  })
  it('resolves to the NEAREST preceding decl: a handled `existing` is not tainted by a dropped one elsewhere', () => {
    // Two handlers reuse the name `existing`. The first drops error (bug); the
    // second handles it (ok). Only the first gate should flag.
    const src =
      `const { data: existing } = await supabase.from('a').select('*').single()\n` +
      `  if (!existing) return c.json({}, 404)\n` +
      `function other() {\n` +
      `  const { data: existing, error: existingError } = await supabase.from('b').select('*').single()\n` +
      `  if (existingError && !isNotFoundError(existingError)) return dbError(c, existingError)\n` +
      `  if (!existing) return c.json({}, 404)\n` +
      `}`
    const found = findDroppedError(src, 'f.ts')
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2) // the dropped-error gate, not the handled one
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

  it('never drops the DB error on a single() lookup that 404s (#319)', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d)).flatMap((f) => findDroppedError(readFileSync(f, 'utf8'), f))
    expect(
      findings,
      `Destructure { data, error } and split the gate: dbErrorUnlessNotFound(c, error) ` +
        `for a real error, then if (!data) return 404 only for genuine zero-rows:\n` +
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
