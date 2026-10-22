/**
 * A worker test loads the Worker app while the file is collected, never inside
 * a test or a hook (#2619).
 *
 * The API (routes/api/index.ts) and the Worker entry (index.ts) each load about
 * 360 modules. Loaded inside a test, that load is charged to whichever test runs
 * first, against its 5 second limit: about half a second on a quiet laptop, 5 to
 * 8 seconds with a load average above 100. Measured on 2026-10-22 at a load of
 * about 118, the first tests of the route files held 56% of the worker suite's
 * test time, and incidents, connections-create and connections-reconnect-remove
 * timed out while passing alone. Files had begun working round it one by one with
 * a beforeAll and a 30 or 60 second limit.
 *
 * So:
 *  1. An import of either app module inside a function (a test, a hook, a helper
 *     a test calls) is an offender. A static import, or an `await import` at the
 *     top level of the file, loads it at collection.
 *  2. A file that fires the Worker's crons (`.scheduled(`) loads the entry through
 *     test-setup/load-worker.ts, which also loads every module a cron branch
 *     imports lazily, so the first test to fire a cron does not pay for those.
 *
 * Seen red on 2026-10-22 against each planted shape below, and against
 * incidents.test.ts with its import put back inside its request helper.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import ts from 'typescript'
import { REPO_ROOT, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'
import { parsedSource, sourceText } from '../../__tests__/_parsed-source'

const WORKER_ROOT = path.dirname(WORKER_SRC)
const APP_MODULES = new Set([path.join(WORKER_SRC, 'index.ts'), path.join(WORKER_SRC, 'routes/api/index.ts')])
const ENTRY = path.join(WORKER_SRC, 'index.ts')

const rel = (file: string) => path.relative(REPO_ROOT, file).replace(/\\/g, '/')

/** The worker source file a relative specifier names, or null. */
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (APP_MODULES.has(candidate)) return candidate
  }
  return null
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)

/** Everything wrong with how one test file loads the app; empty when nothing is. */
export function appLoadOffenders(file: string, source: string): string[] {
  if (!source.includes('index')) return []
  const sf = parsedSource(file, source)
  const out: string[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  let loadsEntry = false
  const visit = (node: ts.Node, inFunction: boolean) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const target = resolve(file, node.moduleSpecifier.text)
      const typeOnly = node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name
        && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)
      if (target === ENTRY && !typeOnly) loadsEntry = true
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const target = resolve(file, node.arguments[0].text)
      if (target) {
        if (target === ENTRY) loadsEntry = true
        if (inFunction) out.push(`${rel(file)}:${lineOf(node)} loads ${rel(target)} inside a function, so the test that first calls it pays for loading the app`)
      }
    }
    const nested = inFunction || isFunctionLike(node)
    ts.forEachChild(node, (child) => visit(child, nested))
  }
  visit(sf, false)
  if (loadsEntry && /\.scheduled\(/.test(source)) {
    out.push(`${rel(file)} fires the Worker's crons with the entry loaded directly: load it through test-setup/load-worker.ts, so the modules its crons import lazily are loaded too`)
  }
  return out
}

describe('worker tests load the app while the file is collected (#2619)', () => {
  const files = [WORKER_SRC, path.join(WORKER_ROOT, 'money-gate')]
    .flatMap((root) => listFiles(root, { exts: ['.ts'], skipDirs: ['node_modules'], includeTests: true }))
    .filter((f) => f.endsWith('.test.ts'))
  const offenders = files.flatMap((f) => appLoadOffenders(f, sourceText(f)))

  it('reads the worker\'s tests, and finds the app loaded both ways, so an empty list is a measurement (L1)', () => {
    expect(files.length).toBeGreaterThan(500)
    const incidents = path.join(WORKER_SRC, 'routes/api/__tests__/incidents.test.ts')
    expect(files).toContain(incidents)
    expect(sourceText(incidents)).toMatch(/^import api from '\.\.\/index'$/m)
    const daily = path.join(WORKER_SRC, '__tests__/scheduled-daily-ops-checks-dispatch.test.ts')
    expect(sourceText(daily)).toMatch(/await loadWorker\(\)/)
  })

  it('no test loads the app inside a function, and every file firing crons loads the entry through loadWorker', () => {
    expect(offenders).toEqual([])
  })

  describe('seen red on each planted shape', () => {
    const route = path.join(WORKER_SRC, 'routes/api/__tests__/planted.test.ts')
    const top = path.join(WORKER_SRC, '__tests__/planted.test.ts')

    it('the API loaded inside a request helper', () => {
      expect(appLoadOffenders(route, "async function get(p: string) {\n  const { default: api } = await import('../index')\n  return api.request(p)\n}\n"))
        .toEqual(['apps/worker/src/routes/api/__tests__/planted.test.ts:2 loads apps/worker/src/routes/api/index.ts inside a function, so the test that first calls it pays for loading the app'])
    })

    it('the API loaded in a beforeAll, with or without a longer limit', () => {
      expect(appLoadOffenders(route, "let api\nbeforeAll(async () => { api = (await import('../index')).default }, 60_000)\n")).toHaveLength(1)
    })

    it('the entry loaded inside a test', () => {
      expect(appLoadOffenders(top, "it('x', async () => { const worker = (await import('../index')).default })\n")).toHaveLength(1)
    })

    it('crons fired with the entry loaded directly, statically or at the top level', () => {
      expect(appLoadOffenders(top, "import worker from '../index'\nvoid worker.scheduled(e, env, ctx)\n")).toHaveLength(1)
      expect(appLoadOffenders(top, "const worker = (await import('../index')).default\nvoid worker.scheduled(e, env, ctx)\n")).toHaveLength(1)
    })

    it('but not the app loaded at collection, the entry through loadWorker, or a type only import', () => {
      expect(appLoadOffenders(route, "import api from '../index'\nasync function get(p: string) { return api.request(p) }\n")).toEqual([])
      expect(appLoadOffenders(top, "import type { Env } from '../index'\nconst { default: worker } = await loadWorker()\nvoid worker.scheduled(e, env, ctx)\n")).toEqual([])
      expect(appLoadOffenders(top, "import { type Env } from '../index'\nconst { default: worker } = await loadWorker()\nvoid worker.scheduled(e, env, ctx)\n")).toEqual([])
      expect(appLoadOffenders(top, "const worker = (await import('../index')).default\nworker.fetch(r)\n")).toEqual([])
    })
  })
})
