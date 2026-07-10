/**
 * Guard against unbounded writes to partitioned tables (#619).
 *
 * lead_sightings, lead_sighting_bids and achieve_evaluations are RANGE-partitioned
 * monthly. An UPDATE/DELETE that matches on an identifier alone (`.eq('id', ...)`)
 * cannot be pruned, so Postgres opens EVERY monthly partition to reach one row --
 * a cost that grows with every month the table lives. This trap recurred twice
 * (the read-side `in()`-with-a-single-id, then the write-side sites fixed in #589)
 * before it earned a guard.
 *
 * The rule: any supabase `.update()`/`.delete()` against one of the partitioned
 * tables must carry a predicate on that table's partition key (an `.eq`/`.gte`/
 * `.lte`/... on the key column), so the planner can prune to the partitions the
 * write actually touches. The correct pattern already exists at
 * lib/sightings-export.ts (`.gte/.lte` on the key) and the #589 sites.
 *
 * The policed table -> partition-key map is NOT duplicated here: it is derived
 * from the worker's canonical registry (lib/partitioned-tables.ts), read as text,
 * so the two can never drift.
 *
 * A deliberate exception opts out with a `// partition-key-ok: <reason>` comment
 * above the write.
 *
 * NOTE: like its sibling guards, this lives in the web package and so is skipped
 * by worker-only test runs. Tracked in #502.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  WORKER_SRC,
  listTsFiles,
  sanitizeSource,
  matchingOpenParen,
  identifierBefore,
  consumeParens,
  findSupabaseWrites,
  type SupabaseWrite,
} from './_scan-utils'

const SCAN_DIRS = ['engine', 'lib', 'routes'].map((d) => path.join(WORKER_SRC, d))

const OPT_OUT = /\/\/\s*partition-key-ok:/
// A formatted chain puts `.update(` a few lines below the statement head the
// opt-out comment sits above.
const OPT_OUT_LOOKBACK = 6

// PostgREST filter builders that place a real WHERE predicate on their first
// column argument, letting the planner prune partitions. `.select`/`.update`/
// `.order`/`.limit` are deliberately absent: naming the key column there does NOT
// bound the write (e.g. `.select('id, attempted_at_utc')` returns the column, it
// does not filter on it).
const PREDICATE_METHODS = 'eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|filter'

/**
 * The policed table -> partition-key map, parsed from the worker's canonical
 * registry so there is a single source of truth (#619).
 */
