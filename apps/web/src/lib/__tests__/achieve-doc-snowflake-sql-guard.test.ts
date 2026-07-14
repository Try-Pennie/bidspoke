/**
 * Guard the Achieve doc's example queries against the Snowflake table they run on (#648).
 *
 * The analysis queries in docs/achieve-fdr-node.md are the only way anyone reads the
 * Achieve results, and they run against SNOWFLAKE, not Supabase: the nightly export is
 * what moves the rows, and it ships a strict subset of the columns. The first version of
 * those queries was written in Postgres (`jsonb_array_elements`, `->>`) and filtered on
 * `is_test` / `is_sandbox`, neither of which the export ships. Every one of them errored
 * on an unknown column or an unknown function. Nothing caught it, because a doc is not
 * compiled and nobody runs a markdown code fence.
 *
 * Two rules, both derived from source so they cannot drift from it:
 *
 *   1. The queries may only reference columns the export actually creates. The legal set
 *      is read out of ACHIEVE_COLS (lib/achieve-export.ts); the illegal set is every other
 *      column on the Supabase table, read out of the migrations. `is_test`/`is_sandbox` are
 *      the trap: they exist in Supabase, they read as sensible filters, and they are exactly
 *      what the export strips (it only ever exports rows where both are false, which is why
 *      the columns are redundant as well as absent).
 *   2. The queries must be Snowflake dialect. Postgres JSON operators (`->`, `->>`) and
 *      `jsonb_*` functions are hard errors there; the Snowflake spellings are `:` paths,
 *      `::` casts and LATERAL FLATTEN.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles } from './_scan-utils'

const DOC = path.join(REPO_ROOT, 'docs/achieve-fdr-node.md')
const EXPORTER = path.join(WORKER_SRC, 'lib/achieve-export.ts')
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

/** Column names the nightly export creates in Snowflake, read from ACHIEVE_COLS. */
function exportedColumns(): Set<string> {
  const src = readFileSync(EXPORTER, 'utf8')
  const block = /export const ACHIEVE_COLS[^=]*=\s*\[([\s\S]*?)\]/.exec(src)
  if (!block) throw new Error('ACHIEVE_COLS not found in achieve-export.ts')
  const names = [...block[1].matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1])
  if (names.length === 0) throw new Error('ACHIEVE_COLS parsed to zero columns')
  return new Set(names)
}

/** Every column on the Supabase achieve_evaluations table, read from the migrations. */
function supabaseColumns(): Set<string> {
  const cols = new Set<string>()
  for (const file of listFiles(MIGRATIONS, { exts: ['.sql'] })) {
    const sql = readFileSync(file, 'utf8')
    const create = /CREATE TABLE (?:IF NOT EXISTS )?achieve_evaluations\s*\(([\s\S]*?)\)\s*PARTITION BY/i.exec(sql)
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = /^\s*([a-z_]+)\s+(?:UUID|VARCHAR|INTEGER|JSONB|BOOLEAN|TIMESTAMP)/i.exec(line)
        if (m) cols.add(m[1])
      }
    }
    for (const m of sql.matchAll(
      /ALTER TABLE achieve_evaluations\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_]+)/gi
    )) {
      cols.add(m[1])
    }
  }
  if (cols.size === 0) throw new Error('parsed zero columns from the achieve_evaluations migrations')
  return cols
}

/** The ```sql fenced blocks in the doc. */
function sqlBlocks(): string[] {
  const doc = readFileSync(DOC, 'utf8')
  return [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
}

describe('Achieve doc example queries', () => {
  it('has SQL examples to police', () => {
    // Cheap anti-vacuity check: if the fences are ever renamed, the rules below would
    // pass against an empty array and silently stop guarding anything.
    expect(sqlBlocks().length).toBeGreaterThan(0)
  })

  it('only references columns the Snowflake export actually creates', () => {
    const exported = exportedColumns()
    const notExported = [...supabaseColumns()].filter((c) => !exported.has(c))
    expect(notExported).toContain('is_test')
    expect(notExported).toContain('is_sandbox')

    const offenders: string[] = []
    for (const block of sqlBlocks()) {
      for (const col of notExported) {
        if (new RegExp(`\\b${col}\\b`).test(block)) offenders.push(col)
      }
    }
    expect(
      offenders,
      `docs/achieve-fdr-node.md queries Snowflake columns that do not exist there: ${offenders.join(', ')}. ` +
        `The export (ACHIEVE_COLS) ships only: ${[...exported].join(', ')}.`
    ).toEqual([])
  })

  it('is written in Snowflake dialect, not Postgres', () => {
    const postgresOnly = [
      { pattern: /->>?/, name: 'Postgres JSON operator (-> / ->>), use a Snowflake `:` path' },
      { pattern: /\bjsonb_\w+/, name: 'jsonb_* function, use LATERAL FLATTEN' },
    ]
    const offenders: string[] = []
    for (const block of sqlBlocks()) {
      for (const { pattern, name } of postgresOnly) {
        if (pattern.test(block)) offenders.push(name)
      }
    }
    expect(offenders, `docs/achieve-fdr-node.md uses Postgres syntax that errors on Snowflake`).toEqual([])
  })
})
