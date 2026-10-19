import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectModuleGraph, collectModuleImports, ModuleGraphError, type WorkspaceLinks } from './module-graph'
import { computeFingerprint } from './fingerprint'
import { LockfileError, type ImporterLock } from './lockfile'
import type { ActionSchema } from '../schema/types'

/** A throwaway package root with the given files, relative path to source. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'catalogue-graph-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

const rel = (root: string, files: string[]) => files.map((f) => path.relative(root, f)).sort()

describe('collectModuleGraph', () => {
  it('follows relative value imports transitively, through index files and json', () => {
    const root = tree({
      'a.ts': "import { b } from './b'\nexport * from './dir'\nexport const a = () => import('./lazy')\n",
      'b.ts': "import data from './data.json'\nexport const b = data\n",
      'dir/index.ts': 'export const d = 1\n',
      'lazy.ts': 'export const l = 1\n',
      'data.json': '{}\n',
      'unrelated.ts': 'export const u = 1\n',
    })
    expect(rel(root, collectModuleGraph(path.join(root, 'a.ts')))).toEqual(
      ['a.ts', 'b.ts', 'data.json', 'dir/index.ts', 'lazy.ts'].sort(),
    )
  })

  it('leaves out type only imports, which change no behaviour', () => {
    const root = tree({
      'a.ts': "import type { T } from './types'\nexport type { U } from './more'\nexport const a = 1\n",
      'types.ts': 'export type T = 1\n',
      'more.ts': 'export type U = 1\n',
    })
    expect(rel(root, collectModuleGraph(path.join(root, 'a.ts')))).toEqual(['a.ts'])
  })

  it('still follows a value import written after an exported type alias', () => {
    const root = tree({
      'a.ts': "export type T = number\nimport { b } from './b'\nexport const a = b\n",
      'b.ts': 'export const b = 1\n',
    })
    expect(rel(root, collectModuleGraph(path.join(root, 'a.ts')))).toEqual(['a.ts', 'b.ts'])
  })

  it('ignores an import written inside a comment', () => {
    const root = tree({
      'a.ts': "// import { gone } from './gone'\n/* import './gone2' */\nexport const url = 'https://example.com'\n",
    })
    expect(rel(root, collectModuleGraph(path.join(root, 'a.ts')))).toEqual(['a.ts'])
  })

  it('refuses a workspace package import by name, since no fingerprint would cover its source', () => {
    const root = tree({ 'a.ts': "import { x } from '@bidspoke/uuidv7'\nexport const a = x\n" })
    expect(() => collectModuleGraph(path.join(root, 'a.ts'))).toThrow(ModuleGraphError)
    try {
      collectModuleGraph(path.join(root, 'a.ts'))
    } catch (err) {
      expect((err as ModuleGraphError).code).toBe('workspace_import')
    }
  })

  it('refuses a relative import it cannot resolve, rather than leaving it out', () => {
    const root = tree({ 'a.ts': "import { x } from './missing'\nexport const a = x\n" })
    try {
      collectModuleGraph(path.join(root, 'a.ts'))
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleGraphError)
      expect((err as ModuleGraphError).code).toBe('unresolved_import')
    }
  })
})

describe('collectModuleImports', () => {
  it('names every npm package the graph reaches, directly or through a relative import, by package name', () => {
    const root = tree({
      'run.ts': [
        "import { WebClient } from '@scope/client/web'",
        "import { helper } from './helper'",
        "import { createHash } from 'node:crypto'",
        "import { connect } from 'cloudflare:sockets'",
        "import type { Shape } from 'types-only'",
        'export const run = () => [WebClient, helper, createHash, connect]',
      ].join('\n'),
      'helper.ts': "import pad from 'left-pad'\nimport '@scope/client'\nexport const helper = () => import('lazy-pkg/sub/path')\nexport { pad }\n",
    })
    const { files, packages } = collectModuleImports(path.join(root, 'run.ts'))
    expect(rel(root, files)).toEqual(['helper.ts', 'run.ts'])
    expect(packages.map((p) => p.name)).toEqual(['@scope/client', 'lazy-pkg', 'left-pad'])
    expect(path.relative(root, packages.find((p) => p.name === 'left-pad')!.importedBy)).toBe('helper.ts')
  })

  it('refuses an import through any other scheme, or a package internal # import, rather than leaving it out', () => {
    for (const specifier of ['https://example.com/mod.js', 'npm:left-pad', '#internal']) {
      const root = tree({ 'a.ts': `import { x } from '${specifier}'\nexport const a = x\n` })
      try {
        collectModuleImports(path.join(root, 'a.ts'))
        throw new Error(`expected ${specifier} to be refused`)
      } catch (err) {
        expect(err).toBeInstanceOf(ModuleGraphError)
        expect((err as ModuleGraphError).code).toBe('unsupported_import')
      }
    }
  })
})

