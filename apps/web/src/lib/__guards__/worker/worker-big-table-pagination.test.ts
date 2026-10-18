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
 *
 * The scan only protects tables BIG_TABLES names, so the list has to be complete.
 * Every table any migration creates must therefore be declared: in BIG_TABLES,
 * or in SMALL_TABLES with its row count and why it stays small (#962). The
 * declaration lives in this file, not as a marker comment in the migration, for
 * three reasons. Applied migrations are never edited, so a marker could not be
 * added to the 38 tables that predate this rule, and the list would start with
 * every old table exempt. A marker is free text the parser has to pair with the
 * right CREATE TABLE, and one paired with the wrong table exempts a table nobody
 * declared; a map key is exact, and the test checks it both ways (a table with
 * no entry fails, and an entry naming no live table fails). And one list
 * puts every size claim in a single place a reviewer can read against the
 * runtime growth check, which is what catches a forecast that turns out wrong.
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
  // One row per cron delivery, about 1,900 a day kept 7 days by its purge job
  // (#2284), so 13,000 to 27,000 rows. The daily growth check flagged it on
  // 2026-10-18 (#2390). Its one reader, the hourly cron guard check, pages it
  // 1,000 rows at a time with a full order.
  'cron_tick_deliveries',
  // One row per day or partition each purge run decides on, never pruned: 233
  // rows on 2026-10-18, 35 in the week before, so about 5 a day and past 1,000
  // early in 2027. Declared here by #962 rather than left for the growth alert.
  'purge_run_log',
]

// Every table a migration creates that is NOT in BIG_TABLES, with how many rows
// it holds and why it stays small (#962). The completeness test below fails on
// a new table that is in neither list, so the size is decided once, when the
// table is created, by the person who knows its volume, instead of by the daily
// growth alert after it has crossed 500 rows.
//
// Each reason is about SIZE, never about how the table is read, so it stays
// true if #1437 retires BIG_TABLES. It must contain a row count, or say
// "unmeasured" plainly; the test refuses a reason with neither. A table whose
// reason says it grows without a ceiling belongs in BIG_TABLES instead once it
// is within a year of 1,000 rows.
//
// Seeded 2026-10-18 from an exact count(*) of every table on production, read
// only. "No pruning" means no migration deletes its rows on a schedule.
const SMALL_TABLES: Record<string, string> = {
  // Configuration, written by hand or by a person in the app.
  organizations: '3 rows on 2026-10-18. One per customer organization.',
  users: '8 rows on 2026-10-18. One per person with access.',
  user_allowlist: '9 rows on 2026-10-18. One per allowed email.',
  workflows: '55 rows on 2026-10-18, created since 2026-04-06. One per workflow a person builds.',
  folders: '3 rows on 2026-10-18. Workflow folders, made by hand.',
  env_var_folders: '10 rows on 2026-10-18. Environment variable folders, made by hand.',
  environment_variables: '62 rows on 2026-10-18, created since 2026-04-21. One per variable a person sets.',
  service_connections: '1 row on 2026-10-18. One per connected service per organization.',
  connection_tombstones: '0 rows on 2026-10-18. One per removed service connection generation, which a person does by hand.',
  service_presets: '0 rows on 2026-10-18. One per saved service preset.',
  api_sources: '7 rows on 2026-10-18. One per source holding a webhook key.',
  webhook_endpoints: '9 rows on 2026-10-18. One per custom endpoint.',
  source_workflow_assignments: '6 rows on 2026-10-18. One per source and workflow pairing.',
  app_config: '1 row on 2026-10-18. Single row settings.',
  app_settings: '1 row on 2026-10-18. One per organization setting.',
  partner_configs: '10 rows on 2026-10-18. One per partner.',
  partner_uuid_map: '7 rows on 2026-10-18. A handful of ids per partner.',
  partner_bid_configs: '0 rows on 2026-10-18. One per partner bid matrix; none configured.',
  bid_config_history: '0 rows on 2026-10-18. One per change to a bid matrix config, and none is configured.',
  partner_daily_counts: '0 rows on 2026-10-18. Nothing writes it.',
  buyer_profiles: '2 rows on 2026-10-18. One per buyer partner.',
  buyer_operating_windows: '12 rows on 2026-10-18. At most 7 per buyer profile.',
  buyer_blackout_dates: '0 rows on 2026-10-18. A few holidays per buyer profile a year.',
  buyer_pricing_tiers: '2 rows on 2026-10-18. A handful per buyer profile.',
  field_presence_silences: '0 rows on 2026-10-18. One per field a person silences.',
  // Single row state.
  execution_archive_progress: '1 row on 2026-10-18. One per archive stream.',
  field_presence_rollup_state: '1 row on 2026-10-18. Single row watermark.',
  // Ledgers with a ceiling set by retention or by being a defect record.
  execution_archive_refusals: '1 row on 2026-10-18. A defect ledger its migration expects to stay at zero; no pruning.',
  execution_archive_erasures: '0 rows on 2026-10-18. One per erasure request; no pruning.',
  held_click_claims: '0 rows on 2026-10-18. One per held click claim, deleted on release.',
  cron_guard_fail_opens: '8 rows on 2026-10-18. One per cron guard fail open, kept 7 days.',
  outcome_writeback_deadletters: '0 rows on 2026-10-18. One per failed Salesforce write; finished rows kept 30 days.',
  alert_incidents: '13 rows on 2026-10-18 after 4 days. About 3 a day, closed rows kept 90 days, so about 300.',
  // Slow growers with no pruning, each well over a year from 1,000 rows.
  execution_archive_days: '65 rows on 2026-10-18. One per UTC day since 2026-08-14 and no pruning, so 365 a year.',
  buyer_select_parity_days: '34 rows on 2026-10-18. One per buyer_select workflow per Eastern day (one workflow today) and no pruning, so about 365 a year.',
  partner_page_live_misses: '0 rows on 2026-10-18. Its migration expects a handful a day with no pruning, so a few hundred a year.',
  // The Pipedream move inventory, loaded from exports by a script.
  'porting.pipedream_inventory': '386 rows on 2026-10-18. One per Pipedream workflow in a loaded export; bounded by the Pipedream account.',
  'porting.pipedream_workflow_map': '0 rows on 2026-10-18. At most one per inventory row.',
}

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

