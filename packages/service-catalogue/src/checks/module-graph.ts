import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The files a module reaches through its relative VALUE imports, transitively,
 * and the npm packages those files import (#2337). Two checks stand on it: the
 * version fingerprint covers an action's run file, everything it reaches, and
 * the resolved version of every npm package reached (lockfile.ts), and the
 * schema entry must reach nothing under runtime/.
 *
 * Type only imports (`import type`, `export type ... from`) are left out: they
 * are erased before anything runs, so they change no behaviour and pull nothing
 * into a bundle. Comments are blanked first, so a commented out import is not
 * read as one.
 *
 * Runtime built ins are left out by name: a `node:` or `cloudflare:` import is
 * versioned by the runtime and its compatibility date, not by the lockfile. Any
 * other bare specifier is an npm package, named by its package (`@scope/name`
 * or `name`, without a subpath), and the fingerprint refuses one the lockfile
 * does not resolve, so a bare `crypto` fails there rather than passing as a
 * built in. Any other scheme (`https:`, `npm:`) and a package internal `#`
 * import are refused here, since nothing pins what they load.
 *
 * What it does NOT cover, stated so nobody reads the fingerprint as more than it
 * is (L400): only the version of each package a run imports DIRECTLY is folded
 * in. The packages THAT package depends on are not, so a lockfile change to one
 * of them alone (pnpm moving a transitive dependency within its range) does not
 * move the fingerprint. A workspace package import (`@bidspoke/...`) is refused
 * outright rather than ignored, because that source lives in this repo and
 * changes with no version bump at all; extend this walker before a run needs one.
 */

export type ModuleGraphErrorCode = 'workspace_import' | 'unresolved_import' | 'unsupported_import'

export class ModuleGraphError extends Error {
  constructor(
    readonly code: ModuleGraphErrorCode,
    readonly file: string,
    readonly specifier: string,
  ) {
    super(
      code === 'workspace_import'
        ? `${file} imports the workspace package ${specifier}, whose source no fingerprint covers`
        : code === 'unsupported_import'
          ? `${file} imports ${specifier}, which is neither a relative file, a runtime built in nor an npm package the lockfile can pin`
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

/** Runtime built ins, left out by name: versioned by the runtime, not the lockfile. */
const BUILTIN_SCHEME = /^(node|cloudflare):/

/** `@scope/name/sub/path` to `@scope/name`, `name/sub` to `name`. */
const packageNameOf = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

const byName = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0)

export interface ModuleImports {
  /** Every file reached, the entry included, as sorted absolute paths. */
  readonly files: string[]
  /** Every npm package those files import for its value, sorted by name, with the first file found importing it. */
  readonly packages: Array<{ name: string; importedBy: string }>
}

/** Every file `entry` reaches, itself included, as sorted absolute paths. */
export function collectModuleGraph(entry: string): string[] {
  return collectModuleImports(entry).files
}

/** Every file `entry` reaches and every npm package those files import. */
export function collectModuleImports(entry: string): ModuleImports {
  const seen = new Set<string>()
  const packages = new Map<string, string>()
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
      } else if (BUILTIN_SCHEME.test(specifier)) {
        continue
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('#') || specifier.startsWith('/')) {
        throw new ModuleGraphError('unsupported_import', file, specifier)
      } else {
        const name = packageNameOf(specifier)
        if (!packages.has(name)) packages.set(name, file)
      }
    }
  }
  return {
    files: [...seen].sort(),
    packages: [...packages].sort(byName).map(([name, importedBy]) => ({ name, importedBy })),
  }
}
