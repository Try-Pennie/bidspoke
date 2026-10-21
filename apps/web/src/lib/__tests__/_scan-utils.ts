/**
 * Shared file-scanning helpers for the build-time guard tests (#321).
 *
 * Several guards (worker-big-table-pagination, worker-json-cast-guard,
 * worker-db-error-guard, em-dash-scan, emoji-scan, contrast, focus-ring,
 * icon-button-aria, shadow-side-effect, ...) each used to carry their own copy
 * of the same recursive file walker, comment/string blanker, and balanced-paren
 * consumer. Centralizing them here stops the copies from drifting. The file is
 * NOT a test (no `.test.ts` suffix) so vitest won't collect it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at apps/web/src/lib/__tests__/, so the repo root is five up.
const HERE = fileURLToPath(new URL('.', import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '../../../../..')
export const WORKER_SRC = path.join(REPO_ROOT, 'apps/worker/src')
export const WEB_SRC = path.join(REPO_ROOT, 'apps/web/src')

export interface ListFilesOptions {
  /** File extensions to collect. Default: ['.ts', '.tsx']. */
  exts?: string[]
  /**
   * Directory names to skip during recursion. Default:
   * ['__tests__', '__guards__', 'node_modules'].
   *
   * `__guards__` is in the default for the same reason `__tests__` is: it holds
   * tests, and a scanner that walks it starts reading its own fixtures as
   * shipping source. That is not hypothetical, it is how this entry got here
   * (#502): moving the worker guards into `__guards__` immediately made the
   * live-database-object guard report an RPC called `name`, which it had read
   * out of a test's fake client.
   */
  skipDirs?: string[]
  /** Include `*.test.<ext>` files. Default: false. */
  includeTests?: boolean
}

/** Recursively collect source files under `root`, in directory order. */
export function listFiles(root: string, options: ListFilesOptions = {}): string[] {
  const exts = options.exts ?? ['.ts', '.tsx']
  const skipDirs = options.skipDirs ?? ['__tests__', '__guards__', 'node_modules']
  const includeTests = options.includeTests ?? false
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) {
      if (skipDirs.includes(entry)) continue
      out.push(...listFiles(full, options))
    } else {
      const ext = exts.find((e) => entry.endsWith(e))
      if (!ext) continue
      if (!includeTests && entry.endsWith(`.test${ext}`)) continue
      out.push(full)
    }
  }
  return out
}

/** Collect `.ts` (not `.test.ts`) files, skipping `__tests__`/`node_modules`. */
export const listTsFiles = (root: string): string[] => listFiles(root, { exts: ['.ts'] })

/** Collect `.tsx` (not `.test.tsx`) files, skipping `__tests__`/`node_modules`. */
export const listTsxFiles = (root: string): string[] => listFiles(root, { exts: ['.tsx'] })

/**
 * Replace comments — and optionally string/template contents — with spaces,
 * preserving offsets so reported line numbers stay accurate. Strings are always
 * *skipped* for comment detection (so a `//` inside a URL string isn't treated
 * as a comment); they are only blanked when `blankStrings` is true (the default).
 */
