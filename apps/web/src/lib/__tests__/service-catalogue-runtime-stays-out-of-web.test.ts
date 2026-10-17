import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, listFiles, workspacePackages } from './_scan-utils'

/**
 * The web bundle never imports the service catalogue's runtime entry (#2337,
 * #1689 section 3.0).
 *
 * `@bidspoke/service-catalogue` has two entry points. `schema` is declarative
 * and is what the canvas, the validator and the MCP tool read. `runtime` holds
 * every action's `run` and the services' auth functions, and is imported only by
 * the Workers. A web import of `runtime` would ship server request code (and,
 * once Phase 5 lands, auth handling) to every browser, and nothing else would
 * notice: the bundle builds either way.
 *
 * Scanned: every non test source file under apps/web/src, and under the src of
 * every workspace package apps/web depends on, followed transitively through
 * their own `workspace:` dependencies, because a package web imports is in the
 * bundle too. The catalogue package itself is not scanned here: its schema entry
 * reaching runtime code is refused by its own suite
 * (packages/service-catalogue/src/catalogue.test.ts), so the two halves together
 * cover the path from web into runtime.
 *
 * Every import form counts, a type only import included: the schema entry is
 * where web is meant to get its types, so a type import of runtime is still the
 * wrong door.
 */

const CATALOGUE = '@bidspoke/service-catalogue'
const RUNTIME_SPECIFIER = new RegExp(`^${CATALOGUE.replace('/', '\\/')}\\/runtime(\\/|$)`)
const RUNTIME_PATH = /service-catalogue\/src\/runtime(\/|$)/

/** Every module specifier a file imports, re-exports, dynamically imports or requires. */
function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g
  return [...source.matchAll(pattern)].map((m) => m[2])
}

const importsRuntime = (spec: string) => RUNTIME_SPECIFIER.test(spec) || RUNTIME_PATH.test(spec)

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest

/** The workspace packages apps/web reaches, transitively, other than the catalogue itself. */
function webWorkspaceDeps(): string[] {
  const byName = new Map(workspacePackages().map((p) => [p.name, p.dir]))
  const seen = new Set<string>()
  const queue = [path.join(REPO_ROOT, 'apps/web')]
  const dirs: string[] = []
  while (queue.length > 0) {
    const dir = queue.shift()!
    const manifest = readManifest(dir)
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith('workspace:') || seen.has(name) || name === CATALOGUE) continue
      seen.add(name)
      const depDir = byName.get(name)
      if (!depDir) throw new Error(`apps/web reaches ${name}, which is not a workspace package this guard can find`)
      dirs.push(depDir)
      queue.push(depDir)
    }
  }
  return dirs
}

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function scannedFiles(): string[] {
  const files = listFiles(WEB_SRC, { exts: EXTS })
  for (const dir of webWorkspaceDeps()) {
    files.push(...listFiles(path.join(dir, 'src'), { exts: EXTS }))
  }
  return files
}

describe('apps/web never imports the service catalogue runtime entry (#2337)', () => {
  it('recognises every import form of the runtime entry, and not the schema entry', () => {
    const runtime = `${CATALOGUE}/runtime`
    const forms = [
      `import { RUNTIME_ACTIONS } from '${runtime}'`,
      `import type { RuntimeAction } from "${runtime}"`,
      `export * from '${runtime}'`,
      `import '${runtime}'`,
      `const m = await import('${runtime}')`,
      `const m = require('${runtime}/registry')`,
      `import { x } from '../../../../packages/service-catalogue/src/runtime/registry'`,
    ]
    for (const form of forms) {
      expect(specifiers(form).some(importsRuntime), form).toBe(true)
    }
    expect(specifiers(`import { CATALOGUE } from '${CATALOGUE}/schema'`).some(importsRuntime)).toBe(false)
    expect(specifiers(`import { x } from '${CATALOGUE}/runtimes'`).some(importsRuntime)).toBe(false)
  })

  it('scans the web source and the workspace packages web depends on, so it cannot pass on nothing', () => {
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.startsWith(path.join(WEB_SRC, 'app') + path.sep))).toBe(true)
    expect(webWorkspaceDeps().some((d) => d.endsWith(`${path.sep}workflow-definition`))).toBe(true)
  })

  it('finds no file that imports it', () => {
    const offenders = scannedFiles()
      .filter((file) => specifiers(readFileSync(file, 'utf8')).some(importsRuntime))
      .map((file) => path.relative(REPO_ROOT, file))
    expect(
      offenders,
      `these files import the catalogue runtime into the web bundle; import ${CATALOGUE}/schema instead`,
    ).toEqual([])
  })
})
