/**
 * Guard against the recurring "unpaginated big-table read" bug (#115).
 *
 * PostgREST caps a list response at 1,000 rows; a bare `.select()` of a large or
 * partitioned table silently truncates past the cap (and shuffles rows without a
 * stable order). This has been found and fixed one site at a time (volume-cliff,
 * bid-matrix sync/lookup, sf-matrix-audit, slow-execution-rate). This test scans
 * the worker's scheduled/engine code (src/lib + src/engine) AND the request-scoped
 * API routes (src/routes — #185) and fails if a read of a known big table isn't
 * bounded by .single()/.maybeSingle()/.range()/.limit()/a count, or routed
 * through fetchAllPaged.
 *
 * A read that is genuinely bounded some other way (e.g. filtered to a single
 * execution's handful of rows) can opt out with a `// paginate-ok: <reason>`
 * comment in the same statement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listTsFiles, consumeParens } from '../../__tests__/_scan-utils'

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')
// Scheduled/engine code plus the request-scoped API routes (#185). Routes are
// mostly bounded by design (keyset cursors, .single(), .limit()), but a new
// unbounded list read there (e.g. an admin export) would truncate the same way.
const SCAN_DIRS = ['lib', 'engine', 'routes'].map((d) => path.join(WORKER_SRC, d))

// Tables that are partitioned or known to exceed the 1,000-row PostgREST cap.
const BIG_TABLES = [
  'execution_steps',
  'workflow_executions',
  'lead_sightings',
  'lead_sighting_bids',
  'bid_matrix_rows',
  'sf_bid_matrix_audit',
  'persons',
  'achieve_evaluations',
  'audit_log',
  'field_presence_daily',
  'workflow_stats_daily',
  // ~105,000 rows/day, ~3.2M at steady state, by its own migration's stated
  // volume (20260820000001). Not partitioned on purpose, so the completeness
  // test above cannot reach it; the daily runtime guard flagged it instead.
  'execution_archive_ids',
  // The archive's per-hour ledger: 24 rows a day, never pruned, so it crosses
  // the cap within weeks of being created. Its reads are bounded by a date
  // window or by one day's 24 hours, which this scan cannot see, so each one
  // carries a paginate-ok saying so (#1191).
  'execution_archive_hours',
  // The archive lock and liveness ledger: one row per run of every job that takes
  // it, about 1,166 rows by 2026-09-22 and never pruned. The daily growth check
  // flagged it (#1438).
  'job_runs',
  // One row per buyer sale, about 825 in the first day of Stage A and never
  // pruned. The daily growth check flagged it on 2026-09-24. Its one bounded
  // by batch read is the drain looking up earlier copies, 200 ids at a time.
  'buyer_sales',
  // Every saved version of every workflow, never pruned: 548 rows on 2026-09-30,
  // when the daily growth check flagged it. Its two list reads (the history
  // panel and Duplicate) are per workflow, 168 at most that day, and page anyway.
  'workflow_versions',
]

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const BOUND_METHODS = new Set(['single', 'maybeSingle', 'range', 'limit'])
// `<recv>.from(<identifier>)` where recv is one of these is a JS built-in
// (Array.from, Uint8Array.from, ...), not a Supabase table read.
const BUILTIN_FROM_RECEIVERS = new Set([
  'Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'Buffer', 'Object', 'String', 'Number',
])

// Walk the .method(...) chain starting at `from` (the index just past .from(...)).
// Returns the method names and the index where the chain ends.
function walkChain(src: string, from: number): { methods: string[]; end: number } {
  const methods: string[] = []
  let i = from
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (src[i] !== '.') break
    let j = i + 1
    let name = ''
    while (j < src.length && /\w/.test(src[j])) { name += src[j]; j++ }
    if (src[j] !== '(') break
    const end = consumeParens(src, j)
    methods.push(name)
    i = end
  }
  return { methods, end: i }
}

// 'unbounded' = no row-count limiter at all, so the read silently truncates at
// the 1,000-row cap. 'unordered' = it pages with .range() but declares no
// ORDER BY, so Postgres recomputes each OFFSET against an independent scan and
// the pages skip and duplicate rows. The second is the quieter of the two: the
// read returns a plausible number of rows, just not the right ones.
type FindingKind = 'unbounded' | 'unordered'
interface Finding { file: string; line: number; table: string; methods: string[]; kind: FindingKind }

function scanSource(src: string, relPath: string): Finding[] {
  const findings: Finding[] = []

  // Classify a single `<recv>.from(...)` occurrence. `start` is the index of the
  // occurrence, `afterFromCall` is the index just past its closing `)`.
  const classify = (start: number, afterFromCall: number, table: string): void => {
    const { methods, end } = walkChain(src, afterFromCall)
    // Writes aren't list reads.
    if (methods.some((x) => WRITE_METHODS.has(x))) return
    // Only `.select()` produces a row list to truncate.
    if (!methods.includes('select')) return
    const bounded = methods.some((x) => BOUND_METHODS.has(x))
    // A .range() read pages, and paging without a stable ORDER BY tears. This is
    // NOT covered by the boundedness check: .range() satisfies that check while
    // still returning the wrong rows, which is how the field-presence detector's
    // reader shipped torn past this very guard (AUD-039, #432). A .limit() or
    // .single() read takes one page and needs no ordering to be complete.
    const kind: FindingKind | null = !bounded
      ? 'unbounded'
      : methods.includes('range') && !methods.includes('order')
        ? 'unordered'
        : null
    if (kind === null) return
    // Count/head queries return a number, not rows.
    const chainText = src.slice(start, end)
    if (/\bcount\s*:/.test(chainText) || /\bhead\s*:\s*true/.test(chainText)) return
    // Explicit opt-out for a read bounded another way (small filtered set).
    // Recognize a `// paginate-ok` anywhere on the statement: walk up from the
    // .from() line past chain-continuation (`.`) lines to the statement head,
    // then include the contiguous leading // comments, through the chain end.
    const allLines = src.split('\n')
    const fromLineIdx = src.slice(0, start).split('\n').length - 1
    const endLineIdx = src.slice(0, end).split('\n').length - 1
    let li = fromLineIdx
    while (li > 0 && allLines[li].trim().startsWith('.')) li--
    while (li > 0 && allLines[li - 1].trim().startsWith('//')) li--
    const stmtText = allLines.slice(li, endLineIdx + 1).join('\n')
    if (/paginate-ok/.test(stmtText)) return

    findings.push({ file: relPath, line: fromLineIdx + 1, table, methods, kind })
  }

  // 1. Reads of a known big table named by a string literal.
  for (const table of BIG_TABLES) {
    const needle = new RegExp(`\\.from\\((['"\`])${table}\\1\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = needle.exec(src)) !== null) {
      classify(m.index, m.index + m[0].length, table)
    }
  }

  // 2. Reads where the table name is a VARIABLE (e.g. an export job looping over
  //    tables): `supabase.from(tableName)`. We can't know the table, so we hold
  //    these to the same bar — they must be bounded or marked. Excludes JS
  //    built-ins like Array.from(...)/Uint8Array.from(...).
  const dyn = /(\w+)\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/g
  let d: RegExpExecArray | null
  while ((d = dyn.exec(src)) !== null) {
    if (BUILTIN_FROM_RECEIVERS.has(d[1])) continue
    classify(d.index, d.index + d[0].length, `<${d[2]}>`)
  }

  return findings
}

function scanFile(file: string): Finding[] {
  return scanSource(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file))
}

// Extract the names of partitioned parent tables declared in a migration:
//   CREATE TABLE [IF NOT EXISTS] <name> ( ...columns... ) PARTITION BY ...
// We balance-match the column-list parens, then check whether PARTITION BY
// immediately follows. Dynamic child-partition creation inside string literals
// (`CREATE TABLE IF NOT EXISTS %I PARTITION OF ...`) is naturally excluded: its
// name (`%I`, `foo_%s`) isn't followed by a column-list `(`.
function partitionedTablesIn(sql: string): string[] {
  const out: string[] = []
  const head = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w.]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = head.exec(sql)) !== null) {
    const open = head.lastIndex - 1 // index of the '('
    const afterCols = consumeParens(sql, open)
    if (/^\s*PARTITION BY\b/i.test(sql.slice(afterCols))) {
      // Strip any schema qualifier (public.foo -> foo) to match BIG_TABLES.
      out.push(m[1].split('.').pop() as string)
    }
  }
  return out
}

describe('big-table pagination guard list is complete', () => {
  it('every partitioned table in supabase/migrations is covered by BIG_TABLES', () => {
    const partitioned = new Set<string>()
    for (const entry of readdirSync(MIGRATIONS_DIR)) {
      if (!entry.endsWith('.sql')) continue
      const sql = readFileSync(path.join(MIGRATIONS_DIR, entry), 'utf8')
      for (const t of partitionedTablesIn(sql)) partitioned.add(t)
    }
    const known = new Set(BIG_TABLES)
    const missing = [...partitioned].filter((t) => !known.has(t)).sort()
    expect(
      missing,
      `Partitioned table(s) not in BIG_TABLES:\n${missing.map((t) => `  ${t}`).join('\n')}\n\n` +
        `A new month/range-partitioned table will exceed the 1,000-row PostgREST cap. ` +
        `Add it to BIG_TABLES in this file so unbounded reads of it are caught.`,
    ).toEqual([])
  })
})

describe('runtime big-table guard mirrors BIG_TABLES (#222)', () => {
  it('KNOWN_BIG_TABLES in the worker guard matches BIG_TABLES here', () => {
    // The daily runtime check (apps/worker/src/lib/big-table-guard.ts) excludes
    // already-handled tables by this exact list. If it drifts from BIG_TABLES, the
    // check either false-alerts on a handled table (a known big table not in the
    // worker's set) or misses a real grower — exactly the drift that let it
    // false-alert on sf_bid_matrix_audit. Mirror them verbatim.
    const src = readFileSync(path.join(WORKER_SRC, 'lib/big-table-guard.ts'), 'utf8')
    const m = src.match(/KNOWN_BIG_TABLES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
    expect(m, 'KNOWN_BIG_TABLES = new Set([...]) not found in big-table-guard.ts').not.toBeNull()
    const workerSet = new Set([...m![1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]))
    const here = new Set(BIG_TABLES)
    const missing = [...here].filter((t) => !workerSet.has(t)).sort()
    const extra = [...workerSet].filter((t) => !here.has(t)).sort()
    expect(
      { missing, extra },
      `KNOWN_BIG_TABLES (worker) must mirror BIG_TABLES (here).\n` +
        `missing from worker: ${missing.join(', ') || '(none)'}\n` +
        `extra in worker: ${extra.join(', ') || '(none)'}`,
    ).toEqual({ missing: [], extra: [] })
  })
})

describe('each BIG_TABLES entry is load-bearing', () => {
  // Every other test here can pass while the list is wrong: the completeness
  // test only covers PARTITIONED tables, the mirror test only compares the two
  // lists to each other, and the scan below reports nothing for a table it was
  // never told about. So none of them can fail when an entry is MISSING, which
  // is how execution_archive_ids (~105,000 rows/day by its own migration's
  // stated volume) sat outside the guard until a runtime alert found it.
  //
  // This drives the scanner against a deliberate unbounded read of each listed
  // table and requires it to be reported. It fails if an entry is dropped, and
  // it fails if a scanner change stops matching the shape it exists to catch.
  it.each(BIG_TABLES)('an unbounded read of %s is reported', (table) => {
    const findings = scanSource(
      `const { data } = await supabase.from('${table}').select('*')\n`,
      'fixture.ts',
    )
    expect(findings.map((f) => f.table)).toContain(table)
  })

  it('an unbounded read of execution_archive_ids is reported (#871)', () => {
    // Named separately from the it.each above because the it.each can only
    // check entries the list ALREADY has, and this table's absence is the
    // defect: the archive writes one row per archived execution, which its own
    // migration (20260820000001) states as ~105,000 rows/day and ~3.2M at
    // steady state, so it is far past the 1,000-row cap. It is not partitioned
    // (deliberately, see that migration), so the completeness test above cannot
    // find it either. Today the worker only WRITES to it; this fails the moment
    // the deletion gate's orphan count (#872) reads it without a bound.
    const findings = scanSource(
      "const { data } = await supabase.from('execution_archive_ids').select('execution_id')\n",
      'fixture.ts',
    )
    expect(
      findings.map((f) => f.table),
      'execution_archive_ids must be in BIG_TABLES so an unbounded read of it is caught',
    ).toContain('execution_archive_ids')
  })

  it('a .range() read with no .order() is reported as unordered', () => {
    // The defect AUD-039 shipped: bounded, so the boundedness check passed, but
    // paging with no stable order, so the pages skip and duplicate rows.
    for (const table of BIG_TABLES) {
      const findings = scanSource(
        `const { data } = await supabase.from('${table}').select('*').range(0, 999)\n`,
        'fixture.ts',
      )
      expect(findings.map((f) => f.kind), `unordered paged read of ${table} should be reported`).toContain('unordered')
    }
  })

  it('a .range() read WITH .order() is not reported', () => {
    // The positive case above is satisfied by a checker that reports every
    // .range(), so prove the same fixture goes quiet once it declares an order.
    for (const table of BIG_TABLES) {
      const findings = scanSource(
        `const { data } = await supabase.from('${table}').select('*').order('id').range(0, 999)\n`,
        'fixture.ts',
      )
      expect(findings, `ordered paged read of ${table} should not be reported`).toEqual([])
    }
  })

  it('a .limit() read needs no .order()', () => {
    // Ordering is required for PAGING, not for boundedness: a single-page read
    // is complete whatever order it comes back in, so requiring .order() there
    // would be noise that teaches people to add a meaningless sort.
    for (const table of BIG_TABLES) {
      const findings = scanSource(
        `const { data } = await supabase.from('${table}').select('*').limit(100)\n`,
        'fixture.ts',
      )
      expect(findings, `limited read of ${table} should not be reported`).toEqual([])
    }
  })

  it('a bounded read of the same table is not reported', () => {
    // The positive case above is satisfied by a scanner that reports
    // EVERYTHING, so prove the same fixture goes quiet once it is bounded.
    for (const table of BIG_TABLES) {
      const findings = scanSource(
        `const { data } = await supabase.from('${table}').select('*').limit(100)\n`,
        'fixture.ts',
      )
      expect(findings, `bounded read of ${table} should not be reported`).toEqual([])
    }
  })
})

describe('worker big-table reads are paginated (#115, #185)', () => {
  it('every list read of a large/partitioned table in scheduled/engine code and API routes is bounded or paged', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d)).flatMap(scanFile)
    const report = findings
      .map((f) =>
        f.kind === 'unbounded'
          ? `  ${f.file}:${f.line} .from('${f.table}').${f.methods.join('.')}(): no .range()/.limit()/.single() and no // paginate-ok`
          : `  ${f.file}:${f.line} .from('${f.table}').${f.methods.join('.')}(): pages with .range() but declares no .order(), so its pages skip and duplicate rows`,
      )
      .join('\n')
    expect(findings, `Unsafe big-table read(s):\n${report}\n\nUse fetchAllPaged (src/lib/paginate.ts) with a stable .order(), or add a // paginate-ok comment if the read is bounded another way.`).toEqual([])
  })
})
