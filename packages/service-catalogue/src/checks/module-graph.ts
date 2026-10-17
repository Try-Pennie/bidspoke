import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The files a module reaches through its relative VALUE imports, transitively
 * (#2337). Two checks stand on it: the version fingerprint covers an action's
 * run file and everything it reaches, and the schema entry must reach nothing
 * under runtime/.
 *
 * Type only imports (`import type`, `export type ... from`) are left out: they
 * are erased before anything runs, so they change no behaviour and pull nothing
 * into a bundle. Comments are blanked first, so a commented out import is not
 * read as one.
 *
 * What it does NOT cover, stated so nobody reads the fingerprint as more than it
 * is (L400): an npm or `node:` import is not followed, so a dependency bump in
 * the lockfile can change a run without moving its fingerprint. A workspace
 * package import (`@bidspoke/...`) is refused outright rather than ignored,
 * because that source lives in this repo and changes with no version bump at
 * all; extend this walker before a run needs one.
 */

export type ModuleGraphErrorCode = 'workspace_import' | 'unresolved_import'

export class ModuleGraphError extends Error {
  constructor(
    readonly code: ModuleGraphErrorCode,
    readonly file: string,
    readonly specifier: string,
  ) {
    super(
      code === 'workspace_import'
        ? `${file} imports the workspace package ${specifier}, whose source no fingerprint covers`
        : `${file} imports ${specifier}, which resolves to no file`,
    )
    this.name = 'ModuleGraphError'
  }
}

/** Blanks block and line comments, keeping line breaks. A `//` after a colon (a URL) is kept. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, lead: string) => lead)
}

/** The relative and bare specifiers a module imports for their values. */
export function valueImportSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const out: string[] = []
  // The span between the keyword and `from` may cross lines (a long import
  // list) but never another import or export keyword, so an `export type`
  // alias cannot swallow the value import written after it.
  const fromClause = /\b(?:import|export)\s+(type\s+)?(?:(?!\b(?:import|export)\b)[^'";])*?\bfrom\s*(['"])([^'"]+)\2/g
  for (const m of code.matchAll(fromClause)) {
    if (m[1]) continue
    out.push(m[3])
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) out.push(m[2])
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) out.push(m[2])
  return out
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile()

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
  return candidates.find(isFile) ?? null
}

/** Every file `entry` reaches, itself included, as sorted absolute paths. */
export function collectModuleGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [path.resolve(entry)]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    if (file.endsWith('.json')) continue
    for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier)
        if (!resolved) throw new ModuleGraphError('unresolved_import', file, specifier)
        queue.push(resolved)
      } else if (specifier.startsWith('@bidspoke/')) {
        throw new ModuleGraphError('workspace_import', file, specifier)
      }
    }
  }
  return [...seen].sort()
}
