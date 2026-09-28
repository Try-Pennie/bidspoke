import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, REPO_ROOT } from './_scan-utils'

/**
 * Every table the migrations create must be classified for the restore drill.
 *
 * The drill (scripts/dr-restore-drill.sh, docs/dr-restore-drill.md) copies the
 * DATA of an explicit allow-list of tables and restores only the structure of the
 * rest. Its verification then compares row counts for the allow-list, and only
 * the allow-list. So a system-of-record table added after the list was written is
 * restored EMPTY while the drill prints PASS, and the runbook's claim that the
 * verification "will flag a missing table" was never true.
 *
 * That is not hypothetical. The list was written on 2026-06-26 and by 2026-09-28
 * buyer profiles had added buyer_profiles, buyer_pricing_tiers,
 * buyer_operating_windows, buyer_blackout_dates and buyer_sales, all of which
 * the engine needs to price and cap a buyer, and none of which the quarterly
 * drill would have restored.
 *
 * So the lists live in scripts/dr-drill-tables.sh, and this test derives the
 * population from the migrations (L41: a list that must mirror a source of truth
 * is checked against it, never maintained by hand beside it). Every created table
 * must be in exactly one of the two lists, and every listed table must exist. The
 * drill repeats the check against the live database before it dumps anything,
 * which catches a table created outside the migrations.
 */
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')
const TABLES_FILE = path.join(REPO_ROOT, 'scripts/dr-drill-tables.sh')

/**
 * Table names created by a `CREATE TABLE name (` statement.
 *
 * Requiring the opening parenthesis straight after the name excludes partition
 * children (`CREATE TABLE x_2026_09 PARTITION OF x`), which are covered by their
 * parent, and the `format('CREATE TABLE %I ...')` strings that roll partitions.
 */
function tablesCreatedByMigrations(): Set<string> {
  const created = new Set<string>()
  const pattern =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  for (const file of listFiles(MIGRATIONS, { exts: ['.sql'] })) {
    const sql = readFileSync(file, 'utf8')
    for (const match of sql.matchAll(pattern)) created.add(match[1].toLowerCase())
  }
  return created
}

function readList(name: 'DRILL_COPY_TABLES' | 'DRILL_STRUCTURE_ONLY_TABLES'): string[] {
  const out = execFileSync(
    'bash',
    ['-c', `set -euo pipefail; source "$1"; printf '%s\\n' "\${${name}[@]}"`, 'bash', TABLES_FILE],
    { encoding: 'utf8' },
  )
  return out.split('\n').filter(Boolean)
}

/** Runs the drill's live-database check with the given table names on stdin. */
function unclassified(tableNames: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(
      'bash',
      ['-c', 'set -euo pipefail; source "$1"; dr_unclassified_tables', 'bash', TABLES_FILE],
      { encoding: 'utf8', input: tableNames.join('\n') + '\n' },
    )
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { status: number; stdout: string }
    return { status: e.status, stdout: e.stdout }
  }
}

describe('restore drill table classification', () => {
  const copy = readList('DRILL_COPY_TABLES')
  const structureOnly = readList('DRILL_STRUCTURE_ONLY_TABLES')
  const created = tablesCreatedByMigrations()

  it('finds the tables the migrations create', () => {
    // Positive control for the parser (L1): if the pattern stopped matching,
    // every assertion below would pass over an empty set.
    expect(created.has('workflows')).toBe(true)
    expect(created.has('buyer_profiles')).toBe(true)
    expect(created.has('execution_steps')).toBe(true)
    expect([...created].some((t) => /_20\d\d_\d\d$/.test(t))).toBe(false)
  })

  it('classifies every table a migration creates', () => {
    const classified = new Set([...copy, ...structureOnly])
    const missing = [...created].filter((t) => !classified.has(t)).sort()
    expect(missing, 'add each to DRILL_COPY_TABLES or DRILL_STRUCTURE_ONLY_TABLES in scripts/dr-drill-tables.sh').toEqual([])
  })

  it('lists no table that the migrations do not create', () => {
    const stale = [...copy, ...structureOnly].filter((t) => !created.has(t)).sort()
    expect(stale).toEqual([])
  })

  it('puts no table in both lists', () => {
    expect(copy.filter((t) => structureOnly.includes(t))).toEqual([])
  })

  it('copies the buyer profile configuration the engine prices from', () => {
    for (const t of ['buyer_profiles', 'buyer_pricing_tiers', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_sales']) {
      expect(copy).toContain(t)
    }
  })

  it('never copies the raw personal data tables', () => {
    for (const t of ['persons', 'lead_sightings', 'lead_sighting_bids']) {
      expect(structureOnly).toContain(t)
      expect(copy).not.toContain(t)
    }
  })
})

describe('dr_unclassified_tables (the drill refuses on an unlisted live table)', () => {
  it('passes when every live table is classified, partitions included', () => {
    const r = unclassified(['workflows', 'persons', 'execution_steps_2026_09', 'lead_sightings_2026_10'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('names each unlisted table and exits non-zero', () => {
    const r = unclassified(['workflows', 'brand_new_config', 'another_one'])
    expect(r.status).toBe(1)
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['brand_new_config', 'another_one'])
  })

  it('does not treat a dated suffix on an unlisted table as a partition of it', () => {
    const r = unclassified(['brand_new_2026_09'])
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe('brand_new_2026_09')
  })
})
