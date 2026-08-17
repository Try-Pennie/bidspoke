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
import { readdirSync, statSync } from 'node:fs'
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