// ── Every table declares its size when it is created (#962) ──────────────────

// Reduce a migration to the SQL that RUNS: comments and single quoted strings
// become spaces, so prose about a table ("CREATE TABLE execution_steps" in a
// comment) and dynamic DDL built inside a string (`format('CREATE TABLE %I
// PARTITION OF ...')`, the monthly and daily partition makers) are never read as
// a table being created. Dollar quoted bodies stay, because a DO block or a
// function can create a table directly and that table is real. One pass, so a
// `--` inside a string is not taken for a comment and an apostrophe inside a
// comment does not open a string.
function sqlCodeOnly(sql: string): string {
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
function tableKey(raw: string): string {
  const name = raw.replace(/"/g, '').toLowerCase()
  return name.startsWith('public.') ? name.slice('public.'.length) : name
}

const NAME = String.raw`(?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?`

/**
 * The tables a fresh database holds after every migration in `files` is applied
 * in order: each CREATE TABLE adds its table, a DROP TABLE or a RENAME removes
 * or renames it. Partitions are left out (a `PARTITION OF` child, or a table a
 * later ATTACH PARTITION makes one), because the completeness test above already
 * holds every partitioned parent to BIG_TABLES. Temporary tables are left out
 * because they do not outlive the session that made them.
 */
function tablesCreatedBy(files: Array<{ name: string; sql: string }>): Map<string, string> {
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

function migrationFiles(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }))
}

// A declaration must say how big the table is, as a number, or say plainly that
// nobody has measured it. A bare "small" or "config" is a guess nobody can hold
// to anything later.
const STATES_A_SIZE = /\d|\bunmeasured\b/i

