/**
 * Guard against the zero-row `.single()` write reported as a 500 (#595).
 *
 * A write that ends in `.select(...).single()` returns the updated row to the
 * caller. PostgREST answers a zero-row match there with a PGRST116 ERROR, not
 * with the silent `{ data: [], error: null }` that #588 was about. So these
 * writes DO surface a miss. The bug is where the miss lands:
 *
 *   if (error) return dbError(c, error)     // PGRST116 -> 500 "Internal error"
 *
 * PGRST116 means "no rows matched": a 404, not a server fault. docs/reference/
 * api.md promises `404 (not found or not in your org)`. `dbErrorUnlessNotFound`
 * in lib/api-error.ts exists for exactly this, and returns a 500 for every OTHER
 * error, so a transient database failure is never mistaken for a 404 (#303).
 *
 * The rule: a supabase `.update(...)` whose chain ends in `.single()` must route
 * its error through `dbErrorUnlessNotFound()` (or check `isNotFoundError()`)
 * before it can reach `dbError()`.
 *
 * This is the third return of one class: #303 on reads, #588 on silent writes,
 * #595 on `.single()` writes. The sibling guard (worker-zero-row-write-guard)
 * deliberately skips `.single()` writes and points here.
 *
 * A deliberate exception opts out with a `// single-404-ok: <reason>` comment.
 *
 * NOTE: like its sibling guards, this lives in the web package and so is skipped
 * by worker-only test runs. Tracked in #502.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, findSupabaseWrites } from './_scan-utils'

const SCAN_DIRS = ['routes'].map((d) => path.join(WORKER_SRC, d))

const OPT_OUT = /\/\/\s*single-404-ok:/
const OPT_OUT_LOOKBACK = 6

// How far past the statement to look for its error branch. The branch always
// sits immediately after the await, so this is generous rather than tuned.
const ERROR_BRANCH_WINDOW = 1200

// The two ways to spare a PGRST116 from becoming a 500.
const HANDLES_NOT_FOUND = /\b(dbErrorUnlessNotFound|isNotFoundError)\s*\(/

interface Finding {
  file: string
  line: number
  snippet: string
}

function findUnhandled404Writes(rawSrc: string, file: string): Finding[] {
  const src = sanitizeSource(rawSrc)
  const rawLines = rawSrc.split('\n')
  const writes = findSupabaseWrites(src, rawSrc)
  const findings: Finding[] = []

  for (const [i, w] of writes.entries()) {
    // Only update-and-return. A `.delete()` has no row to hand back, and an
    // insert cannot match zero rows.
    if (w.op !== 'update') continue
    if (!/\.single\(\)/.test(w.stmt)) continue

    // The error branch sits immediately after the await. Bound it at whichever
    // comes first: the next write, the next query (`.from(`), or the window.
    // Without the `.from(` bound, a LATER handler's existence lookup, which does
    // use dbErrorUnlessNotFound, silently satisfies this write.
    const nextWrite = writes[i + 1]?.index ?? src.length
    const nextQuery = src.indexOf('.from(', w.end)
    const bound = Math.min(nextWrite, nextQuery === -1 ? src.length : nextQuery, w.end + ERROR_BRANCH_WINDOW)
    if (HANDLES_NOT_FOUND.test(src.slice(w.end, bound))) continue

    const optOutWindow = rawLines.slice(Math.max(0, w.line - OPT_OUT_LOOKBACK - 1), w.line).join('\n')
    if (OPT_OUT.test(optOutWindow)) continue

    findings.push({ file, line: w.line, snippet: (rawLines[w.line - 1] ?? '').trim() })
  }
  return findings
}

describe('worker single()-write 404 guard (#595)', () => {
  it('every update-and-return route turns a zero-row match into a 404, not a 500', () => {
    const findings: Finding[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (file.includes('__tests__')) continue
        findings.push(...findUnhandled404Writes(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file)))
      }
    }

    expect(
      findings,
      `Supabase update ending in .single() whose PGRST116 reaches dbError(): a row that does not\n` +
        `exist, or belongs to another org, answers 500 instead of the 404 api.md promises.\n` +
        `Route the error through dbErrorUnlessNotFound() (lib/api-error), then "if (!data) return 404".\n` +
        `See routes/api/service-presets.ts for the shape.\n` +
        `Deliberate exception? Add "// single-404-ok: <reason>" above the write.\n\n` +
        findings.map((f) => `  ${f.file}:${f.line}  ${f.snippet}`).join('\n')
    ).toEqual([])
  })
})

describe('the guard itself detects what it claims to (#595)', () => {
  it('flags an update-and-return whose PGRST116 falls into dbError', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error) return dbError(c, error)
  return c.json(data)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toHaveLength(1)
  })

  it('accepts one that routes the error through dbErrorUnlessNotFound', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'not found' }, 404)
  return c.json(data)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  it('accepts one that checks isNotFoundError by hand', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error && !isNotFoundError(error)) return dbError(c, error)
  if (!data) return c.json({ error: 'not found' }, 404)
  return c.json(data)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  // A special case ahead of the not-found check is fine, and is why the two
  // folder routes and the endpoints route need care: dbErrorUnlessNotFound turns
  // every non-PGRST116 error into a 500, so 23505 and the cycle trigger must be
  // read first.
  it('accepts one that maps a constraint violation before the not-found check', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error?.code === '23505') return c.json({ error: 'duplicate' }, 409)
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'not found' }, 404)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  // These belong to the sibling guard, which polices the silent-success class.
  it('ignores a write with no single(), and a delete', () => {
    const src = `
async function a() {
  const { data } = await supabase.from('t').update(u).eq('id', id).select('id')
  await supabase.from('t').delete().eq('id', id).select('id')
  return data
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  it('ignores a maybeSingle() write, which never raises PGRST116 at all', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().maybeSingle()
  if (error) return dbError(c, error)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  it('does not let one handler\'s not-found check cover the next handler\'s write', () => {
    const src = `
async function a() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error) return dbError(c, error)
}
async function b() {
  const { data, error } = await supabase.from('u').update(u).eq('id', id).select().single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toHaveLength(1)
  })

  // The bug this bound prevents: env.ts's DELETE handler further down the file
  // uses dbErrorUnlessNotFound on its own lookup, which would otherwise vouch
  // for the PUT handler's unguarded update.
  it('does not let a later handler\'s existence lookup vouch for this write', () => {
    const src = `
async function put() {
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error) return dbError(c, error)
  return c.json(data)
}
async function del() {
  const { data, error } = await supabase.from('t').select('key').eq('id', id).single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toHaveLength(1)
  })

  it('does not flag a Hono route registration or a KV delete', () => {
    const src = `
const { data } = await supabase.from('t').select('id')
router.update = 1
access.delete('/:email', async (c) => c.json({ ok: true }))
await c.env.WORKFLOW_CACHE.delete(key)`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })

  it('honors an explicit opt-out comment', () => {
    const src = `
async function a() {
  // single-404-ok: the row was just inserted by this same request
  const { data, error } = await supabase.from('t').update(u).eq('id', id).select().single()
  if (error) return dbError(c, error)
}`
    expect(findUnhandled404Writes(src, 'x.ts')).toEqual([])
  })
})