export function sanitizeSource(src: string, opts: { blankStrings?: boolean } = {}): string {
  const blankStrings = opts.blankStrings ?? true
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < src.length && src[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
      blank(i, j + 2)
      i = j + 2
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      if (blankStrings) blank(i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/**
 * Consume a balanced `(...)` starting at `src[open] === '('`. Returns the index
 * just past the matching `)`. Skips string/template contents so a paren inside a
 * literal doesn't affect the depth — safe on both raw and sanitized source.
 */
export function consumeParens(src: string, open: number): number {
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

// ── Route handler scanning ───────────────────────────────────────────────────
//
// Shared by the guards that read what each worker route handler does to the
// workflows table: workflow-copy-refresh-guard (#1845) and
// workflow-connection-check-guard (#2338). Both read source with comments
// blanked and strings kept.

/** The calls chained onto a builder from `start`, read call by call: each name and the source of its arguments. */
export function chainCallsAfter(src: string, start: number): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = []
  let i = start
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (src[i] !== '.') return calls
    const m = /^\.(\w+)\s*\(/.exec(src.slice(i))
    if (!m) return calls
    const open = i + m[0].length - 1
    const close = consumeParens(src, open)
    calls.push({ name: m[1], args: src.slice(open + 1, close - 1) })
    i = close
  }
}

export interface RouteHandler { file: string; label: string; start: number; end: number }

/**
 * Route handlers, each running from its registration to the next one. Only a
 * call on a router the file declares (`const workflows = new Hono...`) is a
 * registration: `kv.get('key', 'json')` on a line of its own has the same shape
 * and would otherwise end the handler it sits in.
 */
export function routeHandlersOf(file: string, src: string): RouteHandler[] {
  const routers = [...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+Hono\b/g)].map((m) => m[1])
  if (routers.length === 0) return []
  const registration = new RegExp(`^\\s*(?:${routers.join('|')})\\.(get|post|put|patch|delete|all)\\(\\s*(['"\`])([^'"\`]*)\\2\\s*,`, 'gm')
  const starts = [...src.matchAll(registration)]
  return starts.map((m, k) => ({
    file,
    label: `${m[1].toUpperCase()} ${m[3]}`,
    start: m.index ?? 0,
    end: k + 1 < starts.length ? (starts[k + 1].index ?? src.length) : src.length,
  }))
}

// ── Supabase write scanning ──────────────────────────────────────────────────
//
// Shared by the guards that police PostgREST writes (worker-zero-row-write-guard,
// worker-single-write-404-guard). Both need to answer the same question first:
// "is this `.update(`/`.delete(` a database write, and where does its statement
// end?" Keeping one implementation is the point of this file (#522).

/** Index of the `(` matching the `)` at `closeIndex`, or -1. */
export function matchingOpenParen(src: string, closeIndex: number): number {
  let depth = 0
  for (let k = closeIndex; k >= 0; k--) {
    if (src[k] === ')') depth++
    else if (src[k] === '(') {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

/** The identifier ending at `end` (exclusive), reading backwards. */
export function identifierBefore(src: string, end: number): string {
  let i = end - 1
  while (i >= 0 && /\s/.test(src[i])) i--
  const stop = i + 1
  while (i >= 0 && /[\w$]/.test(src[i])) i--
  return src.slice(i + 1, stop)
}

/**
 * Names bound to a supabase query builder (`let query = supabase...`). This
 * codebase builds detached builders for conditional filters, so a write can be
 * reached through one instead of directly off `.from(...)`.
 */
export function collectBuilderVars(src: string): Set<string> {
  const vars = new Set<string>()
  const re = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*supabase\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) vars.add(m[1])
  return vars
}

/**
 * True when the `.update(`/`.delete(` whose dot sits at `dotIndex` is a
 * PostgREST write.
 *
 * The receiver decides it: either the `from(...)` call the write hangs off, or a
 * variable holding a detached builder. Asking instead whether a `.from(` appears
 * within N characters is true of nearly every line in a route file, and so
 * mistakes Hono's `router.delete(path, handler)` and KV's `kv.delete(key)` for
 * database writes (#588).
 */
export function receiverIsSupabase(src: string, dotIndex: number, builderVars: Set<string>): boolean {
  let i = dotIndex - 1
  while (i >= 0 && /\s/.test(src[i])) i--
  if (i < 0) return false
  if (src[i] === ')') {
    const open = matchingOpenParen(src, i)
    if (open < 0) return false
    return identifierBefore(src, open) === 'from'
  }
  return builderVars.has(identifierBefore(src, i + 1))
}

/**
 * End of the method-chain statement starting at `.update(` / `.delete(`.
 *
 * This codebase writes no semicolons, so a statement ends at a newline that
 * leaves us outside every open paren AND is not continued by a chained `.method(`
 * on the next line. Paren depth is what stops `.eq('id', String(id))` from ending
 * the chain early. Operates on SANITIZED source, where parens inside string
 * literals have already been blanked.
 */
export function statementEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth <= 0) return i + 1
    else if (ch === '\n' && depth <= 0) {
      const next = /\S/.exec(src.slice(i + 1))
      if (next && next[0] === '.') continue
      return i
    }
  }
  return src.length
}

export interface SupabaseWrite {
  /** 'update' or 'delete'. */
  op: string
  /** Index of the `.` in `.update(` / `.delete(`, within the SANITIZED source. */
  index: number
  /** 1-based line number. */
  line: number
  /** Statement text, sanitized. */
  stmt: string
  /** Statement text, raw (string contents intact, so `count: 'exact'` matches). */
  rawStmt: string
  /** Index just past the statement. */
  end: number
}

/** Every PostgREST `.update(`/`.delete(` write in `sanitized`, in source order. */
export function findSupabaseWrites(sanitized: string, raw: string): SupabaseWrite[] {
  const builderVars = collectBuilderVars(sanitized)
  const out: SupabaseWrite[] = []
  const re = /\.(update|delete)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sanitized))) {
    if (!receiverIsSupabase(sanitized, m.index, builderVars)) continue
    const end = statementEnd(sanitized, m.index)
    out.push({
      op: m[1],
      index: m.index,
      line: sanitized.slice(0, m.index).split('\n').length,
      stmt: sanitized.slice(m.index, end),
      rawStmt: raw.slice(m.index, end),
      end,
    })
  }
  return out
}

