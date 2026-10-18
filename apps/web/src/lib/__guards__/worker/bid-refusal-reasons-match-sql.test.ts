/**
 * The refusals a bid row names are the refusals the coverage function counts
 * apart (#2391, L370).
 *
 * The Worker records a buyer's own refusal on a code node's bid row by its reason
 * (BID_ROW_REFUSAL_REASONS in apps/worker/src/engine/bid-log.ts), and the too few
 * bids monitor reads bid_recording_coverage_v4, which leaves all of them out of
 * attempt_rows and counts only RECORDED_REFUSAL_REASONS as refusal_rows. Both
 * lists are written twice, in TypeScript and in SQL, so this reads both and fails
 * when they differ: a reason added only to the Worker would count as an ATTEMPT
 * in the monitor, because the function's attempts are every skip_reason it does
 * not name, and a reason counted only in SQL would hide a fault (L367).
 *
 * It also holds the monitor to the newest coverage version, so a v5 that changes
 * the list cannot ship while the monitor still reads v4.
 *
 * Seen red by adding 'debt_below_min' to BID_ROW_REFUSAL_REASONS.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

/** The string literals of `export const NAME = [ ... ]` in a source file. */
function literalList(source: string, name: string): string[] {
  const m = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))
  if (!m) throw new Error(`${name} is not declared as a literal array`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
}

/** The newest migration that creates a bid_recording_coverage version, and that version. */
function newestCoverage(): { file: string; version: number; sql: string } {
  let best: { file: string; version: number; sql: string } | null = null
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    const m = sql.match(/CREATE OR REPLACE FUNCTION public\.bid_recording_coverage_v(\d+)\(/)
    if (m && (!best || Number(m[1]) >= best.version)) best = { file, version: Number(m[1]), sql }
  }
  if (!best) throw new Error('no migration creates a bid_recording_coverage version')
  return best
}

/** Every IN ( ... ) list of string literals in a piece of SQL. */
function inLists(sql: string): string[][] {
  return [...sql.matchAll(/\bIN \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort())
}

describe('bid row refusals match the coverage function (#2391)', () => {
  const bidLog = readFileSync(path.join(WORKER_SRC, 'engine/bid-log.ts'), 'utf8')
  // Written to the row: every one is left out of the attempts.
  const written = literalList(bidLog, 'BID_ROW_REFUSAL_REASONS')
  // Counted as recorded: only these are refusal_rows. missing_lead_field is
  // written but not counted, so a broken loan amount path still pages (L367).
  const counted = literalList(bidLog, 'RECORDED_REFUSAL_REASONS')
  const notAttempts = [...written, 'skipped'].sort()
  const newest = newestCoverage()
  const lists = inLists(newest.sql)

  it('reads a non empty list from each side', () => {
    expect(written.length).toBeGreaterThan(0)
    expect(counted.length).toBeGreaterThan(0)
    expect(lists.length).toBeGreaterThanOrEqual(2)
  })

  it('counts only recorded refusals, a subset of those written', () => {
    for (const r of counted) expect(written).toContain(r)
    expect(lists).toContainEqual(counted)
  })

  it('leaves every written refusal and the plain skip out of the attempts', () => {
    expect(lists).toContainEqual(notAttempts)
  })

  it('names no list in the function other than those two', () => {
    const allowed = [JSON.stringify(counted), JSON.stringify(notAttempts)]
    for (const l of lists) expect(allowed, `${newest.file}: IN (${l.join(', ')})`).toContain(JSON.stringify(l))
  })

  it('is the version the too few bids monitor reads', () => {
    const monitor = readFileSync(path.join(WORKER_SRC, 'lib/bid-recording-coverage.ts'), 'utf8')
    expect(monitor).toContain(`rpc('bid_recording_coverage_v${newest.version}'`)
  })
})
