/**
 * Guard against the recurring "unpaginated big-table read" bug (#115).
 *
 * PostgREST caps a list response at 1,000 rows; a bare `.select()` of a large or
 * partitioned table silently truncates past the cap (and shuffles rows without a
 * stable order). This has been found and fixed one site at a time (volume-cliff,
 * bid-matrix sync/lookup, sf-matrix-audit, slow-execution-rate).
 *
 * Since #1437 the scan reads EVERY table, in every folder of apps/worker/src, and
 * a list read must declare its bound (Dan's decisions on #1437, 2026-10-18):
 * .single()/.maybeSingle(), .limit(n) with n at most 1,000 (a limit above the cap
 * counts as none), or .range() with an .order(). A head only count returns no
 * rows. A builder held in a variable is judged by every place that finishes it.
 * The reads that broke this on the day are the baseline in
 * worker-unbounded-reads-baseline.json, which only shrinks.
 *
 * A read bounded by its own filter (one execution's steps, a batch of ids) may
 * say so with `// paginate-ok .eq(execution_id): <reason>`: the comment names
 * the filter that bounds it, and the scan checks that filter is on the query.
 * Only filters that select are accepted (.eq, .in, .gte, .gt, .lte, .lt), and a
 * paginate-ok naming none (the old `// paginate-ok: <reason>`) excuses nothing.
 *
 * BIG_TABLES and SMALL_TABLES below no longer decide what the scan reads; they
 * stay, with their completeness tests and the runtime mirror, until #1437 P7
 * deletes them with the daily size alert (Dan's decision c).
 *
 * Until then every table any migration creates must still be declared: in BIG_TABLES,
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
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, WORKER_SRC, listTsFiles, consumeParens, sanitizeSource, identifierBefore } from '../../__tests__/_scan-utils'

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

// The unbounded list reads apps/worker/src held on 2026-10-18 when the rule was
// widened to every table (#1437), as file -> table -> count. It only shrinks:
// the scan fails on a read it does not list, and on an entry the code no longer
// has, so each conversion (#1437 P4 to P6) lowers it in the same change.
const BASELINE_NAME = 'worker-unbounded-reads-baseline.json'
const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL(`./${BASELINE_NAME}`, import.meta.url)), 'utf8'),
) as Record<string, Record<string, number>>

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
  // the cap within weeks of being created. Its reads are meant to be bounded by
  // a date window or by one day's 24 hours (#1191). Their paginate-ok comments
  // name no filter, which #1437 no longer accepts, so the ones with no limit
  // are in the unbounded read baseline until each names its filter or limits.
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
const ROW_LIMIT_METHODS = new Set(['single', 'maybeSingle', 'range', 'limit'])
// `<recv>.from(...)` where recv is one of these is a JS built-in (Array.from,
// Uint8Array.from, ...), not a Supabase table read.
const BUILTIN_FROM_RECEIVERS = new Set([
  'Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'Buffer', 'Object', 'String', 'Number',
])

// PostgREST's cap on one response (#1436). A declared limit above it is not a
// declaration: the reply stops at the cap whatever the query asked for, so the
// rule counts it as no limit (Dan, 2026-10-18, decision b on #1437).
const ROW_CAP = 1000

// The filters a `paginate-ok` may name as the read's bound (Dan, 2026-10-18,
// decision d on #1437): a key filter (`.eq`), an id batch (`.in`), or a window
// on a column (`.gte`/`.gt`/`.lte`/`.lt`). A filter that excludes rather than
// selects (`.neq`, `.not`, `.is`, `.like`) leaves the read as big as the table.
const BOUNDING_FILTERS = new Set(['eq', 'in', 'gte', 'gt', 'lte', 'lt'])

// `// paginate-ok .eq(execution_id): <reason>`, the bounding filters named
// between the marker and its colon. The legacy `// paginate-ok: <reason>` names
// none and is not accepted (#1437).
const PAGINATE_OK = /paginate-ok((?:\s+\.\w+\(\s*[\w.]+\s*\))*)\s*:/

interface ChainCall { name: string; args: string }

// The index just past the type argument list opening at `open` (a `<`), or
// `open` itself when it never closes: an arrow's `=>` is not a closing `>`.
function consumeTypeArgs(src: string, open: number): number {
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const ch = src[k]
    if (ch === '<') depth++
    else if (ch === '>' && src[k - 1] !== '=') {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return open
}

// Walk the .method(...) chain starting at `from` (the index just past .from(...)),
// in SANITIZED source (comments blanked, strings kept). Returns each call with
// its argument text and the index where the chain ends.
function walkChain(src: string, from: number): { calls: ChainCall[]; end: number } {
  const calls: ChainCall[] = []
  let i = from
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== '.') break
    let j = i + 1
    let name = ''
    while (j < src.length && /\w/.test(src[j])) { name += src[j]; j++ }
    // A type argument (`.single<Row>()`) is part of the call, not the end of
    // the chain, so a bound written after one is still seen (#1437).
    if (src[j] === '<') j = consumeTypeArgs(src, j)
    if (src[j] !== '(') break
    const end = consumeParens(src, j)
    calls.push({ name, args: src.slice(j + 1, end - 1) })
    i = end
  }
  return { calls, end: i }
}

// The value of a `.limit(...)` argument when it can be read from this file: a
// numeric literal, or an expression over literals and `const NAME = <number>`
// declared in the same file (`LIMIT + 1`). Null when it cannot be read, an
// imported constant or a parameter, which the rule takes at its word and the
// runtime detector (#1436) backs up.
function limitValue(arg: string, src: string): number | null {
  const expr = arg.trim().replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => {
    const m = new RegExp(String.raw`\bconst\s+${name.replace(/\$/g, '\\$')}\s*(?::\s*number\s*)?=\s*([\d_]+)\b`).exec(src)
    return m ? m[1] : name
  })
  const numeric = expr.replace(/_/g, '')
  if (!/^[\d\s+\-*()]+$/.test(numeric)) return null
  try {
    const value = Function(`"use strict"; return (${numeric})`)() as unknown
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

// 'unbounded': no row limit at all, or one above the cap, so the read stops at
// the cap without saying so. 'unordered': it pages with .range() but declares no
// ORDER BY, so Postgres recomputes each OFFSET against an independent scan and
// the pages skip and duplicate rows. 'paginate-ok-unproven': unbounded, with a
// paginate-ok that does not name a bounding filter the query itself carries, so
// nothing a reader can check backs its claim (#1437).
type FindingKind = 'unbounded' | 'unordered' | 'paginate-ok-unproven'
interface Finding { file: string; line: number; table: string; methods: string[]; kind: FindingKind }

// Whether `call` is `.<method>('<column>', ...)`.
function callFilters(call: ChainCall, method: string, column: string): boolean {
  if (call.name !== method) return false
  const first = /^\s*(['"`])([\w.]+)\1/.exec(call.args)
  return first !== null && first[2] === column
}

/** The text of the statement holding the read at `start`..`end`, with its leading comments, from RAW source. */
function statementWithComments(raw: string, start: number, end: number): string {
  const allLines = raw.split('\n')
  const fromLineIdx = raw.slice(0, start).split('\n').length - 1
  const endLineIdx = raw.slice(0, end).split('\n').length - 1
  let li = fromLineIdx
  while (li > 0 && allLines[li].trim().startsWith('.')) li--
  while (li > 0 && allLines[li - 1].trim().startsWith('//')) li--
  return allLines.slice(li, endLineIdx + 1).join('\n')
}