/** One workspace package, as declared by its own package.json. */
export interface WorkspacePackage {
  /** Absolute directory. */
  dir: string
  /** Repo-relative directory, e.g. `packages/uuidv7`. */
  relativeDir: string
  /** The `name` field, e.g. `@bidspoke/uuidv7`. */
  name: string
  scripts: Record<string, string>
}

/**
 * Every workspace package, enumerated from the globs `pnpm-workspace.yaml`
 * declares (#869).
 *
 * Shared rather than copied into each guard that needs it, because two guards
 * already do (CI must run every package's suite, and every deploy must be able to
 * see a shared package change) and a second copy of the parsing is a second thing
 * to get wrong.
 *
 * Only the single-level `dir/*` form the workspace actually uses is understood. A
 * deeper glob throws rather than being skipped, because silently ignoring one
 * would leave every caller reporting green about packages it never looked at.
 */
export function workspacePackages(): WorkspacePackage[] {
  const workspace = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...workspace.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1])
  if (globs.length === 0) throw new Error('pnpm-workspace.yaml declares no package globs')

  const out: WorkspacePackage[] = []
  for (const glob of globs) {
    const match = /^([^*]+)\/\*$/.exec(glob)
    if (!match) throw new Error(`workspace glob '${glob}' is not the dir/* form this helper understands`)
    const parentRelative = match[1]
    const parent = path.join(REPO_ROOT, parentRelative)
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent)) {
      const manifest = path.join(parent, entry, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        scripts?: Record<string, string>
      }
      out.push({
        dir: path.join(parent, entry),
        relativeDir: `${parentRelative}/${entry}`,
        name: pkg.name ?? entry,
        scripts: pkg.scripts ?? {},
      })
    }
  }
  return out
}

/**
 * ---------------------------------------------------------------------------
 * GitHub Actions workflow slicing (#1066)
 * ---------------------------------------------------------------------------
 *
 * Six guard tests each carved one job out of `.github/workflows/ci.yml`, and
 * each did it differently. Three defined the job they wanted by naming the job
 * that happened to FOLLOW it (`\n  a11y:` to `\n  auth-gate:`). That is a window
 * chosen by a neighbour: insert a job between the two, or rename either, and the
 * slice silently returns a different span. The guard does not go red, it goes on
 * asserting confidently about the wrong job (L135).
 *
 * The job splits in the "Faster PR testing" milestone add, rename and reorder
 * jobs in both ci.yml and deploy.yml, so that shape had to go before they land.
 *
 * These helpers derive the boundaries from the two-space job keys themselves,
 * and an absent id THROWS naming the ids that are present. Returning '' instead
 * would be the worse failure: every `expect(body).not.toMatch(...)` in these
 * guards passes against an empty string, so a mistyped id would read as the
 * property being satisfied (L215).
 */

/** Zero-based line index of the `jobs:` key, or -1. */
function jobsBlockAt(lines: string[]): number {
  return lines.findIndex((l) => /^jobs:\s*$/.test(l))
}

