import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

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
 * Type only imports (`import type`, `export type ... from`, a list of `type`
 * names alone) are left out: they are erased before anything runs, so they
 * change no behaviour and pull nothing into a bundle. Imports are read by the
 * TypeScript parser (#2878), so an import written in a comment, a string or a
 * template literal is not read as one, and comment shaped text in a string
 * cannot hide a real one.
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

/** True when every named binding of an import or export list is marked `type`, so the whole statement is erased. */
const allMarkedType = (elements: ts.NodeArray<ts.ImportSpecifier> | ts.NodeArray<ts.ExportSpecifier>) =>
  elements.length > 0 && elements.every((element) => element.isTypeOnly)

/** An import or export clause that names only types: `import type`, `export type`, or a list of `type` names alone. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  return !clause.name && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && allMarkedType(clause.namedBindings.elements)
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  return node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allMarkedType(node.exportClause.elements)
}

const literalText = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

/**
 * The relative and bare specifiers a module imports for their values, in
 * source order, read by the TypeScript parser (#2878) so that text inside a
 * string, a template literal, a regex literal or a comment is never read as an
 * import and a comment shaped string never hides one. `file` names the file for
 * the language it is parsed as (from its extension) and for any refusal.
 *
 * A value import is a side effect import, an `import` or `export ... from`
 * naming at least one value (or nothing at all, `import {} from`, which still
 * loads the module), `export *`, `import x = require(...)`, and a dynamic
 * `import(...)` anywhere in the file. A dynamic import of anything but a plain
 * string is refused, since nothing can say which file it loads. A type
 * position `import('./x')` names a type and loads nothing, so it is left out.
 *
 * A list of `type` names alone (`import { type A } from`) is left out because
 * TypeScript and esbuild erase it whole while `verbatimModuleSyntax` is off,
 * which catalogue.test.ts holds for every package an action reaches.
 */
export function valueImportSpecifiers(source: string, file = 'module.ts'): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined && !isTypeOnlyImport(node)) out.push(specifier)
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined && !isTypeOnlyExport(node)) out.push(specifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = literalText(node.moduleReference.expression)
        if (specifier !== undefined) out.push(specifier)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      const specifier = literalText(argument)
      if (specifier === undefined) {
        throw new ModuleGraphError('unsupported_import', file, argument ? argument.getText(parsed) : '')
      }
      out.push(specifier)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
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
    for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'), file)) {
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