// Whether a call declares a row limit the rule accepts.
function isRowLimit(call: ChainCall, src: string): boolean {
  if (!ROW_LIMIT_METHODS.has(call.name)) return false
  if (call.name !== 'limit') return true
  const value = limitValue(call.args, src)
  return value === null || value <= ROW_CAP
}

// The index of the first line of the statement holding `index`: back over
// lines that continue it (a chained `.method`, or a ternary's `?` and `:`).
function statementStart(src: string, index: number): number {
  let start = src.lastIndexOf('\n', index - 1) + 1
  while (start > 0) {
    const lineEnd = src.indexOf('\n', start)
    if (!/^\s*[.?:]/.test(src.slice(start, lineEnd === -1 ? src.length : lineEnd))) break
    start = src.lastIndexOf('\n', start - 2) + 1
  }
  return start
}

/**
 * When the read at `fromIndex`..`chainEnd` is a query builder held in a
 * variable (`let query = supabase.from('t').select(..)` and nothing after the
 * chain but a cast), the chains that finish it: every later use of the variable
 * that is not a reassignment of it (`query = query.eq(..)`, `query =
 * read.refine(query)`), each as the calls chained onto it, or onto the call it
 * is passed straight into (`applyFilter(query).limit(n)`). A bare use (`await
 * query`) finishes it with no calls. Null when the read is not held this way.
 * The search stops at the next declaration of the same name, so a `query` in
 * another function is not read as this one.
 */
