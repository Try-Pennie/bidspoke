import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'

/**
 * The resolved npm versions a released action's fingerprint folds in (#2337),
 * read from the importers section of pnpm-lock.yaml: for each workspace
 * package, the exact version every direct dependency resolved to.
 *
 * A hand written reader of that one section rather than a YAML library, so the
 * catalogue checks need no new dependency. It is narrow on purpose: any line in
 * the section that is not one of the five shapes pnpm 9 writes there is refused
 * rather than skipped, and so is any lockfile format other than 9, because a
 * misread lockfile would fingerprint the wrong versions and pass (L98).
 */

export type LockfileErrorCode = 'lockfile_unreadable' | 'dependency_unresolved'

export class LockfileError extends Error {
  constructor(
    readonly code: LockfileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LockfileError'
  }
}

/** One workspace package's resolved dependency versions, by package name. */
export interface ImporterLock {
  /** The importer key, the package's path from the lockfile's directory (`packages/service-catalogue`). */
  readonly importer: string
  readonly versions: ReadonlyMap<string, string>
}

/** An npm package a module graph reaches, and the first file found importing it. */
export interface ReachedPackage {
  readonly name: string
  readonly importedBy: string
}

const SECTIONS = new Set(['dependencies', 'devDependencies', 'optionalDependencies'])

/** A YAML scalar as pnpm writes a key or version: bare, 'single quoted' or "double quoted". */
function scalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw) as string
  return raw
}

/** Every importer in a pnpm 9 lockfile, each mapping dependency name to resolved version. */
export function parseLockfileImporters(text: string): Map<string, Map<string, string>> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const unreadable = (why: string) => new LockfileError('lockfile_unreadable', `pnpm-lock.yaml: ${why}`)

  const versionLine = lines.find((l) => l.startsWith('lockfileVersion:'))
  const format = versionLine ? scalar(versionLine.slice('lockfileVersion:'.length).trim()) : null
  if (format === null || !/^9\.\d+$/.test(format)) {
    throw unreadable(`lockfile format ${format ?? '(none)'} is not 9.x, which is the only format this reader understands`)
  }
  const start = lines.indexOf('importers:')
  if (start < 0) throw unreadable('it has no importers section')

  const importers = new Map<string, Map<string, string>>()
  let importer: Map<string, string> | null = null
  let importerName = ''
  let inSection = false
  let dep: string | null = null
  let depHasVersion = false
  const closeDep = () => {
    if (dep !== null && !depHasVersion) throw unreadable(`${dep} under importer ${importerName} has no resolved version`)
    dep = null
    depHasVersion = false
  }

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!line.startsWith(' ')) break // the next top level key
    let m: RegExpExecArray | null
    if ((m = /^ {2}(\S.*?):( \{\})?$/.exec(line))) {
      closeDep()
      importerName = scalar(m[1])
      importer = new Map()
      importers.set(importerName, importer)
      inSection = false
      continue
    }
    if (importer && (m = /^ {4}(\w+):$/.exec(line)) && SECTIONS.has(m[1])) {
      closeDep()
      inSection = true
      continue
    }
    if (importer && inSection && (m = /^ {6}(\S.*?):$/.exec(line))) {
      closeDep()
      dep = scalar(m[1])
      continue
    }
    if (dep !== null && /^ {8}specifier: \S/.test(line)) continue
    if (importer && dep !== null && !depHasVersion && (m = /^ {8}version: (\S.*)$/.exec(line))) {
      const version = scalar(m[1])
      const earlier = importer.get(dep)
      if (earlier !== undefined && earlier !== version) {
        throw unreadable(`${dep} under importer ${importerName} resolves to both ${earlier} and ${version}`)
      }
      importer.set(dep, version)
      depHasVersion = true
      continue
    }
    throw unreadable(`line ${i + 1}, in the importers section, is not a shape this reader understands: ${line.trim()}`)
  }
  closeDep()
  return importers
}

/** Reads and parses `lockfile` once, returning the one importer a catalogue's run files belong to. */
export function readImporterLock(lockfile: string, importer: string): ImporterLock {
  let text: string
  try {
    text = readFileSync(lockfile, 'utf8')
  } catch (err) {
    throw new LockfileError('lockfile_unreadable', `${lockfile} could not be read: ${(err as Error).message}`)
  }
  const versions = parseLockfileImporters(text).get(importer)
  if (!versions) {
    throw new LockfileError('lockfile_unreadable', `${lockfile} has no importer ${importer}, so no version of its dependencies is known`)
  }
  return { importer, versions }
}

/**
 * The resolved version of each package, sorted by name. A package the importer
 * does not resolve is refused by name, never left out, and so is one resolved
 * to a local path (`link:`, `file:`), whose source no version pins.
 */
export function resolveDependencyVersions(
  lock: ImporterLock,
  packages: readonly ReachedPackage[],
): Array<{ name: string; version: string }> {
  const out = new Map<string, string>()
  for (const { name, importedBy } of packages) {
    const version = lock.versions.get(name)
    if (version === undefined) {
      const builtin = builtinModules.includes(name) ? ` If it means the Node built in, import it as node:${name}.` : ''
      throw new LockfileError(
        'dependency_unresolved',
        `${importedBy} imports the npm package ${name}, which pnpm-lock.yaml does not resolve for ${lock.importer}, ` +
          `so no fingerprint can pin its version. Add it to that package's dependencies.${builtin}`,
      )
    }
    if (/^(link|file|workspace):/.test(version)) {
      throw new LockfileError(
        'dependency_unresolved',
        `${importedBy} imports ${name}, which pnpm-lock.yaml resolves to ${version}, a local path whose source no version pins`,
      )
    }
    out.set(name, version)
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, version]) => ({ name, version }))
}
