/**
 * The tables a fresh database holds after the migrations in supabase/migrations
 * are replayed in order, derived from the migrations themselves.
 *
 * Shared by every guard that must hold a hand kept table list to the migrations
 * (the pagination guard's size declarations, #962, and the restore drill's
 * table lists), so each reads the same population: a table a later migration
 * drops or renames is gone for all of them, not only for whichever guard
 * happened to learn about drops (#2638 was the first migration to drop a whole
 * table, and the drill's own parser had never been taught to forget one).
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

// Reduce a migration to the SQL that RUNS: comments and single quoted strings
// become spaces, so prose about a table ("CREATE TABLE execution_steps" in a
// comment) and dynamic DDL built inside a string (`format('CREATE TABLE %I
// PARTITION OF ...')`, the monthly and daily partition makers) are never read as
// a table being created. Dollar quoted bodies stay, because a DO block or a
// function can create a table directly and that table is real. One pass, so a
// `--` inside a string is not taken for a comment and an apostrophe inside a
// comment does not open a string.
export function sqlCodeOnly(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      out += sql.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      out += sql.slice(i, j).replace(/[^\n]/g, ' ')
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

// A table name as the guard keys it: unquoted, lower case, and without the
// default `public.` schema (the worker reads those as `.from('name')`, which is
// how BIG_TABLES spells them). Any other schema keeps its prefix, so
// porting.pipedream_inventory cannot be confused with a public table.
export function tableKey(raw: string): string {
  const name = raw.replace(/"/g, '').toLowerCase()
  return name.startsWith('public.') ? name.slice('public.'.length) : name
}

const NAME = String.raw`(?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?`

/**
 * The tables a fresh database holds after every migration in `files` is applied
 * in order: each CREATE TABLE adds its table, a DROP TABLE or a RENAME removes
 * or renames it. Partitions are left out (a `PARTITION OF` child, or a table a
 * later ATTACH PARTITION makes one): each is covered by its parent, which the
 * pagination guard's partition completeness test holds to BIG_TABLES and the
 * restore drill classifies. Temporary tables are left out because they do not
 * outlive the session that made them.
 */
export function tablesCreatedBy(files: Array<{ name: string; sql: string }>): Map<string, string> {
  const live = new Map<string, string>() // table key -> the migration that created it
  for (const { name, sql } of files) {
    const code = sqlCodeOnly(sql)
    const stmt = new RegExp(
      String.raw`\bCREATE\s+((?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})` +
        String.raw`|\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${NAME}(?:\s*,\s*${NAME})*)` +
        String.raw`|\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})\s+RENAME\s+TO\s+(${NAME})` +
        String.raw`|\bATTACH\s+PARTITION\s+(${NAME})`,
      'gi',
    )
    let m: RegExpExecArray | null
    while ((m = stmt.exec(code)) !== null) {
      if (m[2] !== undefined) {
        if (m[1] !== undefined && /TEMP/i.test(m[1])) continue
        if (/^\s*PARTITION\s+OF\b/i.test(code.slice(stmt.lastIndex))) continue
        live.set(tableKey(m[2]), name)
      } else if (m[3] !== undefined) {
        for (const t of m[3].split(',')) live.delete(tableKey(t.trim()))
      } else if (m[4] !== undefined && m[5] !== undefined) {
        const from = tableKey(m[4])
        const created = live.get(from)
        if (created === undefined) continue
        live.delete(from)
        // RENAME TO takes a bare name; the table stays in its own schema.
        const schema = from.includes('.') ? from.slice(0, from.lastIndexOf('.') + 1) : ''
        live.set(schema + tableKey(m[5]).split('.').pop(), created)
      } else if (m[6] !== undefined) {
        live.delete(tableKey(m[6]))
      }
    }
  }
  return live
}

export function migrationFiles(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }))
}