/** True when the line is a job key: exactly two spaces deep, directly under `jobs:`. */
function jobKeyOn(line: string): string | null {
  const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
  return match ? match[1] : null
}

/**
 * Every job id in `yaml`, in file order.
 *
 * Takes the workflow's TEXT rather than a path, so a caller can slice a file it
 * has already read and a test can feed it a literal.
 */
export function workflowJobIds(yaml: string): string[] {
  const lines = yaml.split('\n')
  const jobsAt = jobsBlockAt(lines)
  if (jobsAt === -1) throw new Error('workflow has no top-level `jobs:` block')
  return lines
    .slice(jobsAt + 1)
    .map(jobKeyOn)
    .filter((id): id is string => id !== null)
}

/**
 * The body of exactly one job, from its key line to the line before the next
 * job key (or the end of the file for the last job).
 *
 * Trailing blank lines and any comment block sitting between two jobs belong to
 * NEITHER job: a comment written above `auth-gate:` explains auth-gate, so
 * leaving it inside the previous job's slice would let it answer that job's
 * assertions. They are trimmed off the end of every body.
 */
export function workflowJobBody(yaml: string, jobId: string): string {
  const lines = yaml.split('\n')
  const jobsAt = jobsBlockAt(lines)
  if (jobsAt === -1) throw new Error('workflow has no top-level `jobs:` block')

  const starts = new Map<string, number>()
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const id = jobKeyOn(lines[i])
    if (id !== null && !starts.has(id)) starts.set(id, i)
  }

  const start = starts.get(jobId)
  if (start === undefined) {
    const found = [...starts.keys()].join(', ') || '(none)'
    throw new Error(`workflow has no job called '${jobId}'. It defines: ${found}`)
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (jobKeyOn(lines[i]) !== null) {
      end = i
      break
    }
  }

  // Walk back over the blank lines and the comment block that introduce the
  // NEXT job, so they are not read as part of this one.
  while (end > start + 1) {
    const previous = lines[end - 1].trim()
    if (previous === '' || previous.startsWith('#')) end -= 1
    else break
  }

  return lines.slice(start, end).join('\n')
}

/**
 * The steps of one job body (as `workflowJobBody` returns it), in file order,
 * each with its `name:` (null for an unnamed step such as a bare `uses:`) and
 * its own lines. A step starts at a `- ` six spaces deep and runs to the next,
 * less the comment block written above that next step.
 */
export function workflowSteps(jobBody: string): Array<{ name: string | null; body: string }> {
  const lines = jobBody.split('\n')
  const starts = lines.flatMap((line, i) => (/^ {6}- /.test(line) ? [i] : []))
  return starts.map((start, n) => {
    // Trailing blank lines and a comment block at step depth introduce the NEXT
    // step, so they are trimmed off, as workflowJobBody does for jobs (L103).
    let end = starts[n + 1] ?? lines.length
    while (end > start + 1 && (lines[end - 1].trim() === '' || /^ {6}#/.test(lines[end - 1]))) end -= 1
    const body = lines.slice(start, end).join('\n')
    const name = /^ {6}(?:- | {2})name:\s*(.+?)\s*$/m.exec(body)?.[1] ?? null
    return { name, body }
  })
}

/** The body of the one step in `jobBody` whose `name:` is `stepName`. */
export function workflowStepBody(jobBody: string, stepName: string): string {
  const steps = workflowSteps(jobBody)
  const matches = steps.filter((s) => s.name === stepName)
  if (matches.length !== 1) {
    const found = steps.map((s) => s.name ?? '(unnamed)').join(', ')
    throw new Error(`expected exactly one step named '${stepName}', found ${matches.length}. Steps: ${found}`)
  }
  return matches[0].body
}

/**
 * The `if:` of a job body (indent 4) or a step body (indent 8, the key under a
 * step's `- `), joined onto one line, or null when it has none. Reads both the
 * single line form and a `|` or `>` block, whose lines run until the indent
 * falls back to the key's.
 */
export function workflowIf(body: string, indent: 4 | 8): string | null {
  const lines = body.split('\n')
  const key = new RegExp(`^(?: {${indent}}|${' '.repeat(indent - 2)}- )if:\\s*(.*)$`)
  for (let i = 0; i < lines.length; i++) {
    const m = key.exec(lines[i])
    if (!m) continue
    const rest = m[1].trim()
    if (rest !== '|' && rest !== '>' && rest !== '|-' && rest !== '>-') return rest
    const block: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      block.push(line.trim())
    }
    return block.join(' ')
  }
  return null
}

/** The `needs:` list of a job body, in the `needs: [a, b]` form, or [] when it has none. */
export function workflowNeeds(jobBody: string): string[] {
  const m = jobBody.match(/^ {4}needs: \[([^\]]*)\]/m)
  return m ? m[1].split(',').map((s) => s.trim()) : []
}

