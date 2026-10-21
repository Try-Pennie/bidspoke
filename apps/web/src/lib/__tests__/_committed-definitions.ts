/**
 * Every workflow definition committed to the repo as JSON, for the guards that
 * must hold over all of them (#2588): the money gate fixtures, the test fixtures
 * of live workflows, the documented exports. Not a test file, so vitest does not
 * collect it.
 *
 * A definition is any object, at any depth of a JSON file, holding a `nodes`
 * array whose entries carry a string `type`, so a fixture that wraps one (a
 * backup's `definition`, a variant's `workflow`) is found as well as a bare one.
 * Each file is read and parsed once (L297).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, listFiles } from './_scan-utils'

/** Top level directories that hold committed definitions. */
const ROOTS = ['apps', 'docs', 'packages', 'scripts', 'supabase', 'supabase-ops']

/** Build output, dependencies and generated graphs: never committed definitions. */
const SKIP_DIRS = [
  'node_modules', '.next', '.vercel', '.wrangler', '.turbo', 'dist', 'coverage',
  'graphify-out', 'test-results', 'playwright-report',
]

export interface CommittedNode {
  type: string
  namespace?: unknown
  config?: Record<string, unknown>
}

export interface CommittedDefinition {
  /** Repo relative path of the JSON file holding it. */
  file: string
  nodes: CommittedNode[]
  /** The whole definition object, for walks that look past the nodes (edge conditions). */
  root: Record<string, unknown>
}

function isNodeArray(value: unknown): value is CommittedNode[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((n) => n !== null && typeof n === 'object' && typeof (n as { type?: unknown }).type === 'string')
}

/** The definitions found anywhere inside one parsed JSON value. */
export function definitionsIn(value: unknown, file: string): CommittedDefinition[] {
  const found: CommittedDefinition[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v === null || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    if (isNodeArray(obj.nodes)) found.push({ file, nodes: obj.nodes, root: obj })
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(value)
  return found
}

let cache: CommittedDefinition[] | null = null

export function committedDefinitions(): CommittedDefinition[] {
  if (cache) return cache
  const out: CommittedDefinition[] = []
  for (const root of ROOTS) {
    const dir = path.join(REPO_ROOT, root)
    for (const full of listFiles(dir, { exts: ['.json'], skipDirs: SKIP_DIRS, includeTests: true })) {
      const text = readFileSync(full, 'utf8')
      // Cheap pre-filter: a file with no "nodes" key holds no definition.
      if (!text.includes('"nodes"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        // A JSON file that does not parse is not a definition anything loads;
        // tsconfig-style files with comments land here.
        continue
      }
      out.push(...definitionsIn(parsed, path.relative(REPO_ROOT, full).replace(/\\/g, '/')))
    }
  }
  cache = out
  return out
}
