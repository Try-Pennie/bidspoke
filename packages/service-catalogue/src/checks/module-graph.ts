import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The files a module reaches through its relative VALUE imports and the
 * workspace packages it imports, transitively, and the npm packages those files
 * import (#2337). Two checks stand on it: the version fingerprint covers an
 * action's run file, everything it reaches, and the dependency closure of every
 * npm package reached (lockfile.ts), and the schema entry must reach nothing
 * under runtime/.
 *
 * What it does NOT cover, stated so nobody reads the fingerprint as more than it
 * is (L400): an npm package is pinned by the version the lockfile resolves, not
 * by its content's integrity hash, so it trusts the registry never to republish
 * a version (npm refuses to), and a `node:` or `cloudflare:` built in is not
 * pinned at all.
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
 * A workspace package (`@bidspoke/...`, or any package the lockfile links to a
 * local path) is FOLLOWED when the walk is given the lockfile's links: its
 * source lives in this repo and changes with no version bump at all, so the
 * files its package.json exports name join the graph as relative imports do,
 * and the npm packages those files import are recorded under that package's
 * own importer, the lockfile entry that says which version it gets. Each file
 * belongs to the package it was reached through, and a relative import that
 * leaves that package is refused, since its imports would then be read against
 * the wrong importer. Without links (the schema entry check) a workspace import
 * is refused by name rather than ignored.
 *
 * The dependency closure of each npm package, everything it depends on in turn,
 * is the lockfile's to give (lockfile.ts resolveDependencies), not this walk's.
 */

export type ModuleGraphErrorCode = 'workspace_import' | 'unresolved_import' | 'unsupported_import' | 'import_leaves_package'

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
          ? `${file} imports ${specifier}, which is neither a relative file, a runtime built in, a workspace package ` +
            'export naming one file, nor an npm package the lockfile can pin'
          : code === 'import_leaves_package'
            ? `${file} imports ${specifier}, which leaves the package it belongs to; import that package by name instead`
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

/** The workspace package a file belongs to: its lockfile importer key and its directory. */
export interface PackageOwner {
  readonly importer: string
  readonly dir: string
}

/** What the walk needs to follow workspace packages: where it starts, and the lockfile's links. */
export interface WorkspaceLinks {
  /** The package the entry file belongs to. */
  readonly root: PackageOwner
  /** The path `name` is linked to under `importer` (the part after `link:`), or undefined when it is not linked. */
  readonly linkOf: (importer: string, name: string) => string | undefined
}

export interface ModuleImports {
  /** Every file reached, the entry included, as sorted absolute paths. */
  readonly files: string[]
  /**
   * Every npm package those files import for its value, sorted by importer then
   * name, with the first file found importing it and the importer that file
   * belongs to (null when the walk was given no links).
   */
  readonly packages: Array<{ name: string; importedBy: string; importer: string | null }>
}

const inside = (dir: string, file: string) => file === dir || file.startsWith(dir + path.sep)

/**
 * The file a linked package's package.json names for `subpath` (`.` or
 * `./extra`): an `exports` string or a map of subpaths to one file each, else
 * `main` for the root. Conditions or patterns are refused rather than guessed.
 */
function packageEntry(dir: string, subpath: string, fromFile: string, specifier: string): string {
  let manifest: { exports?: unknown; main?: unknown }
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    throw new ModuleGraphError('unresolved_import', fromFile, specifier)
  }
  let target: unknown
  if (manifest.exports !== undefined) {
    const exportsField = manifest.exports
    target =
      typeof exportsField === 'string'
        ? subpath === '.'
          ? exportsField
          : undefined
        : exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
          ? (exportsField as Record<string, unknown>)[subpath]
          : null
  } else if (subpath === '.') {
    target = manifest.main
  }
  if (target === undefined) throw new ModuleGraphError('unresolved_import', fromFile, specifier)
  if (typeof target !== 'string' || !target.startsWith('./') || target.includes('*')) {
    throw new ModuleGraphError('unsupported_import', fromFile, specifier)
  }
  const file = path.resolve(dir, target)
  if (!inside(dir, file) || !isFile(file)) throw new ModuleGraphError('unresolved_import', fromFile, specifier)
  return file
}

const byOwnerThenName = (
  a: { name: string; importer: string | null },
  b: { name: string; importer: string | null },
) => {
  const ai = a.importer ?? ''
  const bi = b.importer ?? ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Every file `entry` reaches, itself included, as sorted absolute paths. */
export function collectModuleGraph(entry: string): string[] {
  return collectModuleImports(entry).files
}

/**
 * Every file `entry` reaches and every npm package those files import. Given
 * `links`, workspace packages are followed into their source (see the top of
 * this file); without, a `@bidspoke/` import is refused.
 */
export function collectModuleImports(entry: string, links?: WorkspaceLinks): ModuleImports {
  const owners = new Map<string, PackageOwner | null>()
  const packages = new Map<string, { name: string; importedBy: string; importer: string | null }>()
  const root: PackageOwner | null = links ? { importer: links.root.importer, dir: path.resolve(links.root.dir) } : null
  const queue: Array<{ file: string; owner: PackageOwner | null }> = [{ file: path.resolve(entry), owner: root }]
  while (queue.length > 0) {
    const { file, owner } = queue.shift()!
    if (owners.has(file)) continue
    owners.set(file, owner)
    if (file.endsWith('.json')) continue
    for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier)
        if (!resolved) throw new ModuleGraphError('unresolved_import', file, specifier)
        if (owner && !inside(owner.dir, resolved)) throw new ModuleGraphError('import_leaves_package', file, specifier)
        queue.push({ file: resolved, owner })
        continue
      }
      if (BUILTIN_SCHEME.test(specifier)) continue
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('#') || specifier.startsWith('/')) {
        throw new ModuleGraphError('unsupported_import', file, specifier)
      }
      const name = packageNameOf(specifier)
      if (!links || !owner) {
        if (specifier.startsWith('@bidspoke/')) throw new ModuleGraphError('workspace_import', file, specifier)
      } else {
        const link = links.linkOf(owner.importer, name)
        if (link !== undefined) {
          const linked: PackageOwner = {
            importer: path.posix.normalize(path.posix.join(owner.importer, link)),
            dir: path.resolve(owner.dir, link),
          }
          const subpath = `.${specifier.slice(name.length)}`
          queue.push({ file: packageEntry(linked.dir, subpath, file, specifier), owner: linked })
          continue
        }
      }
      const importer = owner?.importer ?? null
      const id = `${importer ?? ''} ${name}`
      if (!packages.has(id)) packages.set(id, { name, importedBy: file, importer })
    }
  }
  return {
    files: [...owners.keys()].sort(),
    packages: [...packages.values()].sort(byOwnerThenName),
  }
}
