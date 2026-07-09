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
 * SCOPE: engine/, lib/ and routes/. A background write that touches nothing is
 * data loss; a route write that touches nothing is a lie to the caller, so
 * routes pair `.select(...)` with `requireRowOr404()` from lib/api-error to
 * answer 404 instead of a false 200 (#588). Either way the rule is the same:
 * end the statement in `.select(...)` so the rowcount is visible at all.
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
import { WORKER_SRC, listTsFiles, sanitizeSource, consumeParens, findSupabaseWrites } from './_scan-utils'

const SCAN_DIRS = ['engine', 'lib', 'routes'].map((d) => path.join(WORKER_SRC, d))

const OPT_OUT = /\/\/\s*zero-row-ok:/
// Lines above a write to search for its opt-out comment. A formatted chain puts
// `.delete(` a few lines below the statement head the comment sits above.
const OPT_OUT_LOOKBACK = 6

interface Finding {
  file: string
  line: number
  snippet: string
}

// The shared helpers that consume a write's rowcount (#590). A write must sit
// inside a call to one of these.
const ROWCOUNT_HELPERS = /\b(requireRowsAffected|requireRowOr404|rowsTouched)\s*(<[^>]*>)?\s*\(/g

/** Character ranges spanned by each helper call's argument list. */
function helperCallRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  ROWCOUNT_HELPERS.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ROWCOUNT_HELPERS.exec(src))) {
    const open = src.indexOf('(', m.index + m[1].length)
    if (open < 0) continue
    ranges.push([open, consumeParens(src, open)])
  }
  return ranges
}

