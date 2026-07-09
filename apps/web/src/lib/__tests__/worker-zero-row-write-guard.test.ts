/**
 * Guard against the zero-row write class (#487, #506's sibling, #583).
 *
 * PostgREST answers a well-formed UPDATE or DELETE that matched nothing with
 * `{ data: [], error: null }`, a statement that succeeded and changed nothing.
 * So `const { error } = await supabase.from(t).update(x).eq('id', id)` reports
 * success for a write that silently did not happen.
 *
 * That is how #487 let a served lead's execution record vanish while the write
 * that lost it claimed OK, and how the lead-sighting winner mark could leave
 * is_winner=false forever (a failure engine/index.ts warns about in prose).
 *
 * The rule: a supabase `.update(...)` or `.delete()` in the engine and lib
 * background-write paths must end its statement in `.select(...)` so the caller
 * can check how many rows it touched. Pair it with `requireRowsAffected()` from
 * lib/db-retry, or check `data?.length` directly.
 *
 * SCOPE: engine/ and lib/ only. The routes/api/ surface has the same latent
 * problem, but with different semantics (a zero-row PATCH/DELETE there should be
 * a 404, not a data-loss alert) and is tracked separately. Do not widen this
 * guard to routes/ without doing that work.
 *
 * A deliberate exception opts out with a `// zero-row-ok: <reason>` comment on
 * the statement.
 *
 * NOTE: like its sibling guards, this lives in the web package and so is skipped
 * by worker-only test runs. Tracked in #502.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from './_scan-utils'

const SCAN_DIRS = ['engine', 'lib'].map((d) => path.join(WORKER_SRC, d))

const OPT_OUT = /\/\/\s*zero-row-ok:/
// Lines above a write to search for its opt-out comment. A formatted chain puts
// `.delete(` a few lines below the statement head the comment sits above.
const OPT_OUT_LOOKBACK = 6

interface Finding {
  file: string
  line: number
  snippet: string
}

// End of the method-chain statement that starts at `.update(` / `.delete(`.
//
// This codebase does not use semicolons, so a statement ends at a newline that
// leaves us outside every open paren AND is not continued by a chained `.method(`
// on the next line. Paren depth is what stops `.eq('id', String(id))` from
// ending the chain early. Operates on SANITIZED source, where parens inside
// string literals have already been blanked away.
function statementEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth <= 0) return i + 1
    else if (ch === '\n' && depth <= 0) {
      const next = /\S/.exec(src.slice(i + 1))
      // A chained `.select(...)` on the following line continues this statement.
      if (next && next[0] === '.') continue
      return i
    }
  }
  return src.length
}

function findUncheckedWrites(rawSrc: string, file: string): Finding[] {
  // sanitizeSource blanks comments and string CONTENTS in place, preserving
  // length, so offsets are shared between the two and we can slice either.
  const src = sanitizeSource(rawSrc)
  const rawLines = rawSrc.split('\n')
  const findings: Finding[] = []
  // `.update(` or `.delete(` reached off a supabase query builder. A `.from(`
  // on the statement is what distinguishes a PostgREST write from a Map/Set/KV
  // `.delete(`.
  const re = /\.(update|delete)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    const end = statementEnd(src, m.index)
    const stmt = src.slice(m.index, end)
    // String contents survive here, so `count: 'exact'` is matchable.
    const rawStmt = rawSrc.slice(m.index, end)

    const prefix = src.slice(Math.max(0, m.index - 400), m.index)
    if (!/\.from\(/.test(prefix) && !/\.from\(/.test(stmt)) continue

    // Two ways to learn the rowcount: ask PostgREST to return the rows
    // (.select) or ask it for an exact count (.delete({ count: 'exact' })).
    if (/\.select\(/.test(stmt)) continue
    if (/count:\s*'exact'/.test(rawStmt)) continue

    // Opt-out comment above the write. The window spans several lines because
    // the comment sits above the statement head (`const { error } = await
    // supabase`), which can be a few lines up from the `.delete(` itself in a
    // formatted chain. Read from the RAW source: sanitizeSource has already
    // blanked comments out of `src`.
    const optOutWindow = rawLines.slice(Math.max(0, line - OPT_OUT_LOOKBACK - 1), line).join('\n')
    if (OPT_OUT.test(optOutWindow)) continue

    findings.push({ file, line, snippet: (rawLines[line - 1] ?? '').trim() })
  }
  return findings
}

describe('worker zero-row write guard (#583)', () => {
  it('every supabase update/delete in engine and lib checks how many rows it touched', () => {
    const findings: Finding[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (file.includes('__tests__')) continue
        findings.push(...findUncheckedWrites(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file)))
      }
    }

    expect(
      findings,
      `Supabase update/delete without .select(...): a zero-row match would be reported as success.\n` +
        `Use requireRowsAffected() from lib/db-retry, or check data?.length.\n` +
        `Deliberate exception? Add "// zero-row-ok: <reason>" above the write.\n\n` +
        findings.map((f) => `  ${f.file}:${f.line}  ${f.snippet}`).join('\n')
    ).toEqual([])
  })
})

describe('the guard itself detects what it claims to (#583)', () => {
  const wrap = (body: string) => `async function f(){ ${body} }`

  it('flags an unchecked update', () => {
    const src = wrap(`const { error } = await supabase.from('t').update({ a: 1 }).eq('id', id);`)
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  it('flags an unchecked delete', () => {
    const src = wrap(`await supabase.from('t').delete().eq('id', id);`)
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  it('accepts an update that selects the rows it touched', () => {
    const src = wrap(`const { data } = await supabase.from('t').update({ a: 1 }).eq('id', id).select('id');`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('accepts a multi-line chained update ending in select', () => {
    const src = wrap(`
      const { data } = await supabase
        .from('t')
        .update({ a: 1 })
        .eq('id', id)
        .select('id');`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('does not flag a non-supabase delete (Map, Set, KV)', () => {
    const src = wrap(`cache.delete(key); store.delete('k'); await env.IDEMPOTENCY.delete(k);`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('is not fooled by a paren inside an eq() argument', () => {
    const src = wrap(`await supabase.from('t').update({ a: 1 }).eq('id', String(id)).select('id');`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('accepts a delete that asks PostgREST for an exact count', () => {
    const src = wrap(`const { count } = await supabase.from('t').delete({ count: 'exact' }).in('id', ids);`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // This codebase writes no semicolons. An earlier version of this scanner ran
  // to end-of-file looking for a terminator, so ANY later .select() in the file
  // silently satisfied every write above it and the guard passed vacuously.
  it('does not let a later, unrelated select() in the file satisfy an earlier write', () => {
    const src = `
async function a() {
  await supabase.from('t').update({ a: 1 }).eq('id', id)
}
async function b() {
  const { data } = await supabase.from('u').select('id')
  return data
}`
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  it('ends a semicolon-free chain at the first non-chained line', () => {
    const src = `
async function a() {
  const { data } = await supabase
    .from('t')
    .update({ a: 1 })
    .eq('id', id)
    .select('id')
  return data
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('honors an explicit opt-out comment', () => {
    const src = wrap(`
      // zero-row-ok: best-effort cleanup, the row may already be gone
      await supabase.from('t').delete().eq('id', id);`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // The real shape: the comment sits above the statement head, several lines
  // above the `.delete(` token itself.
  it('honors an opt-out comment above a formatted multi-line chain', () => {
    const src = `
async function a() {
  if (ids.length > 0) {
    // zero-row-ok: idempotent cleanup of rows observed stale moments earlier
    const { error } = await supabase
      .from('t')
      .delete()
      .in('id', ids)
    if (error) throw error
  }
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('does not let an opt-out comment leak onto an unrelated write far below it', () => {
    const src = `
async function a() {
  // zero-row-ok: this one is fine
  await supabase.from('t').delete().eq('id', id)

  const x = 1
  const y = 2
  const z = 3
  const w = 4
  const v = 5
  await supabase.from('u').update({ a: 1 }).eq('id', id)
}`
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })
})
