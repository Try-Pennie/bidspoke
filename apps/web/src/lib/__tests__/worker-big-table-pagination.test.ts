/**
 * Guard against the recurring "unpaginated big-table read" bug (#115).
 *
 * PostgREST caps a list response at 1,000 rows; a bare `.select()` of a large or
 * partitioned table silently truncates past the cap (and shuffles rows without a
 * stable order). This has been found and fixed one site at a time (volume-cliff,
 * bid-matrix sync/lookup, sf-matrix-audit, slow-execution-rate). This test scans
 * the worker's scheduled/engine code (src/lib + src/engine — not the
 * request-scoped API routes) and fails if a read of a known big table isn't
 * bounded by .single()/.maybeSingle()/.range()/.limit()/a count, or routed
 * through fetchAllPaged.
 *
 * A read that is genuinely bounded some other way (e.g. filtered to a single
 * execution's handful of rows) can opt out with a `// paginate-ok: <reason>`
 * comment in the same statement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const WORKER_SRC = path.resolve(dir, '../../../../..', 'apps/worker/src')
const SCAN_DIRS = ['lib', 'engine'].map((d) => path.join(WORKER_SRC, d))

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
]

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const BOUND_METHODS = new Set(['single', 'maybeSingle', 'range', 'limit'])

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

// Consume a balanced (...) starting at src[open] === '('. Returns index just
// past the closing paren. Skips string/template contents so their parens don't
// count.
function consumeParens(src: string, open: number): number {
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === "'" || c === '"' || c === '`') {
      k++
      while (k < src.length && src[k] !== c) { if (src[k] === '\\') k++; k++ }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return k + 1 }
  }
  return src.length
}

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

interface Finding { file: string; line: number; table: string; methods: string[] }

function scanFile(file: string): Finding[] {
  const src = readFileSync(file, 'utf8')
  const findings: Finding[] = []
  for (const table of BIG_TABLES) {
    const needle = new RegExp(`\\.from\\((['"\`])${table}\\1\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = needle.exec(src)) !== null) {
      const afterFrom = m.index + m[0].length
      const { methods, end } = walkChain(src, afterFrom)
      // Writes aren't list reads.
      if (methods.some((x) => WRITE_METHODS.has(x))) continue
      // Only `.select()` produces a row list to truncate.
      if (!methods.includes('select')) continue
      // Bounded by a row-count limiter?
      if (methods.some((x) => BOUND_METHODS.has(x))) continue
      // Count/head queries return a number, not rows.
      const chainText = src.slice(m.index, end)
      if (/\bcount\s*:/.test(chainText) || /\bhead\s*:\s*true/.test(chainText)) continue
      // Explicit opt-out for a read bounded another way (small filtered set).
      // Recognize a `// paginate-ok` anywhere on the statement: walk up from the
      // .from() line past chain-continuation (`.`) lines to the statement head,
      // then include the contiguous leading // comments, through the chain end.
      const allLines = src.split('\n')
      const fromLineIdx = src.slice(0, m.index).split('\n').length - 1
      const endLineIdx = src.slice(0, end).split('\n').length - 1
      let li = fromLineIdx
      while (li > 0 && allLines[li].trim().startsWith('.')) li--
      while (li > 0 && allLines[li - 1].trim().startsWith('//')) li--
      const stmtText = allLines.slice(li, endLineIdx + 1).join('\n')
      if (/paginate-ok/.test(stmtText)) continue

      findings.push({
        file: path.relative(WORKER_SRC, file),
        line: src.slice(0, m.index).split('\n').length,
        table,
        methods,
      })
    }
  }
  return findings
}

describe('worker big-table reads are paginated (#115)', () => {
  it('every list read of a large/partitioned table in scheduled/engine code is bounded or paged', () => {
    const findings = SCAN_DIRS.flatMap((d) => listTsFiles(d)).flatMap(scanFile)
    const report = findings
      .map((f) => `  ${f.file}:${f.line} — .from('${f.table}').${f.methods.join('.')}() has no .range()/.limit()/.single() and no // paginate-ok`)
      .join('\n')
    expect(findings, `Unpaginated big-table read(s):\n${report}\n\nUse fetchAllPaged (src/lib/paginate.ts) or add a // paginate-ok comment if the read is bounded another way.`).toEqual([])
  })
})
