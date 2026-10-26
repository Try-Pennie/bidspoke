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

/**
 * Every file an entry reaches, following workspace packages through the
 * lockfile's links as the fingerprint does: the runtime entry reaches
 * @bidspoke/slack-client through the Slack actions (#2337). The schema entry is
 * walked without links, so a workspace import there is refused by name.
 */
function linkedGraph(entry: string): string[] {
  const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
  return collectModuleImports(entry, {
    root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
    linkOf: (importer, name) => linkedPath(lock, importer, name),
  }).files
}

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

  it("folds the Slack action's whole reach into its fingerprint: the slack-client source and the library's pinned version (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const reached = collectModuleImports(path.join(SHIPPED.actionsDir, 'slack.send-message.v1.ts'), {
      root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
      linkOf: (importer, name) => linkedPath(lock, importer, name),
    })
    expect(reached.files).toContain(path.join(REPO_ROOT, 'packages/slack-client/src/index.ts'))
    expect(reached.files).toContain(path.join(SRC, 'runtime', 'slack', 'call.ts'))
    expect(reached.packages).toEqual([expect.objectContaining({ name: 'slack-web-api-client', importer: 'packages/slack-client' })])
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/slack-client/package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(resolveDependencies(lock, reached.packages).closure).toContain(`slack-web-api-client@${manifest.dependencies['slack-web-api-client']}`)
  })

  it("folds each OpenAI action's shared request code into its fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const openaiActions = RUNTIME_ACTIONS.filter((a) => a.key.startsWith('openai.'))
    expect(openaiActions).toHaveLength(6)
    for (const a of openaiActions) {
      const reached = collectModuleImports(path.join(SHIPPED.actionsDir, `${a.key}.v${a.version}.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'openai', 'call.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'failure.ts'))
      expect(reached.packages, a.key).toEqual([])
    }
  })

  it("folds the Anthropic action's request code into its fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const reached = collectModuleImports(path.join(SHIPPED.actionsDir, 'anthropic.chat.v1.ts'), {
      root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
      linkOf: (importer, name) => linkedPath(lock, importer, name),
    })
    expect(reached.files).toContain(path.join(SRC, 'runtime', 'anthropic', 'call.ts'))
    expect(reached.files).toContain(path.join(SRC, 'runtime', 'failure.ts'))
    expect(reached.packages).toEqual([])
  })

  it("folds the money path's Salesforce rules into each Salesforce action's fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const salesforceActions = RUNTIME_ACTIONS.filter((a) => a.key.startsWith('salesforce.'))
    expect(salesforceActions).toHaveLength(10)
    for (const a of salesforceActions) {
      const reached = collectModuleImports(path.join(SHIPPED.actionsDir, `${a.key}.v${a.version}.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      // The URLs, the API version and the failure rule are @bidspoke/salesforce-api's, the money path's own (#2393).
      expect(reached.files, a.key).toContain(path.join(REPO_ROOT, 'packages/salesforce-api/src/index.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'salesforce', 'call.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'failure.ts'))
      expect(reached.packages, a.key).toEqual([])
    }
  })

  it("folds each Google action's shared request code into its fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const googleActions = RUNTIME_ACTIONS.filter((a) => a.key.startsWith('google.'))
    // Sixteen actions, the two Drive ones in a second version too (#2805).
    expect(googleActions).toHaveLength(18)
    for (const a of googleActions) {
      const reached = collectModuleImports(path.join(SHIPPED.actionsDir, `${a.key}.v${a.version}.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'google', 'call.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'failure.ts'))
      expect(reached.packages, a.key).toEqual([])
    }
    const send = collectModuleImports(path.join(SHIPPED.actionsDir, 'google.gmail-send-email.v1.ts'), {
      root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
      linkOf: (importer, name) => linkedPath(lock, importer, name),
    })
    expect(send.files).toContain(path.join(SRC, 'runtime', 'google', 'mime.ts'))
    // The drive list rule the version 2 Drive actions share is folded into each one's fingerprint (#2805).
    for (const key of ['google.drive-list-files', 'google.drive-download-file']) {
      const v2 = collectModuleImports(path.join(SHIPPED.actionsDir, `${key}.v2.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      expect(v2.files, key).toContain(path.join(SRC, 'runtime', 'google', 'drive.ts'))
    }
  })

  it("folds each HTTP action's request code and the host rule into its fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const httpActions = RUNTIME_ACTIONS.filter((a) => a.key.startsWith('http.'))
    expect(httpActions).toHaveLength(2)
    for (const a of httpActions) {
      const reached = collectModuleImports(path.join(SHIPPED.actionsDir, `${a.key}.v${a.version}.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'http', 'call.ts'))
      // The host rule decides where a step may send, so changing it moves every HTTP action's fingerprint.
      expect(reached.files, a.key).toContain(path.join(SRC, 'schema', 'http-host.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'failure.ts'))
      expect(reached.packages, a.key).toEqual([])
    }
  })

  it("folds each Supabase action's request code and the project rule into its fingerprint, and imports no npm package (#2337)", () => {
    const lock = readImporterLock(SHIPPED.lockfile, SHIPPED.importer)
    const supabaseActions = RUNTIME_ACTIONS.filter((a) => a.key.startsWith('supabase.'))
    expect(supabaseActions).toHaveLength(3)
    for (const a of supabaseActions) {
      const reached = collectModuleImports(path.join(SHIPPED.actionsDir, `${a.key}.v${a.version}.ts`), {
        root: { importer: SHIPPED.importer, dir: PACKAGE_ROOT },
        linkOf: (importer, name) => linkedPath(lock, importer, name),
      })
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'supabase', 'call.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'schema', 'supabase-project.ts'))
      expect(reached.files, a.key).toContain(path.join(SRC, 'runtime', 'failure.ts'))
      expect(reached.packages, a.key).toEqual([])
    }
  })

  it('carries no test fixture action', () => {
    expect(catalogueActions(CATALOGUE).filter((a) => a.key.startsWith('fixture.'))).toEqual([])
    expect(RUNTIME_ACTIONS.filter((a) => a.key.startsWith('fixture.'))).toEqual([])
    for (const entry of ['schema/index.ts', 'runtime/index.ts']) {
      const reached = linkedGraph(path.join(SRC, entry)).filter(inside(path.join(SRC, '__fixtures__')))
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
    const runtimeGraph = linkedGraph(path.join(SRC, 'runtime', 'index.ts'))
    expect(runtimeGraph).toContain(path.join(SRC, 'runtime', 'registry.ts'))
    expect(runtimeGraph).toContain(path.join(REPO_ROOT, 'packages', 'slack-client', 'src', 'index.ts'))
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