describe('collectModuleImports, following workspace packages through their lockfile links', () => {
  // A throwaway workspace: the catalogue at packages/cat, linked to packages/helper,
  // which is linked in turn to packages/deeper.
  const workspace = () =>
    tree({
      'packages/cat/run.ts': "import { help } from '@bidspoke/helper'\nimport { extra } from '@bidspoke/helper/extra'\nexport const run = () => [help, extra]\n",
      'packages/helper/package.json': JSON.stringify({ exports: { '.': './src/index.ts', './extra': './src/extra.ts' } }),
      'packages/helper/src/index.ts': "import { inner } from './inner'\nimport pad from 'left-pad'\nexport const help = () => [inner, pad]\n",
      'packages/helper/src/inner.ts': 'export const inner = 1\n',
      'packages/helper/src/extra.ts': "import { deep } from '@bidspoke/deeper'\nexport const extra = deep\n",
      'packages/helper/src/unused.ts': 'export const unused = 1\n',
      'packages/deeper/package.json': JSON.stringify({ main: './index.ts' }),
      'packages/deeper/index.ts': "import { WebClient } from '@scope/client'\nexport const deep = WebClient\n",
    })
  const LINKS: Record<string, Record<string, string>> = {
    'packages/cat': { '@bidspoke/helper': '../helper' },
    'packages/helper': { '@bidspoke/deeper': '../deeper' },
  }
  const linksFor = (root: string, links = LINKS): WorkspaceLinks => ({
    root: { importer: 'packages/cat', dir: path.join(root, 'packages/cat') },
    linkOf: (importer, name) => links[importer]?.[name],
  })

  it("follows a linked package into the files its exports name, and records each npm import under that package's importer", () => {
    const root = workspace()
    const { files, packages } = collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root))
    expect(rel(root, files)).toEqual(
      [
        'packages/cat/run.ts',
        'packages/deeper/index.ts',
        'packages/helper/src/extra.ts',
        'packages/helper/src/index.ts',
        'packages/helper/src/inner.ts',
      ].sort(),
    )
    expect(packages.map((p) => [p.name, p.importer])).toEqual([
      ['@scope/client', 'packages/deeper'],
      ['left-pad', 'packages/helper'],
    ])
  })

  it("records the entry package's own npm imports under its importer", () => {
    const root = tree({ 'packages/cat/run.ts': "import pad from 'left-pad'\nexport const run = pad\n" })
    const { packages } = collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root))
    expect(packages).toEqual([{ name: 'left-pad', importedBy: path.join(root, 'packages/cat/run.ts'), importer: 'packages/cat' }])
  })

  it('records an unlinked workspace package as a package, for the fingerprint to refuse by name', () => {
    const root = workspace()
    const { packages } = collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root, { 'packages/cat': {} }))
    expect(packages.map((p) => p.name)).toEqual(['@bidspoke/helper'])
  })

  it('refuses a subpath the linked package does not export, rather than guessing a file', () => {
    const root = workspace()
    writeFileSync(path.join(root, 'packages/cat/run.ts'), "import { x } from '@bidspoke/helper/unused'\nexport const run = x\n")
    try {
      collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root))
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleGraphError)
      expect((err as ModuleGraphError).code).toBe('unresolved_import')
    }
  })

  it('refuses an exports entry it cannot read as one file, such as a set of conditions', () => {
    const root = workspace()
    writeFileSync(
      path.join(root, 'packages/helper/package.json'),
      JSON.stringify({ exports: { '.': { import: './src/index.ts', require: './src/index.cjs' } } }),
    )
    try {
      collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root))
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleGraphError)
      expect((err as ModuleGraphError).code).toBe('unsupported_import')
    }
  })

  it("refuses a relative import that leaves its package, whose npm imports would be read against the wrong importer", () => {
    const root = tree({
      'packages/cat/run.ts': "import { x } from '../elsewhere/x'\nexport const run = x\n",
      'packages/elsewhere/x.ts': 'export const x = 1\n',
    })
    try {
      collectModuleImports(path.join(root, 'packages/cat/run.ts'), linksFor(root))
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ModuleGraphError)
      expect((err as ModuleGraphError).code).toBe('import_leaves_package')
    }
  })
})

