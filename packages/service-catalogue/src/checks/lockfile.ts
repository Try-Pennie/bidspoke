import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'

/**
 * The resolved npm versions a released action's fingerprint folds in (#2337),
 * read from two sections of pnpm-lock.yaml: `importers`, the exact version each
 * workspace package's direct dependencies resolved to, and `snapshots`, what
 * each resolved package depends on in turn. Together they give a package's
 * whole dependency closure, so pnpm moving a transitive dependency within its
 * range moves the fingerprint too, not only a bump of the package imported.
 *
 * A hand written reader of those sections rather than a YAML library, so the
 * catalogue checks need no new dependency. It is narrow on purpose: any line in
 * either section that is not one of the shapes pnpm 9 writes there is refused
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

/** Every importer's resolved direct dependencies, and every snapshot's own dependencies, as keys. */
export interface LockfileModel {
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** Snapshot key (`name@version(peers)`) to the snapshot keys it depends on, optional ones included. */
  readonly snapshots: ReadonlyMap<string, readonly string[]>
}

/** The lockfile, read for one catalogue: its own importer's versions, and everything else. */
export interface ImporterLock extends LockfileModel {
  /** The importer key, the package's path from the lockfile's directory (`packages/service-catalogue`). */
  readonly importer: string
  readonly versions: ReadonlyMap<string, string>
}

/**
 * An npm package a module graph reaches, the first file found importing it, and
 * the importer that file belongs to: the workspace package whose lockfile entry
 * says which version it gets. Null when the walk was not told (collectModuleGraph
 * without links), which resolves against the catalogue's own importer.
 */
export interface ReachedPackage {
  readonly name: string
  readonly importedBy: string
  readonly importer: string | null
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

/**
 * The snapshot key a dependency reference points at: `name@version` for a
 * version (`10.6.0(jiti@2.7.0)` included), or the reference itself for an alias
 * (`string-width-cjs: string-width@4.2.3`). Null for anything else, a local path
 * among them, whose source no snapshot pins.
 */
export function snapshotKeyOf(name: string, ref: string): string | null {
  if (/^\d/.test(ref)) return `${name}@${ref}`
  if (/^(@[^@/\s]+\/[^@\s]+|[^@/\s][^@\s]*)@\d\S*$/.test(ref)) return ref
  return null
}

/** Every snapshot in a pnpm 9 lockfile, each mapped to the snapshot keys it depends on. */
export function parseLockfileSnapshots(text: string): Map<string, string[]> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const unreadable = (why: string) => new LockfileError('lockfile_unreadable', `pnpm-lock.yaml: ${why}`)
  const snapshots = new Map<string, string[]>()
  const start = lines.indexOf('snapshots:')
  if (start < 0) return snapshots

  let current: string[] | null = null
  let currentKey = ''
  let section: 'dependencies' | 'peers' | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!line.startsWith(' ')) break // the next top level key
    let m: RegExpExecArray | null
    if ((m = /^ {2}(\S.*?):( \{\})?$/.exec(line))) {
      currentKey = scalar(m[1])
      if (snapshots.has(currentKey)) throw unreadable(`the snapshot ${currentKey} is written twice`)
      current = []
      snapshots.set(currentKey, current)
      section = null
      continue
    }
    if (current && (m = /^ {4}(dependencies|optionalDependencies|transitivePeerDependencies):$/.exec(line))) {
      section = m[1] === 'transitivePeerDependencies' ? 'peers' : 'dependencies'
      continue
    }
    if (current && line === '    optional: true') {
      section = null
      continue
    }
    // A peer some dependency needs from above: already resolved inside the snapshot keys.
    if (current && section === 'peers' && /^ {6}- \S+$/.test(line)) continue
    if (current && section === 'dependencies' && (m = /^ {6}(\S.*?): (\S.*)$/.exec(line))) {
      const name = scalar(m[1])
      const ref = scalar(m[2])
      const key = snapshotKeyOf(name, ref)
      if (key === null) {
        throw unreadable(`the snapshot ${currentKey} depends on ${name} at ${ref}, which is neither a version nor an alias`)
      }
      current.push(key)
      continue
    }
    throw unreadable(`line ${i + 1}, in the snapshots section, is not a shape this reader understands: ${line.trim()}`)
  }
  return snapshots
}