describe('every table declares its expected size at creation (#962)', () => {
  it('every table a migration creates is in BIG_TABLES or SMALL_TABLES', () => {
    const live = tablesCreatedBy(migrationFiles())
    const big = new Set(BIG_TABLES)
    const undeclared = [...live.entries()]
      .filter(([t]) => !big.has(t) && !(t in SMALL_TABLES))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(
      undeclared.map(([t, file]) => `${t} (${file})`),
      `Table(s) created in supabase/migrations with no declared size:\n` +
        `${undeclared.map(([t, file]) => `  ${t}, created in ${file}`).join('\n')}\n\n` +
        `Decide now, while the volume is known: add the table to BIG_TABLES if it can ` +
        `pass 1,000 rows (and to KNOWN_BIG_TABLES in apps/worker/src/lib/big-table-guard.ts), ` +
        `or to SMALL_TABLES in this file with how many rows it holds and why it stays there.`,
    ).toEqual([])
  })

  it('every SMALL_TABLES entry names a live table, states a size, and is not also big', () => {
    const live = tablesCreatedBy(migrationFiles())
    const big = new Set(BIG_TABLES)
    const problems: string[] = []
    for (const [table, reason] of Object.entries(SMALL_TABLES)) {
      // A stale entry is also how a parser fault would show: a table this file
      // stopped finding drops out of the live set and lands here.
      if (!live.has(table)) problems.push(`${table}: no migration creates it (or a later one drops it)`)
      if (big.has(table)) problems.push(`${table}: in both BIG_TABLES and SMALL_TABLES`)
      if (!STATES_A_SIZE.test(reason)) problems.push(`${table}: reason states no row count and does not say unmeasured`)
    }
    expect(problems).toEqual([])
  })
})

describe('the table size declaration check can fail (#962)', () => {
  // The two tests above pass on the real migrations whether the parser works or
  // finds nothing at all, so drive it against fixtures it must get right.
  const run = (sql: string) => [...tablesCreatedBy([{ name: 'fixture.sql', sql }]).keys()].sort()

  it('finds plain, IF NOT EXISTS, schema qualified and quoted tables', () => {
    expect(
      run(
        'CREATE TABLE a (id int);\n' +
          'create table if not exists public.b (id int);\n' +
          'CREATE UNLOGGED TABLE "C" (id int);\n' +
          'CREATE TABLE porting.d (id int);\n' +
          'DO $$ BEGIN CREATE TABLE e (id int); END $$;\n',
      ),
    ).toEqual(['a', 'b', 'c', 'e', 'porting.d'])
  })

  it('ignores partitions, temporary tables, comments and DDL inside strings', () => {
    expect(
      run(
        'CREATE TABLE p (id int) PARTITION BY RANGE (id);\n' +
          'CREATE TABLE p_1 PARTITION OF p FOR VALUES FROM (1) TO (2);\n' +
          'CREATE TABLE p_2 (LIKE p);\nALTER TABLE p ATTACH PARTITION p_2 FOR VALUES FROM (2) TO (3);\n' +
          'CREATE TEMP TABLE scratch (id int);\n' +
          "-- CREATE TABLE in_a_comment (id int); it's prose\n" +
          '/* CREATE TABLE in_a_block (id int) */\n' +
          "EXECUTE format('CREATE TABLE IF NOT EXISTS %I (id int)', 'dyn');\n" +
          "COMMENT ON TABLE p IS 'see -- CREATE TABLE in_a_string (id int)';\n",
      ),
    ).toEqual(['p'])
  })

  it('forgets a dropped table and follows a renamed one', () => {
    expect(
      run(
        'CREATE TABLE gone (id int);\nCREATE TABLE old_name (id int);\nCREATE TABLE kept (id int);\n' +
          'DROP TABLE IF EXISTS public.gone;\nALTER TABLE public.old_name RENAME TO new_name;\n',
      ),
    ).toEqual(['kept', 'new_name'])
  })

  it('a new table that is neither big nor declared small is reported', () => {
    const live = tablesCreatedBy([
      ...migrationFiles(),
      { name: '29991231000000_fixture.sql', sql: 'CREATE TABLE IF NOT EXISTS public.fixture_undeclared_962 (id int);' },
    ])
    const big = new Set(BIG_TABLES)
    const undeclared = [...live.keys()].filter((t) => !big.has(t) && !(t in SMALL_TABLES))
    expect(undeclared).toEqual(['fixture_undeclared_962'])
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
  // tests accept a table in SMALL_TABLES as readily as one in BIG_TABLES, so
  // moving an entry across passes them, the mirror test only compares the two
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