export function loadPartitionedTables(registrySrc: string): Record<string, string> {
  const src = sanitizeSource(registrySrc, { blankStrings: false })
  const start = src.indexOf('PARTITIONED_TABLES')
  if (start < 0) throw new Error('PARTITIONED_TABLES not found in registry')
  const open = src.indexOf('{', start)
  const close = consumeBraces(src, open)
  const body = src.slice(open + 1, close - 1)
  const out: Record<string, string> = {}
  const re = /([\w$]+)\s*:\s*['"`]([^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]] = m[2]
  if (Object.keys(out).length === 0) throw new Error('no entries parsed from PARTITIONED_TABLES')
  return out
}

/** Consume a balanced `{...}` starting at `src[open] === '{'`; index past the `}`. */
function consumeBraces(src: string, open: number): number {
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return src.length
}

/** First string literal in `s`, or null. */
function firstStringLiteral(s: string): string | null {
  const m = /['"`]([^'"`]+)['"`]/.exec(s)
  return m ? m[1] : null
}

/**
 * Names bound to a `supabase.from('table')` builder, mapped to their table
 * literal. This codebase builds detached builders for conditional filters, so a
 * write can be reached through one instead of directly off `.from(...)`.
 */
function buildFromVarTable(sanitized: string, raw: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*supabase\s*\.\s*from\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sanitized))) {
    const open = m.index + m[0].length - 1
    const close = consumeParens(sanitized, open)
    const table = firstStringLiteral(raw.slice(open + 1, close - 1))
    if (table) map.set(m[1], table)
  }
  return map
}

/**
 * The table a write targets, or null when it can't be resolved to a literal
 * (e.g. `supabase.from(tableName)` with a variable -- those the guard can't
 * reason about statically, and the one such site is already bounded).
 *
 * The receiver of `.update(`/`.delete(` is either the `from(...)` call it hangs
 * off, or a detached builder variable.
 */
function resolveTargetTable(
  sanitized: string,
  raw: string,
  write: SupabaseWrite,
  fromVarTable: Map<string, string>,
): string | null {
  let i = write.index - 1
  while (i >= 0 && /\s/.test(sanitized[i])) i--
  if (i < 0) return null
  if (sanitized[i] === ')') {
    const open = matchingOpenParen(sanitized, i)
    if (open < 0) return null
    if (identifierBefore(sanitized, open) !== 'from') return null
    return firstStringLiteral(raw.slice(open + 1, i))
  }
  return fromVarTable.get(identifierBefore(sanitized, i + 1)) ?? null
}

/** True when the write's statement bounds the partition key with a real predicate. */
function hasPartitionPredicate(rawStmt: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // .eq('key', ...) / .gte("key", ...) / .filter(`key`, ...) -- the key column as
  // the first argument to a predicate builder.
  const asArg = new RegExp(`\\.(?:${PREDICATE_METHODS})\\(\\s*['"\`]${esc}['"\`]`)
  // .match({ key: ... }) object form.
  const asMatchKey = new RegExp(`\\.match\\(\\s*\\{[^}]*\\b${esc}\\b`)
  // .or('key.gte.x') filter-string form.
  const asOrString = new RegExp(`\\.or\\(\\s*['"\`][^'"\`]*\\b${esc}\\b`)
  return asArg.test(rawStmt) || asMatchKey.test(rawStmt) || asOrString.test(rawStmt)
}

export interface Finding {
  file: string
  line: number
  table: string
  snippet: string
}

export function findUnboundedPartitionWrites(
  rawSrc: string,
  file: string,
  partitioned: Record<string, string>,
): Finding[] {
  // sanitizeSource blanks comments and string CONTENTS in place, preserving
  // length, so offsets are shared and we can slice either buffer.
  const src = sanitizeSource(rawSrc)
  const rawLines = rawSrc.split('\n')
  const fromVarTable = buildFromVarTable(src, rawSrc)
  const findings: Finding[] = []

  for (const w of findSupabaseWrites(src, rawSrc)) {
    const table = resolveTargetTable(src, rawSrc, w, fromVarTable)
    if (!table) continue
    const key = partitioned[table]
    if (!key) continue
    if (hasPartitionPredicate(w.rawStmt, key)) continue

    // Opt-out comment above the write. The window spans several lines because the
    // comment sits above the statement head, which can be a few lines up from the
    // `.update(`/`.delete(` token in a formatted chain. Read from RAW source:
    // sanitizeSource has already blanked comments out of `src`.
    const optOutWindow = rawLines.slice(Math.max(0, w.line - OPT_OUT_LOOKBACK - 1), w.line).join('\n')
    if (OPT_OUT.test(optOutWindow)) continue

    findings.push({ file, line: w.line, table, snippet: (rawLines[w.line - 1] ?? '').trim() })
  }
  return findings
}

const REGISTRY = readFileSync(path.join(WORKER_SRC, 'lib/partitioned-tables.ts'), 'utf8')
const PARTITIONED = loadPartitionedTables(REGISTRY)

describe('worker partition-key write guard (#619)', () => {
  it('every update/delete against a partitioned table carries a partition-key predicate', () => {
    const findings: Finding[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (file.includes('__tests__')) continue
        findings.push(...findUnboundedPartitionWrites(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file), PARTITIONED))
      }
    }

    expect(
      findings,
      `Supabase update/delete against a monthly-partitioned table with no predicate on its\n` +
        `partition key: the planner opens every partition to reach one row (#589, #619).\n` +
        `Add an .eq/.gte/.lte on the table's partition key (see lib/partitioned-tables.ts).\n` +
        `Deliberate exception? Add "// partition-key-ok: <reason>" above the write.\n\n` +
        findings.map((f) => `  ${f.file}:${f.line}  [${f.table}]  ${f.snippet}`).join('\n')
    ).toEqual([])
  })
})

describe('the guard itself detects what it claims to (#619)', () => {
  const P = PARTITIONED
  const wrap = (body: string) => `async function f(){ ${body} }`

  it('parses the canonical registry into the three known partitioned tables', () => {
    expect(P).toEqual({
      lead_sightings: 'execution_started_at_utc',
      lead_sighting_bids: 'attempted_at_utc',
      achieve_evaluations: 'requested_at_utc',
    })
  })

  it('flags an update on a partitioned table keyed on id alone', () => {
    const src = wrap(`await supabase.from('lead_sighting_bids').update({ a: 1 }).eq('id', id);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })

  it('flags a delete on a partitioned table keyed on id alone', () => {
    const src = wrap(`await supabase.from('lead_sightings').delete().eq('id', id);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })

  it('accepts an update bounded by an eq on the partition key', () => {
    const src = wrap(`await supabase.from('lead_sightings').update({ a: 1 }).eq('id', id).eq('execution_started_at_utc', t);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('accepts an update bounded by a gte lower bound on the partition key', () => {
    const src = wrap(`await supabase.from('lead_sighting_bids').update({ a: 1 }).eq('execution_id', e).gte('attempted_at_utc', lb).select('id');`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('accepts a delete bounded by a gte/lte range on the partition key', () => {
    const src = wrap(`await supabase.from('achieve_evaluations').delete({ count: 'exact' }).in('id', ids).gte('requested_at_utc', min).lte('requested_at_utc', max);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('does not treat naming the key column in .select() as a bound', () => {
    const src = wrap(`await supabase.from('lead_sighting_bids').update({ a: 1 }).eq('id', id).select('id, attempted_at_utc');`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })

  it('does not flag inserts (they route to a single partition by their own key value)', () => {
    const src = wrap(`await supabase.from('lead_sightings').insert(row);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('does not flag writes to non-partitioned tables', () => {
    const src = wrap(`await supabase.from('workflow_executions').update({ a: 1 }).eq('id', id);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('does not flag a write against a dynamic table variable it cannot resolve', () => {
    const src = wrap(`await supabase.from(tableName).delete({ count: 'exact' }).in('id', ids);`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('flags an unbounded write made through a detached builder on a partitioned table', () => {
    const src = `
async function a() {
  let query = supabase.from('lead_sightings')
  if (orgId) query = query.eq('organization_id', orgId)
  await query.update({ a: 1 }).eq('id', id)
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })

  it('accepts a detached-builder write bounded by the partition key', () => {
    const src = `
async function a() {
  let query = supabase.from('lead_sightings')
  await query.update({ a: 1 }).eq('id', id).eq('execution_started_at_utc', t)
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('accepts a multi-line chained write bounded by the partition key', () => {
    const src = `
async function a() {
  await supabase
    .from('lead_sighting_bids')
    .update({ is_winner: true })
    .eq('execution_id', e)
    .gte('attempted_at_utc', lb)
    .select('id')
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('is not fooled by a paren inside an eq() argument on the id predicate', () => {
    const src = wrap(`await supabase.from('lead_sightings').update({ a: 1 }).eq('id', String(id));`)
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })

  it('does not flag a Map/KV delete near a supabase read of a partitioned table', () => {
    const src = `
async function a() {
  const { data } = await supabase.from('lead_sightings').select('id').eq('id', id)
  cache.delete(id)
  await env.IDEMPOTENCY.delete(id)
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('honors an opt-out comment above the write', () => {
    const src = `
async function a() {
  // partition-key-ok: single-partition maintenance, whole current month
  await supabase.from('lead_sighting_bids').update({ a: 1 }).eq('id', id)
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toEqual([])
  })

  it('does not let an opt-out comment leak onto an unrelated write far below it', () => {
    const src = `
async function a() {
  // partition-key-ok: this one is fine
  await supabase.from('lead_sightings').update({ a: 1 }).eq('id', id)

  const x = 1
  const y = 2
  const z = 3
  const w = 4
  const v = 5
  await supabase.from('lead_sighting_bids').update({ a: 1 }).eq('id', id)
}`
    expect(findUnboundedPartitionWrites(src, 'x.ts', P)).toHaveLength(1)
  })
})