function builderFinishes(src: string, fromIndex: number, chainEnd: number): ChainCall[][] | null {
  const head = src.slice(statementStart(src, fromIndex), fromIndex)
  const decl = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*[\w$.]+\s*$/.exec(head)
  if (!decl) return null
  // walkChain's end is past the whitespace after the last call, so step back to it.
  let lastCall = chainEnd
  while (lastCall > fromIndex && /\s/.test(src[lastCall - 1])) lastCall--
  if (!/^[ \t]*(?:as\b[^\n]*)?(?:\n|$)/.test(src.slice(lastCall))) return null
  const name = decl[1]
  const word = new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}(?![\w$])`, 'g')
  const redeclared = new RegExp(String.raw`\b(?:const|let|var)\s+${name.replace(/\$/g, '\\$')}\b`, 'g')
  redeclared.lastIndex = chainEnd
  const regionEnd = redeclared.exec(src)?.index ?? src.length
  // Strings blanked here, so a word inside a string is not a use.
  const code = sanitizeSource(src)
  const finishes: ChainCall[][] = []
  word.lastIndex = chainEnd
  let w: RegExpExecArray | null
  while ((w = word.exec(code)) !== null && w.index < regionEnd) {
    // A reassignment is not a finish: the occurrence being assigned to, or one
    // on the right of an assignment to it (`if (p) query = query.eq(..)`).
    const assignedTo = new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\s*=(?![=>])`)
    if (/^\s*=(?![=>])/.test(code.slice(w.index + name.length))) continue
    if (assignedTo.test(code.slice(statementStart(code, w.index), w.index))) continue
    let after = w.index + name.length
    while (/\s/.test(code[after] ?? '')) after++
    if (code[after] === ')') {
      let before = w.index - 1
      while (before >= 0 && /\s/.test(code[before])) before--
      if (code[before] === '(') after += 1
    }
    finishes.push(walkChain(src, after).calls)
  }
  return finishes
}

/**
 * The calls chained onto a wrapper the read at `fromIndex`..`chainEnd` is passed
 * to as its ONLY argument (`onlySlackAlertRow(supabase.from(..)..).limit(2)`):
 * such a wrapper adds filters and hands the builder back, so a bound chained
 * after it bounds the read. Empty when the read is not a sole call argument,
 * since a call taking more (`leadRead(supabase, query, label)`) may return
 * something else entirely (#1437).
 */
function wrapperTail(src: string, fromIndex: number, chainEnd: number): ChainCall[] {
  let r = fromIndex
  while (r > 0 && /\s/.test(src[r - 1])) r--
  while (r > 0 && /[\w$.]/.test(src[r - 1])) r--
  while (r > 0 && /\s/.test(src[r - 1])) r--
  if (src[r - 1] !== '(' || !/[\w$]/.test(src[r - 2] ?? '')) return []
  let k = chainEnd
  while (k > fromIndex && /\s/.test(src[k - 1])) k--
  while (/\s/.test(src[k] ?? '')) k++
  if (src[k] === ',') k++
  while (/\s/.test(src[k] ?? '')) k++
  if (src[k] !== ')') return []
  return walkChain(src, k + 1).calls
}

