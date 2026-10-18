import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectModuleGraph, collectModuleImports, ModuleGraphError } from './module-graph'
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
  const lock = (versions: Iterable<[string, string]> = []): ImporterLock => ({ importer: IMPORTER, versions: new Map(versions) })
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
