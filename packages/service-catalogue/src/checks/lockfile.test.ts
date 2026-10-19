import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LockfileError,
  parseLockfileImporters,
  parseLockfileSnapshots,
  readImporterLock,
  resolveDependencies,
  type ImporterLock,
} from './lockfile'

/**
 * The narrow pnpm-lock.yaml reader the action fingerprint takes npm versions
 * from (#2337). It reads the importers section (what each workspace package's
 * direct dependencies resolved to) and the snapshots section (what each of
 * those depends on in turn), and refuses anything it does not recognise,
 * because a misread lockfile would fingerprint the wrong versions and pass.
 */

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      husky:
        specifier: ^9.1.7
        version: 9.1.7

  packages/empty: {}

  packages/service-catalogue:
    dependencies:
      '@scope/client':
        specifier: 1.1.14
        version: 1.1.14
      local-thing:
        specifier: workspace:*
        version: link:../local-thing
    devDependencies:
      '@eslint/js':
        specifier: ^10.0.1
        version: 10.0.1(eslint@10.6.0(jiti@2.7.0))
    optionalDependencies:
      fsevents:
        specifier: ^2.3.3
        version: 2.3.3

packages:

  husky@9.1.7:
    resolution: {integrity: sha512-x}

snapshots:

  '@eslint/js@10.0.1(eslint@10.6.0(jiti@2.7.0))':
    optionalDependencies:
      eslint: 10.6.0(jiti@2.7.0)

  '@scope/client@1.1.14':
    dependencies:
      inner: 2.0.0
      string-width-cjs: string-width@4.2.3
    transitivePeerDependencies:
      - supports-color

  eslint@10.6.0(jiti@2.7.0):
    dependencies:
      inner: 2.0.0
    optionalDependencies:
      jiti: 2.7.0

  fsevents@2.3.3:
    optional: true

  husky@9.1.7: {}

  inner@2.0.0:
    dependencies:
      leaf: 1.0.0

  jiti@2.7.0: {}

  leaf@1.0.0: {}

  string-width@4.2.3: {}

  unrelated@3.0.0: {}