/**
 * Evaluates a workflow `if:` for the subset of the GitHub expression language
 * the deploy conditions use: always(), &&, ||, parentheses, == and != on dotted
 * lookups into `ctx` and quoted strings. So "a skipped Worker deploy still lets
 * this run" is a computed answer rather than a reading of the text. Throws on a
 * token it does not know (a `!`, a function other than always()), so a new
 * construct is reported rather than misread.
 */
export function evaluateWorkflowIf(expr: string, ctx: Record<string, unknown>): boolean {
  const tokens = expr.match(/always\(\)|&&|\|\||==|!=|\(|\)|'[^']*'|[A-Za-z_][\w.-]*|\S/g) ?? []
  const name = /^[A-Za-z_][\w.-]*$/
  tokens.forEach((t, n) => {
    const operator = ['always()', '&&', '||', '==', '!=', '(', ')'].includes(t) || /^'[^']*'$/.test(t)
    // A name followed by `(` is a function call, such as success() or failure(), which this does not evaluate.
    if ((!operator && !name.test(t)) || (name.test(t) && tokens[n + 1] === '(')) {
      throw new Error(`evaluateWorkflowIf does not know '${t}${tokens[n + 1] === '(' ? '(' : ''}' in: ${expr}`)
    }
  })
  let i = 0
  const peek = () => tokens[i]
  const take = () => tokens[i++]
  const lookup = (p: string): unknown => p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)
  function primary(): unknown {
    const t = take()
    if (t === '(') { const v = or(); take(); return v }
    if (t === 'always()') return true
    if (t?.startsWith("'")) return t.slice(1, -1)
    if (t === 'true') return true
    if (t === 'false') return false
    return lookup(t ?? '')
  }
  function comparison(): unknown {
    const left = primary()
    if (peek() === '==' || peek() === '!=') {
      const op = take()
      const right = primary()
      return op === '==' ? left === right : left !== right
    }
    return left
  }
  function and(): unknown {
    let v = comparison()
    while (peek() === '&&') { take(); const r = comparison(); v = Boolean(v) && Boolean(r) }
    return v
  }
  function or(): unknown {
    let v = and()
    while (peek() === '||') { take(); const r = and(); v = Boolean(v) || Boolean(r) }
    return v
  }
  const value = Boolean(or())
  if (i !== tokens.length) throw new Error(`evaluateWorkflowIf stopped at token ${i} of ${tokens.length} in: ${expr}`)
  return value
}

/** Read a workflow file from the repo and return its text. */
export function readWorkflow(relativePath: string): string {
  const file = path.join(REPO_ROOT, relativePath)
  const text = readFileSync(file, 'utf8')
  if (text.length === 0) throw new Error(`${file} is empty`)
  return text
}

/**
 * The pnpm version the root package.json declares in `packageManager`, the one
 * place the repo's pnpm version lives (#1677). CI's `pnpm/action-setup`, a
 * developer's local pnpm and Dependabot all read it. Returns undefined when the
 * field is absent or names another package manager, so a caller can say which.
 */
export function declaredPnpmVersion(): string | undefined {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    packageManager?: unknown
  }
  const field = manifest.packageManager
  if (typeof field !== 'string' || !field.startsWith('pnpm@')) return undefined
  return field.slice('pnpm@'.length)
}

/** Every `.github/workflows/*.yml` path, relative to the repo root, in name order. */
export function workflowFiles(): string[] {
  const dir = path.join(REPO_ROOT, '.github/workflows')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => `.github/workflows/${f}`)
}