function scanSource(raw: string, relPath: string): Finding[] {
  const findings: Finding[] = []
  // Comments blanked so a `.from(` in prose is not a read; strings kept so the
  // table name and filter columns can be read.
  const src = sanitizeSource(raw, { blankStrings: false })

  const fromCall = /\.from\(/g
  let m: RegExpExecArray | null
  while ((m = fromCall.exec(src)) !== null) {
    if (BUILTIN_FROM_RECEIVERS.has(identifierBefore(src, m.index))) continue
    const open = m.index + m[0].length - 1
    const afterFromCall = consumeParens(src, open)
    const arg = src.slice(open + 1, afterFromCall - 1).trim()
    const literal = /^(['"`])([\w.]+)\1$/.exec(arg)
    // A table named by a VARIABLE (an export job looping over tables, the ops
    // read helper) is held to the same bar, labelled by the expression.
    const table = literal ? literal[2] : `<${arg.replace(/\s+/g, ' ')}>`

    const { calls, end } = walkChain(src, afterFromCall)
    const methods = calls.map((c) => c.name)
    // Writes aren't list reads.
    if (methods.some((x) => WRITE_METHODS.has(x))) continue
    // Only `.select()` produces a row list to truncate.
    if (!methods.includes('select')) continue
    // A head only count returns a number, not rows.
    const chainText = src.slice(m.index, end)
    if (/\bhead\s*:\s*true/.test(chainText)) continue

    // The chains the read is finally sent as: this one, or, when it is a builder
    // held in a variable and finished later (`let query = supabase.from(..)`,
    // filters added conditionally, then `await query.order(..).range(..)`), each
    // place that finishes it, with this chain in front.
    const isLimited = (chain: ChainCall[]) => chain.some((c) => isRowLimit(c, src))
    // A wrapper the read is handed to alone, and the calls chained onto it.
    const wrapped = [...calls, ...wrapperTail(src, m.index, end)]
    const finishes = isLimited(wrapped) ? [wrapped] : (builderFinishes(src, m.index, end)?.map((t) => [...calls, ...t]) ?? [calls])
    const limited = finishes.length > 0 && finishes.every(isLimited)
    // A .range() read pages, and paging without a stable ORDER BY tears. This is
    // NOT covered by the limit check: .range() satisfies that check while still
    // returning the wrong rows, which is how the field-presence detector's reader
    // shipped torn past this very guard (AUD-039, #432). A .limit() or .single()
    // read takes one page and needs no ordering to be complete.
    const line = src.slice(0, m.index).split('\n').length
    if (limited) {
      const torn = finishes.find((chain) => chain.some((c) => c.name === 'range') && !chain.some((c) => c.name === 'order'))
      if (torn) findings.push({ file: relPath, line, table, methods: torn.map((c) => c.name), kind: 'unordered' })
      continue
    }

    // A `paginate-ok` may excuse an unbounded read only by naming the filter in
    // the query that bounds it, and that filter must be on the chain (#1437).
    const stmt = statementWithComments(raw, m.index, end)
    if (/paginate-ok/.test(stmt)) {
      const marker = PAGINATE_OK.exec(stmt)
      const named = marker ? [...marker[1].matchAll(/\.(\w+)\(\s*([\w.]+)\s*\)/g)].map((x) => [x[1], x[2]] as const) : []
      const proven =
        named.length > 0 &&
        named.every(([method, column]) => BOUNDING_FILTERS.has(method) && calls.some((c) => callFilters(c, method, column)))
      if (!proven) findings.push({ file: relPath, line, table, methods, kind: 'paginate-ok-unproven' })
      continue
    }
    findings.push({ file: relPath, line, table, methods, kind: 'unbounded' })
  }
  return findings
}

function scanFile(file: string): Finding[] {
  return scanSource(readFileSync(file, 'utf8'), path.relative(WORKER_SRC, file))
}

// file -> table -> how many unbounded reads of that table the file held when the
// baseline was recorded (#1437).
type Baseline = Record<string, Record<string, number>>

/**
 * Compares the unbounded reads found (unordered ones never count: they are
 * always a failure) against the baseline. `grew` is a new read, which fails
 * the build. `shrank` is a baseline entry the code no longer has, which also
 * fails, so a conversion shrinks the baseline in the same change and the
 * allowance it leaves cannot be spent on a new read later.
 */
function compareToBaseline(findings: Finding[], baseline: Baseline): { grew: string[]; shrank: string[] } {
  const found = new Map<string, number>()
  for (const f of findings) {
    if (f.kind === 'unordered') continue
    const key = `${f.file}\u0000${f.table}`
    found.set(key, (found.get(key) ?? 0) + 1)
  }
  const recorded = new Map<string, number>()
  for (const [file, tables] of Object.entries(baseline)) {
    for (const [table, count] of Object.entries(tables)) recorded.set(`${file}\u0000${table}`, count)
  }
  const grew: string[] = []
  const shrank: string[] = []
  for (const key of [...new Set([...found.keys(), ...recorded.keys()])].sort()) {
    const now = found.get(key) ?? 0
    const then = recorded.get(key) ?? 0
    const [file, table] = key.split('\u0000')
    const line = `${file} ${table}: ${now} found, baseline ${then}`
    if (now > then) grew.push(line)
    else if (now < then) shrank.push(line)
  }
  return { grew, shrank }
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
        `Add it to BIG_TABLES in this file and to KNOWN_BIG_TABLES in apps/worker/src/lib/big-table-guard.ts, ` +
        `so its size is declared and the daily size check treats it as known.`,
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

/** The tables in `live` that are in neither BIG_TABLES nor SMALL_TABLES, sorted. */
function undeclaredTables(live: Map<string, string>): string[] {
  const big = new Set(BIG_TABLES)
  return [...live.keys()].filter((t) => !big.has(t) && !Object.hasOwn(SMALL_TABLES, t)).sort()
}

describe('every table declares its expected size at creation (#962)', () => {
  it('every table a migration creates is in BIG_TABLES or SMALL_TABLES', () => {
    const live = tablesCreatedBy(migrationFiles())
    const undeclared = undeclaredTables(live).map((t) => [t, live.get(t) as string] as const)
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
    expect(undeclaredTables(live)).toEqual(['fixture_undeclared_962'])
  })

  it('a table named like an Object prototype key is not read as declared', () => {
    // SMALL_TABLES is a plain object, so a lookup that walks the prototype would
    // find `constructor` or `__proto__` on every object and exempt a table of that
    // name without anybody declaring it.
    const live = tablesCreatedBy([
      { name: 'fixture.sql', sql: 'CREATE TABLE constructor (id int);\nCREATE TABLE __proto__ (id int);' },
    ])
    expect(undeclaredTables(live)).toEqual(['__proto__', 'constructor'])
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

describe('the scan catches each shape on the known big tables', () => {
  // Until #1437 these proved each BIG_TABLES entry load-bearing, because the
  // scan read only the tables that list named, and execution_archive_ids
  // (~105,000 rows/day by its own migration's stated volume) sat outside the
  // guard until a runtime alert found it. The scan now reads every table, so
  // they no longer test the list: a dropped entry is caught by the declaration
  // test above, which then requires the table in SMALL_TABLES, and by the
  // runtime mirror. They stay as fixtures of the shapes the scan exists to
  // catch, on the real names of the tables that most need it, until P7 deletes
  // the list. The invented table fixtures below prove the scan reads past it.
  it.each(BIG_TABLES)('an unbounded read of %s is reported', (table) => {
    const findings = scanSource(
      `const { data } = await supabase.from('${table}').select('*')\n`,
      'fixture.ts',
    )
    expect(findings.map((f) => f.table)).toContain(table)
  })

  it('an unbounded read of execution_archive_ids is reported (#871)', () => {
    // Named separately because its absence from the list was once the defect:
    // the archive writes one row per archived execution, which its own migration
    // (20260820000001) states as ~105,000 rows/day and ~3.2M at steady state, so
    // it is far past the 1,000-row cap. Today the worker only WRITES to it; the
    // scan fails the moment the deletion gate's orphan count (#872) reads it
    // without a bound, whether or not the table is listed anywhere.
    const findings = scanSource(
      "const { data } = await supabase.from('execution_archive_ids').select('execution_id')\n",
      'fixture.ts',
    )
    expect(
      findings.map((f) => f.table),
      'an unbounded read of execution_archive_ids must be reported',
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

describe('every worker list read declares its bound (#115, #185, #1437)', () => {
  const findings = listTsFiles(WORKER_SRC).flatMap(scanFile)
  const describeFinding = (f: Finding) =>
    `  ${f.file}:${f.line} .from('${f.table}').${f.methods.join('.')}(): ` +
    (f.kind === 'unbounded'
      ? 'no .limit() at or under 1,000, no .range(), no .single()'
      : f.kind === 'paginate-ok-unproven'
        ? 'its paginate-ok names no bounding filter (.eq/.in/.gte/.gt/.lte/.lt on a column) that the query carries'
        : 'pages with .range() but declares no .order(), so its pages skip and duplicate rows')

  it('the scan reaches every folder of apps/worker/src', () => {
    // The rule once covered lib, engine and routes only. Prove every top level
    // folder holding shipping TypeScript is read now, counted by a walk of its
    // own rather than the walker the scan uses (L564).
    const top = (rel: string) => rel.split(path.sep)[0]
    const scanned = new Set(listTsFiles(WORKER_SRC).map((f) => top(path.relative(WORKER_SRC, f))))
    const shipping = new Set(
      (readdirSync(WORKER_SRC, { recursive: true }) as string[])
        .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.split(path.sep).includes('__tests__'))
        .map(top),
    )
    for (const part of ['archive', 'durable-objects', 'index.ts', 'middleware', 'ops']) expect(shipping).toContain(part)
    expect([...shipping].filter((part) => !scanned.has(part))).toEqual([])
  })

  it('no read pages with .range() and no .order()', () => {
    // Never baselined: a torn page returns plausible rows that are the wrong ones.
    const torn = findings.filter((f) => f.kind === 'unordered')
    expect(torn, `Paged read(s) with no stable order:\n${torn.map(describeFinding).join('\n')}`).toEqual([])
  })

  it('the unbounded reads are the baseline, which only shrinks', () => {
    // Every table, every folder. A read with no declared bound comes back cut at
    // PostgREST's 1,000 row cap without saying so; the runtime detector (#1436)
    // names one when it happens, and this names one before it ships.
    const { grew, shrank } = compareToBaseline(findings, BASELINE)
    const linesOf = (entry: string) => {
      const [file, table] = entry.split(': ')[0].split(' ')
      return findings.filter((f) => f.file === file && f.table === table && f.kind !== 'unordered').map(describeFinding)
    }
    expect(
      grew,
      `New unbounded read(s), not in ${BASELINE_NAME}:\n` +
        grew.map((g) => `${g}\n${linesOf(g).join('\n')}`).join('\n') +
        `\n\nDeclare the bound: .limit(n) with n at most 1,000 (fetchUpTo for a config list), or fetchAllPaged ` +
        `(src/lib/paginate.ts) with a full .order(). A read bounded by its own filter may say so with ` +
        `\`// paginate-ok .eq(column): <why>\`, naming the filter, which must be on the query. Never raise the baseline.`,
    ).toEqual([])
    expect(
      shrank,
      `Baseline entr(ies) in ${BASELINE_NAME} the code no longer has:\n${shrank.join('\n')}\n\n` +
        `A read was converted or removed: lower its count in the baseline to the number found (delete the entry at 0) ` +
        `in this same change, so the allowance cannot be spent on a new read later.`,
    ).toEqual([])
  })

  it('the ops read helper is safe by construction, and the scan can see it', () => {
    // readOpsRows (ops/ops-db.ts) is the only read of the ops database, and it
    // finishes every query with .limit(read.limit), a limit it refuses above
    // OPS_READ_ROW_CAP. Its callers name no `.from(`, so nothing else in ops/ is
    // a read. Prove the scan judges the helper's read rather than missing it:
    // the same file without its limit is reported.
    const raw = readFileSync(path.join(WORKER_SRC, 'ops/ops-db.ts'), 'utf8')
    expect(raw).toContain('await query.limit(read.limit)')
    expect(scanSource(raw, 'ops/ops-db.ts')).toEqual([])
    const unlimited = scanSource(raw.replace('await query.limit(read.limit)', 'await query'), 'ops/ops-db.ts')
    expect(unlimited.map((f) => [f.table, f.kind])).toEqual([['<read.table>', 'unbounded']])
  })
})

describe('the every table read rule can fail (#1437)', () => {
  const scan = (src: string) => scanSource(src, 'fixture.ts')

  it('an unbounded read of a table no list names is reported', () => {
    const findings = scan("const { data } = await supabase.from('fixture_invented_1437').select('*')\n")
    expect(findings.map((f) => [f.table, f.kind])).toEqual([['fixture_invented_1437', 'unbounded']])
  })

  it('a .range() read with no .order() is reported on any table, and goes quiet with one', () => {
    expect(scan("await supabase.from('fixture_invented_1437').select('*').range(0, 999)\n").map((f) => f.kind)).toEqual(['unordered'])
    expect(scan("await supabase.from('fixture_invented_1437').select('*').order('id').range(0, 999)\n")).toEqual([])
  })

  it('a limit above 1,000 counts as no limit, a literal or a constant in the same file', () => {
    expect(scan("await supabase.from('fixture_invented_1437').select('*').limit(5000)\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("const BIG = 5_000\nawait supabase.from('fixture_invented_1437').select('*').limit(BIG + 1)\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("await supabase.from('fixture_invented_1437').select('*').limit(1000)\n")).toEqual([])
    expect(scan("const SMALL = 200\nawait supabase.from('fixture_invented_1437').select('*').limit(SMALL + 1)\n")).toEqual([])
  })

  it('a paginate-ok that names no bounding filter is reported', () => {
    const findings = scan(
      "// paginate-ok: only a handful of rows\nconst { data } = await supabase.from('fixture_invented_1437').select('*')\n",
    )
    expect(findings.map((f) => f.kind)).toEqual(['paginate-ok-unproven'])
  })

  it('a paginate-ok naming a filter the query does not carry is reported', () => {
    const findings = scan(
      "// paginate-ok .eq(execution_id): one execution's steps\n" +
        "const { data } = await supabase.from('fixture_invented_1437').select('*').eq('workflow_id', id)\n",
    )
    expect(findings.map((f) => f.kind)).toEqual(['paginate-ok-unproven'])
  })

  it('a paginate-ok naming a filter that bounds nothing is reported', () => {
    const findings = scan(
      "// paginate-ok .neq(status): not the failed ones\n" +
        "const { data } = await supabase.from('fixture_invented_1437').select('*').neq('status', 'failed')\n",
    )
    expect(findings.map((f) => f.kind)).toEqual(['paginate-ok-unproven'])
  })

  it('a paginate-ok naming a bounding filter the query carries is accepted', () => {
    expect(
      scan(
        "// paginate-ok .eq(execution_id): one execution's steps\n" +
          'const { data } = await supabase\n' +
          "  .from('fixture_invented_1437')\n" +
          "  .select('*')\n" +
          "  .eq('execution_id', id)\n",
      ),
    ).toEqual([])
    expect(
      scan("await supabase.from('fixture_invented_1437').select('id').in('id', chunk) // paginate-ok .in(id): one row per id\n"),
    ).toEqual([])
  })

  it('a dynamic table name, a plain or a member expression, is held to the same bar', () => {
    expect(scan("await supabase.from(table).select('*')\n").map((f) => f.table)).toEqual(['<table>'])
    expect(scan("await client.from(read.table).select('*')\n").map((f) => f.table)).toEqual(['<read.table>'])
  })

  it('JS built ins, writes and head only counts are not list reads', () => {
    expect(scan('const a = Array.from(rows)\nconst b = Buffer.from(text)\n')).toEqual([])
    expect(scan("await supabase.from('fixture_invented_1437').insert(row).select('id')\n")).toEqual([])
    expect(scan("await supabase.from('fixture_invented_1437').select('*', { count: 'exact', head: true })\n")).toEqual([])
  })

  it('a builder held in a variable is judged by every place that finishes it', () => {
    const held = "let query = supabase\n  .from('fixture_invented_1437')\n  .select('*')\n  .eq('organization_id', org)\nif (p) query = query.eq('partner_id', p)\n"
    expect(scan(held + "const { data } = await query.order('id').range(0, 999)\n")).toEqual([])
    expect(scan(held + "const { data } = await query.range(0, 999)\n").map((f) => f.kind)).toEqual(['unordered'])
    expect(scan(held + 'const { data } = await query\n').map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan(held + 'const one = await query.limit(1)\nconst all = await query\n').map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan(held + 'query = refine(query)\nconst { data } = await applyFilter(query).limit(50)\n')).toEqual([])
    expect(scan(held + "query = p === null\n  ? query.is('workflow_id', null)\n  : query.eq('workflow_id', p)\nconst { data } = await query.maybeSingle()\n")).toEqual([])
    // Nothing finishes it here, and another function's `query` is not this one.
    expect(scan(held + "}\nfunction other() {\n  let query = supabase.from('fixture_other_1437').select('*').limit(5)\n  return query.limit(5)\n}\n").map((f) => [f.table, f.kind])).toEqual([['fixture_invented_1437', 'unbounded']])
    // A builder awaited where it is made holds the rows, not the builder.
    expect(scan("const rows = await supabase.from('fixture_invented_1437').select('*')\nrows.limit(1)\n").map((f) => f.kind)).toEqual(['unbounded'])
  })

  it('a .from( inside a comment is not a read', () => {
    expect(scan("// supabase.from('fixture_invented_1437').select('*')\nconst x = 1\n")).toEqual([])
  })

  it('a read passed alone to a wrapper is judged with the calls chained onto the wrapper', () => {
    // `onlySlackAlertRow(query).limit(n)`: the wrapper adds filters and hands the
    // builder back, so the bound after it bounds the read (slack.ts, #1437).
    expect(scan("return onlySlackAlertRow(supabase.from('fixture_invented_1437').select('*').eq('organization_id', org)).limit(2)\n")).toEqual([])
    expect(scan("return wrap(\n  supabase\n    .from('fixture_invented_1437')\n    .select('*')\n    .eq('organization_id', org),\n).limit(SMALL)\n")).toEqual([])
    // With nothing chained onto the wrapper, or a limit over the cap, it is unbounded.
    expect(scan("return wrap(supabase.from('fixture_invented_1437').select('*'))\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("return wrap(supabase.from('fixture_invented_1437').select('*')).limit(5000)\n").map((f) => f.kind)).toEqual(['unbounded'])
    // Not the wrapper's only argument: what comes back need not be the builder.
    expect(scan("return leadRead(supabase, supabase.from('fixture_invented_1437').select('*')).limit(2)\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("return leadRead(supabase.from('fixture_invented_1437').select('*'), 'label').limit(2)\n").map((f) => f.kind)).toEqual(['unbounded'])
  })

  it('a type argument on a chained call does not end the chain', () => {
    // `.single<T>()` reads one row; the walker once stopped at the `<` and
    // reported the read as unbounded (custom-endpoint.ts, #1437).
    const typed = "await supabase.from('fixture_invented_1437').select('*').eq('id', id).single<{ id: string; f: (x: number) => void; m: Map<string, Array<number>> }>()\n"
    expect(scan(typed)).toEqual([])
    expect(scan("await supabase.from('fixture_invented_1437').select('*').maybeSingle<Row>()\n")).toEqual([])
    // A type argument bounds nothing by itself.
    expect(scan("await supabase.from('fixture_invented_1437').select<'*'>('*').eq('id', id)\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("await supabase.from('fixture_invented_1437').select('*').returns<Row[]>()\n").map((f) => f.kind)).toEqual(['unbounded'])
    // And a limit after one is still seen.
    expect(scan("await supabase.from('fixture_invented_1437').select('*').returns<Row[]>().limit(5000)\n").map((f) => f.kind)).toEqual(['unbounded'])
    expect(scan("await supabase.from('fixture_invented_1437').select('*').returns<Row[]>().limit(10)\n")).toEqual([])
  })

  it('the baseline comparison reports a new read and a baseline entry that no longer exists', () => {
    const f = (file: string, table: string): Finding => ({ file, line: 1, table, methods: ['select'], kind: 'unbounded' })
    expect(compareToBaseline([f('a.ts', 't'), f('a.ts', 't')], { 'a.ts': { t: 2 } })).toEqual({ grew: [], shrank: [] })
    expect(compareToBaseline([f('a.ts', 't'), f('a.ts', 't'), f('b.ts', 'u')], { 'a.ts': { t: 1 } })).toEqual({
      grew: ['a.ts t: 2 found, baseline 1', 'b.ts u: 1 found, baseline 0'],
      shrank: [],
    })
    expect(compareToBaseline([], { 'a.ts': { t: 1 } })).toEqual({ grew: [], shrank: ['a.ts t: 0 found, baseline 1'] })
  })
})