/** Reads and parses `lockfile` once, returning the one importer a catalogue's run files belong to. */
export function readImporterLock(lockfile: string, importer: string): ImporterLock {
  let text: string
  try {
    text = readFileSync(lockfile, 'utf8')
  } catch (err) {
    throw new LockfileError('lockfile_unreadable', `${lockfile} could not be read: ${(err as Error).message}`)
  }
  const importers = parseLockfileImporters(text)
  const versions = importers.get(importer)
  if (!versions) {
    throw new LockfileError('lockfile_unreadable', `${lockfile} has no importer ${importer}, so no version of its dependencies is known`)
  }
  return { importer, versions, importers, snapshots: parseLockfileSnapshots(text) }
}

/** What a fingerprint folds in for the npm packages a run reaches. */
export interface ResolvedDependencies {
  /** Each package a reached file imports, with the version its own importer resolves, sorted. */
  readonly direct: Array<{ importer: string; name: string; version: string }>
  /** Every snapshot those packages reach through their own dependencies, themselves included, sorted. */
  readonly closure: string[]
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The resolved version of each package, looked up under the importer of the
 * file that imports it, and the dependency closure of all of them from the
 * snapshots section. A package its importer does not resolve is refused by
 * name, never left out, and so is one resolved to a local path (`link:`,
 * `file:`) that reached here unfollowed, and a dependency with no snapshot.
 */
export function resolveDependencies(lock: ImporterLock, packages: readonly ReachedPackage[]): ResolvedDependencies {
  const direct = new Map<string, { importer: string; name: string; version: string }>()
  const roots: Array<{ key: string; via: string }> = []
  for (const { name, importedBy, importer: owner } of packages) {
    const importer = owner ?? lock.importer
    const version = lock.importers.get(importer)?.get(name)
    if (version === undefined) {
      const builtin = builtinModules.includes(name) ? ` If it means the Node built in, import it as node:${name}.` : ''
      throw new LockfileError(
        'dependency_unresolved',
        `${importedBy} imports the npm package ${name}, which pnpm-lock.yaml does not resolve for ${importer}, ` +
          `so no fingerprint can pin its version. Add it to that package's dependencies.${builtin}`,
      )
    }
    if (/^(link|file|workspace):/.test(version)) {
      throw new LockfileError(
        'dependency_unresolved',
        `${importedBy} imports ${name}, which pnpm-lock.yaml resolves to ${version}, a local path whose source no version pins`,
      )
    }
    const key = snapshotKeyOf(name, version)
    if (key === null) {
      throw new LockfileError(
        'dependency_unresolved',
        `${importedBy} imports ${name}, which pnpm-lock.yaml resolves to ${version}, neither a version nor an alias`,
      )
    }
    direct.set(`${importer} ${name}`, { importer, name, version })
    roots.push({ key, via: name })
  }

  const closure = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const { key, via } = queue.shift()!
    if (closure.has(key)) continue
    const children = lock.snapshots.get(key)
    if (children === undefined) {
      throw new LockfileError(
        'dependency_unresolved',
        `${via} reaches ${key}, which the snapshots section of pnpm-lock.yaml does not hold, ` +
          'so no fingerprint can pin what it depends on',
      )
    }
    closure.add(key)
    for (const child of children) queue.push({ key: child, via })
  }

  return {
    direct: [...direct.values()].sort((a, b) => byString(a.importer, b.importer) || byString(a.name, b.name)),
    closure: [...closure].sort(byString),
  }
}

/**
 * The path `name` is linked to under `importer` (what follows `link:`), or
 * undefined when the lockfile resolves it any other way. The module graph
 * follows exactly these into a workspace package's source.
 */
export function linkedPath(lock: LockfileModel, importer: string, name: string): string | undefined {
  const version = lock.importers.get(importer)?.get(name)
  return version?.startsWith('link:') ? version.slice('link:'.length) : undefined
}
