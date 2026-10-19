import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CATALOGUE, catalogueActions } from './schema'
import { RUNTIME_ACTIONS } from './runtime'
import { checkCatalogue, scanForIdempotentHints } from './checks/catalogue-checks'
import { collectModuleGraph, collectModuleImports } from './checks/module-graph'
import { linkedPath, readImporterLock, resolveDependencies } from './checks/lockfile'
import fingerprints from './fingerprints.json'

/**
 * The shipped catalogue, held to the same checks the fixture proves can fail
 * (checks/catalogue-checks.test.ts). Each service PR adds its actions to
 * CATALOGUE and RUNTIME_ACTIONS, its run files under runtime/actions, and their
 * fingerprints to fingerprints.json; nothing here changes.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.dirname(SRC)
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..')

const SHIPPED = {
  label: 'shipped',
  services: CATALOGUE,
  runtime: RUNTIME_ACTIONS,
  fingerprints: fingerprints as Readonly<Record<string, string>>,
  actionsDir: path.join(SRC, 'runtime', 'actions'),
  packageRoot: PACKAGE_ROOT,
  lockfile: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
  importer: path.relative(REPO_ROOT, PACKAGE_ROOT).split(path.sep).join('/'),
}

const inside = (dir: string) => (file: string) => file.startsWith(dir + path.sep)

describe('the shipped catalogue', () => {
  it('passes every catalogue check: versions, fingerprints, traits and pairing', async () => {
    expect(await checkCatalogue(SHIPPED)).toEqual([])
  })

  it('reads its npm versions from the repository lockfile, under this package', () => {
    // The catalogue check reads the lockfile even with no actions, so a wrong
    // path fails the test above; this proves the read finds real entries.
    expect(SHIPPED.importer).toBe('packages/service-catalogue')
    expect(readImporterLock(SHIPPED.lockfile, SHIPPED.importer).versions.get('typescript')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("reads the repository lockfile's snapshots, so a package's closure is its real one", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const { closure } = resolveDependencies(lock, [{ name: '@eslint/js', importedBy: 'probe', importer: SHIPPED.importer }])
    // @eslint/js reaches eslint as its peer, and eslint reaches estraverse through esquery.
    expect(closure.some((key) => key.startsWith('eslint@'))).toBe(true)
    expect(closure.some((key) => key.startsWith('estraverse@'))).toBe(true)
    expect(closure.length).toBeGreaterThan(50)
  })

  it("follows a real workspace link into the package's source and reads its npm imports under its own importer", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const probe = path.join(mkdtempSync(path.join(tmpdir(), 'catalogue-probe-')), 'run.ts')
    writeFileSync(probe, "import { createSlackClient } from '@bidspoke/slack-client'\nexport const run = createSlackClient\n")
    const { files, packages } = collectModuleImports(probe, {
      root: { importer: 'apps/worker', dir: path.join(REPO_ROOT, 'apps/worker') },
      linkOf: (importer, name) => linkedPath(lock, importer, name),
    })
    expect(files).toContain(path.join(REPO_ROOT, 'packages/slack-client/src/index.ts'))
    expect(packages).toContainEqual(expect.objectContaining({ name: 'slack-web-api-client', importer: 'packages/slack-client' }))
    expect(resolveDependencies(lock, packages).closure.some((key) => key.startsWith('slack-web-api-client@'))).toBe(true)
  })

  it('carries no test fixture action', () => {
    expect(catalogueActions(CATALOGUE).filter((a) => a.key.startsWith('fixture.'))).toEqual([])
    expect(RUNTIME_ACTIONS.filter((a) => a.key.startsWith('fixture.'))).toEqual([])
    for (const entry of ['schema/index.ts', 'runtime/index.ts']) {
      const reached = collectModuleGraph(path.join(SRC, entry)).filter(inside(path.join(SRC, '__fixtures__')))
      expect(reached, `${entry} reaches the test fixtures`).toEqual([])
    }
  })

  it('never takes idempotent from a Pipedream annotation', () => {
    expect(scanForIdempotentHints(SRC)).toEqual([])
  })
})

describe('the schema entry stays declarative', () => {
  // The web bundle, the validator and the MCP tool import `schema`; only the
  // Workers import `runtime`. apps/web guards its own imports
  // (service-catalogue-runtime-stays-out-of-web.test.ts); this guards the other
  // half, that `schema` cannot pull runtime code in behind them.
  it('never reaches a runtime module', () => {
    const graph = collectModuleGraph(path.join(SRC, 'schema', 'index.ts'))
    expect(graph.filter(inside(path.join(SRC, 'runtime')))).toEqual([])
  })

  it('walks a real graph, so the check above cannot pass on an empty one', () => {
    const schemaGraph = collectModuleGraph(path.join(SRC, 'schema', 'index.ts'))
    expect(schemaGraph).toContain(path.join(SRC, 'schema', 'lookup.ts'))
    const runtimeGraph = collectModuleGraph(path.join(SRC, 'runtime', 'index.ts'))
    expect(runtimeGraph).toContain(path.join(SRC, 'runtime', 'registry.ts'))
  })

  it('exposes exactly the two entry points, with no root entry that would carry both', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
    }
    expect(manifest.exports).toEqual({
      './schema': './src/schema/index.ts',
      './runtime': './src/runtime/index.ts',
    })
  })
})