function findUncheckedWrites(rawSrc: string, file: string): Finding[] {
  // sanitizeSource blanks comments and string CONTENTS in place, preserving
  // length, so offsets are shared between the two and we can slice either.
  const src = sanitizeSource(rawSrc)
  const rawLines = rawSrc.split('\n')
  const helperRanges = helperCallRanges(src)
  const findings: Finding[] = []

  for (const w of findSupabaseWrites(src, rawSrc)) {
    // PostgREST hands the rowcount straight back here, so there is nothing for a
    // helper to wrap. Bulk purges use it, where zero rows just means drained.
    if (/count:\s*'exact'/.test(w.rawStmt)) continue

    // A write ending in `.single()` is not the silent-success class at all:
    // PostgREST answers zero rows with a PGRST116 ERROR, which the caller's
    // `if (error)` already catches. (`.maybeSingle()` does not: it returns
    // `data: null, error: null`, so it stays in scope.) Whether that error is
    // then turned into a 404 is a different guard's job (#595).
    if (/\.single\(\)/.test(w.stmt)) continue

    // Otherwise the write must both expose its rowcount (.select) and hand it to
    // one of the shared helpers. A bare .select() whose count is then checked by
    // hand is what #590 removed: six copies of one check, each reacting
    // differently, is how this class kept coming back.
    const inHelper = helperRanges.some(([open, close]) => w.index > open && w.index < close)
    if (/\.select\(/.test(w.stmt) && inHelper) continue

    // Opt-out comment above the write. The window spans several lines because
    // the comment sits above the statement head (`const { error } = await
    // supabase`), which can be a few lines up from the `.delete(` itself in a
    // formatted chain. Read from the RAW source: sanitizeSource has already
    // blanked comments out of `src`.
    const optOutWindow = rawLines.slice(Math.max(0, w.line - OPT_OUT_LOOKBACK - 1), w.line).join('\n')
    if (OPT_OUT.test(optOutWindow)) continue

    findings.push({ file, line: w.line, snippet: (rawLines[w.line - 1] ?? '').trim() })
  }
  return findings
}

describe('worker zero-row write guard (#583)', () => {
  it('every supabase update/delete in engine, lib and routes checks how many rows it touched', () => {
    const findings: Finding[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (file.includes('__tests__')) continue
        findings.push(...findUncheckedWrites(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file)))
      }
    }

    expect(
      findings,
      `Supabase update/delete whose rowcount nothing consumes: a zero-row match would be reported as success.\n` +
        `End the statement in .select(...) and pass it to requireRowsAffected() (lib/db-retry),\n` +
        `or requireRowOr404()/rowsTouched() (lib/api-error) in a route. Do not check data?.length by hand.\n` +
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

  it('accepts an update that selects the rows it touched and hands them to the helper', () => {
    const src = wrap(`await requireRowsAffected('t.row', () => supabase.from('t').update({ a: 1 }).eq('id', id).select('id'));`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('accepts a multi-line chained update ending in select', () => {
    const src = wrap(`
      await requireRowsAffected('t.row', () =>
        supabase
          .from('t')
          .update({ a: 1 })
          .eq('id', id)
          .select('id')
      );`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // `.single()` makes PostgREST raise PGRST116 on zero rows, so the caller's
  // `if (error)` already sees the miss. `.maybeSingle()` swallows it.
  it('accepts an update-and-return that ends in single()', () => {
    const src = wrap(`const { data, error } = await supabase.from('t').update({ a: 1 }).eq('id', id).select().single();`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('flags a write that ends in maybeSingle(), which reports a miss as null', () => {
    const src = wrap(`const { data } = await supabase.from('t').update({ a: 1 }).eq('id', id).select().maybeSingle();`)
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  it('does not flag a non-supabase delete (Map, Set, KV)', () => {
    const src = wrap(`cache.delete(key); store.delete('k'); await env.IDEMPOTENCY.delete(k);`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // A router file reaches for `.from(` constantly, so "is there a `.from(`
  // nearby" cannot tell a supabase write from a Hono route registration or a KV
  // delete. Only the write's immediate receiver can. Without this, widening the
  // guard to routes/ buries the real findings under a pile of noise (#588).
  it('does not flag a Hono route registration that sits near a supabase read', () => {
    const src = `
const { data } = await supabase.from('user_allowlist').select('email')

access.delete('/:email', async (c) => {
  return c.json({ ok: true })
})`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('does not flag a KV delete that sits near a supabase write', () => {
    const src = `
async function a() {
  const { data } = await supabase.from('webhook_endpoints').select('id').eq('id', id)
  await c.env.WORKFLOW_CACHE.delete(cacheKey(existing.subdomain, existing.path))
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // The receiver of a supabase write is normally the `.from(...)` call itself,
  // but this codebase also builds detached query builders (`let query =
  // supabase`, then `query = query.eq(...)`). A receiver check that only knows
  // about `.from(...)` would go blind to a write made through one of those.
  it('flags an unchecked write made through a detached query builder', () => {
    const src = `
async function a() {
  let query = supabase.from('t')
  if (orgId) query = query.eq('organization_id', orgId)
  await query.update({ a: 1 }).eq('id', id)
}`
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  it('accepts a detached-builder write that selects the rows it touched', () => {
    const src = `
async function a() {
  let query = supabase.from('t')
  await requireRowsAffected('t.row', () => query.update({ a: 1 }).eq('id', id).select('id'))
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('is not fooled by a paren inside an eq() argument', () => {
    const src = wrap(`await requireRowsAffected('t.row', () => supabase.from('t').update({ a: 1 }).eq('id', String(id)).select('id'));`)
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
  const { rows } = await requireRowsAffected('t.row', () =>
    supabase
      .from('t')
      .update({ a: 1 })
      .eq('id', id)
      .select('id')
  )
  return rows
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  // #590: `.select(...)` only makes the rowcount VISIBLE. Six sites then checked
  // it by hand, each reacting differently, which is how this class kept coming
  // back. The rowcount must now be consumed by the shared helper.
  it('accepts a write routed through requireRowsAffected', () => {
    const src = `
async function a() {
  const { rows } = await requireRowsAffected('t.row', () =>
    supabase.from('t').update({ a: 1 }).eq('id', id).select('id')
  )
  return rows
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('accepts a write routed through requireRowOr404 or rowsTouched, generics and all', () => {
    const src = `
async function a() {
  const blocked = await requireRowOr404(c, 'Not found', () =>
    supabase.from('t').delete().eq('id', id).select('id')
  )
  const { rows } = await rowsTouched<{ id: string }>(c, 't.clear', () =>
    supabase.from('u').delete().eq('k', k).select('id')
  )
  return blocked ?? rows
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('accepts a write inside a helper callback that awaits into a local first', () => {
    const src = `
async function a() {
  await requireRowsAffected('t.row', async () => {
    const res = await supabase.from('t').update({ a: 1 }).eq('id', id).select('id')
    return res
  })
}`
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('flags a write that selects its rows but checks the count by hand', () => {
    const src = `
async function a() {
  const { data } = await supabase.from('t').update({ a: 1 }).eq('id', id).select('id')
  if (!data?.length) console.warn('vanished')
}`
    expect(findUncheckedWrites(src, 'x.ts')).toHaveLength(1)
  })

  // PostgREST hands the rowcount back directly here, so there is nothing for the
  // helper to wrap. Bulk purges use it, where zero rows just means drained.
  it('accepts a bulk delete that asks PostgREST for an exact count, outside any helper', () => {
    const src = wrap(`const { count } = await supabase.from('t').delete({ count: 'exact' }).in('id', ids);`)
    expect(findUncheckedWrites(src, 'x.ts')).toEqual([])
  })

  it('honors an opt-out on a hand-checked write', () => {
    const src = `
async function a() {
  // zero-row-ok: bulk cleanup, most ids are already gone
  const { data } = await supabase.from('t').delete().in('id', ids).select('id')
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
