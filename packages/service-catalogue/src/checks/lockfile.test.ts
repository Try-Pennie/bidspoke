import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LockfileError, parseLockfileImporters, readImporterLock, resolveDependencyVersions } from './lockfile'

/**
 * The narrow pnpm-lock.yaml reader the action fingerprint takes npm versions
 * from (#2337). It reads only the importers section, and refuses anything it
 * does not recognise, because a misread lockfile would fingerprint the wrong
 * versions and pass.
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
    expect(readImporterLock(write(LOCK), 'packages/service-catalogue').versions.get('fsevents')).toBe('2.3.3')
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

describe('resolveDependencyVersions', () => {
  const lock = { importer: 'packages/service-catalogue', versions: parseLockfileImporters(LOCK).get('packages/service-catalogue')! }

  it('returns the resolved version of each package, sorted by name', () => {
    expect(
      resolveDependencyVersions(lock, [
        { name: 'fsevents', importedBy: 'run.ts' },
        { name: '@scope/client', importedBy: 'helper.ts' },
      ]),
    ).toEqual([
      { name: '@scope/client', version: '1.1.14' },
      { name: 'fsevents', version: '2.3.3' },
    ])
  })

  it('refuses a package the lockfile does not resolve, naming it and the file that imports it', () => {
    try {
      resolveDependencyVersions(lock, [{ name: 'left-pad', importedBy: 'helper.ts' }])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('left-pad')
      expect((err as Error).message).toContain('helper.ts')
    }
  })

  it('points a bare Node built in at its node: name', () => {
    try {
      resolveDependencyVersions(lock, [{ name: 'crypto', importedBy: 'run.ts' }])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('node:crypto')
    }
  })

  it('refuses a package resolved to a local path, whose source no version pins', () => {
    expect(
      codeOf(() =>
        resolveDependencyVersions(lock, [{ name: 'local-thing', importedBy: 'run.ts' }]),
      ),
    ).toBe('dependency_unresolved')
  })
})