describe('computeFingerprint', () => {
  const action: ActionSchema = {
    key: 'fixture.echo',
    name: 'Echo',
    version: 1,
    arguments: [{ key: 'text', type: 'text', required: true, allowsVariables: true, parseJson: false }],
    sideEffect: false,
    idempotent: true,
    idempotentBecause: 'It reads nothing and writes nothing.',
  }

  const IMPORTER = 'packages/service-catalogue'
  /** A lockfile with the given direct versions for the catalogue, and a leaf snapshot for each. */
  const lock = (versions: Iterable<[string, string]> = []): ImporterLock => {
    const own = new Map(versions)
    return {
      importer: IMPORTER,
      versions: own,
      importers: new Map([[IMPORTER, own]]),
      snapshots: new Map([...own].map(([name, version]) => [`${name}@${version}`, []])),
    }
  }
  const NO_DEPS = lock()

  it('changes when a helper the run imports changes, and not when a type file does', () => {
    const root = tree({
      'run.ts': "import type { T } from './types'\nimport { help } from './helper'\nexport const run = (x: T) => help(x)\n",
      'helper.ts': 'export const help = (x: number) => x + 1\n',
      'types.ts': 'export type T = number\n',
    })
    const runFile = path.join(root, 'run.ts')
    const before = computeFingerprint(action, runFile, root, NO_DEPS)
    writeFileSync(path.join(root, 'types.ts'), 'export type T = number // reworded\n')
    expect(computeFingerprint(action, runFile, root, NO_DEPS)).toBe(before)
    writeFileSync(path.join(root, 'helper.ts'), 'export const help = (x: number) => x + 2\n')
    expect(computeFingerprint(action, runFile, root, NO_DEPS)).not.toBe(before)
  })

  it('changes when the resolved version of a package a helper imports changes, and not for a package nothing imports', () => {
    const root = tree({
      'run.ts': "import { help } from './helper'\nexport const run = () => help()\n",
      'helper.ts': "import { WebClient } from '@scope/client'\nexport const help = () => new WebClient()\n",
    })
    const runFile = path.join(root, 'run.ts')
    const deps: Array<[string, string]> = [
      ['@scope/client', '1.1.14'],
      ['unrelated', '2.0.0'],
    ]
    const before = computeFingerprint(action, runFile, root, lock(deps))
    expect(computeFingerprint(action, runFile, root, lock([...deps, ['unrelated', '3.0.0']]))).toBe(before)
    expect(computeFingerprint(action, runFile, root, lock([...deps, ['@scope/client', '1.1.15']]))).not.toBe(before)
  })

  it('refuses a run reaching a package the lockfile does not resolve, naming it', () => {
    const root = tree({ 'run.ts': "import pad from 'left-pad'\nexport const run = () => pad\n" })
    try {
      computeFingerprint(action, path.join(root, 'run.ts'), root, NO_DEPS)
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(LockfileError)
      expect((err as LockfileError).code).toBe('dependency_unresolved')
      expect((err as Error).message).toContain('left-pad')
    }
  })

  describe('over a workspace package and the dependency closure', () => {
    // The catalogue at packages/service-catalogue, linked to packages/helper,
    // which imports @scope/client; @scope/client depends on inner, inner on leaf.
    const files = () =>
      tree({
        'packages/service-catalogue/run.ts': "import { help } from '@bidspoke/helper'\nexport const run = () => help()\n",
        'packages/helper/package.json': JSON.stringify({ exports: { '.': './src/index.ts' } }),
        'packages/helper/src/index.ts': "import { WebClient } from '@scope/client'\nexport const help = () => new WebClient()\n",
      })
    const workspaceLock = (edit: { client?: string; leaf?: string; unrelated?: string; link?: boolean } = {}): ImporterLock => {
      const client = edit.client ?? '1.1.14'
      const leaf = edit.leaf ?? '1.0.0'
      const own = new Map(edit.link === false ? [] : [['@bidspoke/helper', 'link:../helper']])
      return {
        importer: IMPORTER,
        versions: own,
        importers: new Map([
          [IMPORTER, own],
          ['packages/helper', new Map([['@scope/client', client]])],
        ]),
        snapshots: new Map<string, string[]>([
          [`@scope/client@${client}`, ['inner@2.0.0']],
          ['inner@2.0.0', [`leaf@${leaf}`]],
          [`leaf@${leaf}`, []],
          [`unrelated@${edit.unrelated ?? '3.0.0'}`, []],
        ]),
      }
    }
    const fingerprint = (root: string, l: ImporterLock) =>
      computeFingerprint(action, path.join(root, 'packages/service-catalogue/run.ts'), path.join(root, 'packages/service-catalogue'), l)

    it("changes when the workspace package's source changes", () => {
      const root = files()
      const before = fingerprint(root, workspaceLock())
      writeFileSync(path.join(root, 'packages/helper/src/index.ts'), "import { WebClient } from '@scope/client'\nexport const help = () => WebClient\n")
      expect(fingerprint(root, workspaceLock())).not.toBe(before)
    })

    it("changes when the workspace package's own npm dependency is upgraded", () => {
      const root = files()
      expect(fingerprint(root, workspaceLock({ client: '1.1.15' }))).not.toBe(fingerprint(root, workspaceLock()))
    })

    it('changes when a transitive dependency moves within its range, and not for a snapshot nothing reaches', () => {
      const root = files()
      const before = fingerprint(root, workspaceLock())
      expect(fingerprint(root, workspaceLock({ unrelated: '3.0.1' }))).toBe(before)
      expect(fingerprint(root, workspaceLock({ leaf: '1.0.1' }))).not.toBe(before)
    })

    it('refuses a workspace package the catalogue does not declare, by name', () => {
      try {
        fingerprint(files(), workspaceLock({ link: false }))
        throw new Error('expected a refusal')
      } catch (err) {
        expect(err).toBeInstanceOf(LockfileError)
        expect((err as LockfileError).code).toBe('dependency_unresolved')
        expect((err as Error).message).toContain('@bidspoke/helper')
      }
    })
  })

  it('does not depend on the order fields were written in, or on line endings', () => {
    const root = tree({ 'run.ts': 'export const run = 1\n' })
    const runFile = path.join(root, 'run.ts')
    const before = computeFingerprint(action, runFile, root, NO_DEPS)
    const reordered: ActionSchema = {
      idempotentBecause: action.idempotentBecause,
      idempotent: true,
      sideEffect: false,
      arguments: [{ parseJson: false, allowsVariables: true, required: true, type: 'text', key: 'text' }],
      version: 1,
      name: 'Echo',
      key: 'fixture.echo',
    }
    writeFileSync(runFile, 'export const run = 1\r\n')
    expect(computeFingerprint(reordered, runFile, root, NO_DEPS)).toBe(before)
  })

  it('is a sha256 hex digest', () => {
    const root = tree({ 'run.ts': 'export const run = 1\n' })
    expect(computeFingerprint(action, path.join(root, 'run.ts'), root, NO_DEPS)).toMatch(/^[0-9a-f]{64}$/)
  })
})
