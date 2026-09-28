import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * The drill against stand-in pg_dump and psql commands that record every call.
 *
 * Measured 2026-09-28: the temporary login `supabase db dump --dry-run` issues for
 * production is valid for five minutes, and the restore takes about four. The
 * script used to count the source rows again after the restore, so on the first
 * real run every source count failed and the 32 failed logins got the machine's
 * address banned. These tests hold the fix: production is touched only before the
 * restore starts, and a failed source read stops the drill at once.
 */
describe('dr-restore-drill.sh reads production only before the restore', () => {
  const DRILL = path.join(REPO_ROOT, 'scripts/dr-restore-drill.sh')

  function runDrill(opts: { failSourceCountAfter?: number } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dr-drill-'))
    const log = path.join(dir, 'calls.log')
    const tables = readList('DRILL_COPY_TABLES').concat(readList('DRILL_STRUCTURE_ONLY_TABLES'))
    writeFileSync(path.join(dir, 'tables.txt'), tables.join('\n') + '\n')
    // Each stand-in names which database a call reached and what kind it was.
    const who = 'case "$*" in *source.example*) db=source;; *target.example*) db=target;; *) db=unknown;; esac'
    writeFileSync(
      path.join(dir, 'pg_dump'),
      `#!/bin/bash\n${who}\necho "$db dump" >> "${log}"\nout=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && out="$2"; shift; done\n: > "$out"\n`,
      { mode: 0o755 },
    )
    writeFileSync(
      path.join(dir, 'psql'),
      `#!/bin/bash\n${who}\nargs="$*"\n` +
        `if [[ "$args" == *pg_class* ]]; then echo "$db list" >> "${log}"; cat "${dir}/tables.txt"; exit 0; fi\n` +
        `if [[ "$args" == *"count(*)"* ]]; then\n` +
        `  n=$(grep -c "^$db count" "${log}" 2>/dev/null); echo "$db count" >> "${log}"\n` +
        `  if [ "$db" = source ] && [ -n "$FAIL_AFTER" ] && [ "$n" -ge "$FAIL_AFTER" ]; then echo "password authentication failed" >&2; exit 2; fi\n` +
        `  echo 7; exit 0\nfi\n` +
        `echo "$db restore" >> "${log}"; cat > /dev/null\n`,
      { mode: 0o755 },
    )
    let status = 0
    try {
      execFileSync('bash', [DRILL], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          SOURCE_DB_URL: 'postgresql://u:p@source.example:5432/postgres',
          TARGET_DB_URL: 'postgresql://u:p@target.example:5432/postgres',
          FAIL_AFTER: opts.failSourceCountAfter === undefined ? '' : String(opts.failSourceCountAfter),
        },
      })
    } catch (err) {
      status = (err as { status: number }).status
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    rmSync(dir, { recursive: true, force: true })
    return { status, calls }
  }

  it('passes, and makes no source call after the first restore call', () => {
    const { status, calls } = runDrill()
    expect(status).toBe(0)
    const firstRestore = calls.indexOf('target restore')
    expect(firstRestore).toBeGreaterThan(-1)
    // Positive control: the source really was counted, before the restore.
    expect(calls.slice(0, firstRestore).filter((c) => c === 'source count').length).toBe(readList('DRILL_COPY_TABLES').length)
    expect(calls.slice(firstRestore).filter((c) => c.startsWith('source'))).toEqual([])
  })

  it('stops at the first failed source count, before restoring anything', () => {
    const { status, calls } = runDrill({ failSourceCountAfter: 3 })
    expect(status).toBe(6)
    expect(calls.filter((c) => c === 'source count').length).toBe(4)
    expect(calls).not.toContain('target restore')
  })
})
