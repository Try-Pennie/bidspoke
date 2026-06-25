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
  /** Directory names to skip during recursion. Default: ['__tests__', 'node_modules']. */
  skipDirs?: string[]
  /** Include `*.test.<ext>` files. Default: false. */
  includeTests?: boolean
}

/** Recursively collect source files under `root`, in directory order. */
export function listFiles(root: string, options: ListFilesOptions = {}): string[] {
  const exts = options.exts ?? ['.ts', '.tsx']
  const skipDirs = options.skipDirs ?? ['__tests__', 'node_modules']
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
