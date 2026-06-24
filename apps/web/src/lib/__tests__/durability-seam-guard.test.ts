/**
 * #309 Phase 3 — durability-tier guard.
 *
 * Tier-2 outcome writes (lead_sightings, lead_sighting_bids, the planned
 * opportunities table) MUST route through the durability seam (writeOutcome /
 * runOutcome) so a loss after retries dead-letters instead of vanishing into a
 * log line. This scans the worker ENGINE code and fails if any file other than
 * the seam-routed lead-sightings.ts writes an outcome table directly, i.e.
 * `from(<table>)` chained with `.insert/.update/.upsert/.delete`.
 *
 * Scope is engine/ ONLY, by design. The known non-engine direct writers —
 * apps/worker/src/lib/sightings-export.ts (nightly batch sweep) and
 * apps/worker/src/routes/api/admin.ts (one-time backfill) — are batch/admin, not
 * per-lead, and are intentionally OUT of scope (documented here so a reviewer
 * sees they were considered, not missed).
 *
 * It scans the `from(<table>)…write` SITE, not imports of a write function, so it
 * does NOT false-positive on nodes/partner-bid.ts, which imports and calls
 * recordBidAttempt but performs no direct outcome-table write.
 *
 * (Lives under apps/web because the worker tsconfig has no @types/node, so a
 * worker test can't read source files; the sibling big-table pagination guard
 * scans apps/worker/src from here the same way.)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../..')
const ENGINE_DIR = path.join(REPO_ROOT, 'apps/worker/src/engine')

// Tier-2 must-not-lose tables. `opportunities` is listed now so the guard already
// covers it when the 4.5a win-tracking table is built.
const OUTCOME_TABLES = ['lead_sightings', 'lead_sighting_bids', 'opportunities']
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

// Engine files allowed to write outcome tables directly: the seam-routed
// functions in lead-sightings.ts (they ARE the seam's tier-2 callers).
const SEAM_ALLOWLIST = new Set(['lead-sightings.ts'])

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

// Consume a balanced (...) starting at src[open] === '('. Returns the index just
// past the closing paren; skips string/template contents.
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

// Walk the .method(...) chain starting at `from` (index just past .from(...)).
function walkChain(src: string, from: number): string[] {
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
    methods.push(name)
    i = consumeParens(src, j)
  }
  return methods
}

interface Finding { file: string; line: number; table: string }

export function scanSource(src: string, relFile: string): Finding[] {
  const findings: Finding[] = []
  const re = new RegExp(`\\.from\\(\\s*['"](${OUTCOME_TABLES.join('|')})['"]\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const methods = walkChain(src, m.index + m[0].length)
    if (methods.some((x) => WRITE_METHODS.has(x))) {
      findings.push({ file: relFile, line: src.slice(0, m.index).split('\n').length, table: m[1] })
    }
  }
  return findings
}

function scanFile(file: string): Finding[] {
  return scanSource(readFileSync(file, 'utf8'), path.relative(ENGINE_DIR, file))
}

describe('scanSource — detects direct outcome-table writes (#309)', () => {
  it('flags a direct insert', () => {
    expect(scanSource("await supabase.from('lead_sightings').insert(row)", 'x.ts')).toHaveLength(1)
  })
  it('flags a chained update', () => {
    expect(scanSource("supabase.from('lead_sighting_bids').update(u).eq('a', 1)", 'x.ts').map((f) => f.table)).toEqual(['lead_sighting_bids'])
  })
  it('flags the future opportunities table', () => {
    expect(scanSource("supabase.from('opportunities').upsert(o)", 'x.ts')).toHaveLength(1)
  })
  it('does not flag a read (select)', () => {
    expect(scanSource("supabase.from('lead_sightings').select('*').eq('id', x)", 'x.ts')).toEqual([])
  })
  it('does not flag a write to a non-outcome table', () => {
    expect(scanSource("supabase.from('workflow_executions').insert(row)", 'x.ts')).toEqual([])
  })
  it('does not flag importing/calling a write function (no direct from)', () => {
    expect(scanSource("ctx.pendingBidWrites.push(recordBidAttempt(supabase, bid, deps))", 'x.ts')).toEqual([])
  })
})

describe('engine outcome writes route through the durability seam (#309)', () => {
  it('no engine file outside the seam writes an outcome table directly', () => {
    const offenders = listTsFiles(ENGINE_DIR)
      .flatMap(scanFile)
      .filter((f) => !SEAM_ALLOWLIST.has(f.file))
    expect(offenders).toEqual([])
  })
})