`

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(LockfileError)
    return (err as LockfileError).code
  }
  throw new Error('expected a refusal')
}

describe('parseLockfileImporters', () => {
  it('reads every importer, across dependencies, devDependencies and optionalDependencies', () => {
    const importers = parseLockfileImporters(LOCK)
    expect([...importers.keys()]).toEqual(['.', 'packages/empty', 'packages/service-catalogue'])
    expect(importers.get('packages/empty')!.size).toBe(0)
    expect(Object.fromEntries(importers.get('packages/service-catalogue')!)).toEqual({
      '@scope/client': '1.1.14',
      'local-thing': 'link:../local-thing',
      '@eslint/js': '10.0.1(eslint@10.6.0(jiti@2.7.0))',
      fsevents: '2.3.3',
    })
  })

  it('refuses a lockfile format it was not written for', () => {
    expect(codeOf(() => parseLockfileImporters(LOCK.replace("'9.0'", "'10.0'")))).toBe('lockfile_unreadable')
    expect(codeOf(() => parseLockfileImporters(LOCK.replace("lockfileVersion: '9.0'\n", '')))).toBe('lockfile_unreadable')
  })

  it('refuses a lockfile with no importers section', () => {
    expect(codeOf(() => parseLockfileImporters("lockfileVersion: '9.0'\n"))).toBe('lockfile_unreadable')
  })

  it('refuses a line in the importers section it does not understand, rather than skipping it', () => {
    const odd = LOCK.replace('    optionalDependencies:', '    dependenciesMeta:\n      fsevents:\n        injected: true\n    optionalDependencies:')
    expect(codeOf(() => parseLockfileImporters(odd))).toBe('lockfile_unreadable')
    // A line no other rule would trip over: an unknown key beside a complete entry.
    const extraField = LOCK.replace('        version: 2.3.3\n', '        version: 2.3.3\n        dev: true\n')
    expect(codeOf(() => parseLockfileImporters(extraField))).toBe('lockfile_unreadable')
    const extraKey = LOCK.replace('  packages/empty: {}\n', '  packages/empty: {}\n    publishDirectory: dist\n')
    expect(codeOf(() => parseLockfileImporters(extraKey))).toBe('lockfile_unreadable')
  })

  it('refuses a dependency with no resolved version', () => {
    const noVersion = LOCK.replace('        version: 2.3.3\n', '')
    expect(codeOf(() => parseLockfileImporters(noVersion))).toBe('lockfile_unreadable')
  })
})

describe('readImporterLock', () => {
  const write = (text: string) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'catalogue-lock-')), 'pnpm-lock.yaml')
    writeFileSync(file, text)
    return file
  }

  it("returns one importer's resolved versions", () => {
    const lock = readImporterLock(write(LOCK), 'packages/service-catalogue')
    expect(lock.versions.get('fsevents')).toBe('2.3.3')
    expect(lock.importers.get('.')!.get('husky')).toBe('9.1.7')
    expect(lock.snapshots.get('inner@2.0.0')).toEqual(['leaf@1.0.0'])
  })

  it('refuses an importer the lockfile does not list, naming it', () => {
    try {
      readImporterLock(write(LOCK), 'packages/missing')
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('lockfile_unreadable')
      expect((err as Error).message).toContain('packages/missing')
    }
  })

  it('refuses a lockfile that is not there', () => {
    expect(codeOf(() => readImporterLock('/nonexistent/pnpm-lock.yaml', '.'))).toBe('lockfile_unreadable')
  })
})

describe('parseLockfileSnapshots', () => {
  it('reads each snapshot and the dependencies it resolves, optional ones included, aliases by their real name', () => {
    const snapshots = parseLockfileSnapshots(LOCK)
    expect(snapshots.get('@scope/client@1.1.14')).toEqual(['inner@2.0.0', 'string-width@4.2.3'])
    expect(snapshots.get('eslint@10.6.0(jiti@2.7.0)')).toEqual(['inner@2.0.0', 'jiti@2.7.0'])
    expect(snapshots.get('fsevents@2.3.3')).toEqual([])
    expect(snapshots.get('husky@9.1.7')).toEqual([])
    expect(snapshots.size).toBe(10)
  })

  it('reads an empty map from a lockfile with no snapshots section, so a package then fails by name', () => {
    expect(parseLockfileSnapshots("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n").size).toBe(0)
  })

  it('refuses a line in the snapshots section it does not understand, rather than skipping it', () => {
    const extraField = LOCK.replace('  jiti@2.7.0: {}\n', '  jiti@2.7.0:\n    hasBin: true\n')
    expect(codeOf(() => parseLockfileSnapshots(extraField))).toBe('lockfile_unreadable')
    const extraSection = LOCK.replace('  leaf@1.0.0: {}\n', '  leaf@1.0.0:\n    peerDependencies:\n      x: 1.0.0\n')
    expect(codeOf(() => parseLockfileSnapshots(extraSection))).toBe('lockfile_unreadable')
  })

  it('refuses a snapshot written twice', () => {
    const twice = LOCK.replace('  leaf@1.0.0: {}\n', '  leaf@1.0.0: {}\n\n  leaf@1.0.0: {}\n')
    expect(codeOf(() => parseLockfileSnapshots(twice))).toBe('lockfile_unreadable')
  })

  it('refuses a dependency whose reference is neither a version nor an alias', () => {
    const local = LOCK.replace('      leaf: 1.0.0\n', '      leaf: link:../leaf\n')
    expect(codeOf(() => parseLockfileSnapshots(local))).toBe('lockfile_unreadable')
  })
})

describe('resolveDependencies', () => {
  const IMPORTER = 'packages/service-catalogue'
  const lockOf = (text: string): ImporterLock => {
    const importers = parseLockfileImporters(text)
    return { importer: IMPORTER, versions: importers.get(IMPORTER)!, importers, snapshots: parseLockfileSnapshots(text) }
  }
  const lock = lockOf(LOCK)
  const reached = (name: string, importedBy = 'run.ts', importer: string | null = IMPORTER) => ({ name, importedBy, importer })

  it('returns the resolved version of each package, sorted by name', () => {
    expect(resolveDependencies(lock, [reached('fsevents'), reached('@scope/client', 'helper.ts')]).direct).toEqual([
      { importer: IMPORTER, name: '@scope/client', version: '1.1.14' },
      { importer: IMPORTER, name: 'fsevents', version: '2.3.3' },
    ])
  })

  it("returns every snapshot each package's dependencies reach, transitively and through aliases, once each", () => {
    expect(resolveDependencies(lock, [reached('@scope/client'), reached('@eslint/js')]).closure).toEqual([
      '@eslint/js@10.0.1(eslint@10.6.0(jiti@2.7.0))',
      '@scope/client@1.1.14',
      'eslint@10.6.0(jiti@2.7.0)',
      'inner@2.0.0',
      'jiti@2.7.0',
      'leaf@1.0.0',
      'string-width@4.2.3',
    ])
  })

  it('moves the closure when a transitive dependency moves, and not for a snapshot nothing reaches', () => {
    const before = resolveDependencies(lock, [reached('@scope/client')]).closure
    const unrelated = lockOf(LOCK.replace('  unrelated@3.0.0: {}', '  unrelated@3.0.1: {}'))
    expect(resolveDependencies(unrelated, [reached('@scope/client')]).closure).toEqual(before)
    const bumped = lockOf(LOCK.replace('      leaf: 1.0.0', '      leaf: 1.0.1').replace('  leaf@1.0.0: {}', '  leaf@1.0.1: {}'))
    expect(resolveDependencies(bumped, [reached('@scope/client')]).closure).toContain('leaf@1.0.1')
  })

  it('refuses a dependency the snapshots section does not hold, naming the package that reaches it', () => {
    try {
      resolveDependencies(lockOf(LOCK.replace('  leaf@1.0.0: {}\n', '')), [reached('@scope/client')])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('leaf@1.0.0')
      expect((err as Error).message).toContain('@scope/client')
    }
  })

  it("looks a package up under the importer of the file that imports it, not the catalogue's", () => {
    const text = LOCK.replace(
      '  packages/empty: {}\n',
      "  packages/empty:\n    dependencies:\n      unrelated:\n        specifier: ^3.0.0\n        version: 3.0.0\n",
    )
    const other = lockOf(text)
    expect(resolveDependencies(other, [reached('unrelated', 'helper.ts', 'packages/empty')]).direct).toEqual([
      { importer: 'packages/empty', name: 'unrelated', version: '3.0.0' },
    ])
    expect(codeOf(() => resolveDependencies(other, [reached('unrelated')]))).toBe('dependency_unresolved')
    expect(codeOf(() => resolveDependencies(other, [reached('unrelated', 'helper.ts', 'packages/missing')]))).toBe(
      'dependency_unresolved',
    )
  })

  it('refuses a package the lockfile does not resolve, naming it and the file that imports it', () => {
    try {
      resolveDependencies(lock, [reached('left-pad', 'helper.ts')])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('left-pad')
      expect((err as Error).message).toContain('helper.ts')
    }
  })

  it('points a bare Node built in at its node: name', () => {
    try {
      resolveDependencies(lock, [reached('crypto')])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('node:crypto')
    }
  })

  it('refuses a package resolved to a local path that the walker did not follow', () => {
    expect(codeOf(() => resolveDependencies(lock, [reached('local-thing')]))).toBe('dependency_unresolved')
  })
})
