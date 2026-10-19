/**
 * The OPS_CONNECTIONS binding never sits on the money path (#2335, PR 9 of
 * phase 5 of #1689; Hard Rule 1: ops work never degrades bidding).
 *
 * The bidding Worker binds the ops Worker's OpsConnections entrypoint for the
 * Connections routes. A call through it waits on another Worker, up to 50 s, so
 * a bid that reached it could be held by a slow or failing ops Worker. This scan
 * fails on any route by which money code could reach it:
 *
 *  1. The binding is named only where it is declared (env.ts) and where it is
 *     called (lib/ops-connections-client.ts, which races every call against a
 *     deadline). Anything else, a string key included, is an offender.
 *  2. Nothing the money path loads at RUN time reaches the client, directly or
 *     through any chain of imports. The money path is the engine, the nodes, the
 *     Durable Objects and the webhook, shadow and custom endpoint routes; the
 *     closure follows every relative import that survives compilation (a type
 *     only import is erased, so it carries nothing to run).
 *  3. The client is imported only by the modules listed below, each with its
 *     reason, so a new caller is a decision someone wrote down.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { listTsFiles, sanitizeSource, WORKER_SRC } from '../../__tests__/_scan-utils'

const CLIENT = path.join(WORKER_SRC, 'lib/ops-connections-client.ts')
const ENV = path.join(WORKER_SRC, 'env.ts')

/** Where the binding may be named. */
const BINDING_NAMED_IN = new Set([ENV, CLIENT])

/** Who may import the client, and why. Never anything the money path loads. */
const CLIENT_IMPORTERS: Record<string, string> = {
  [path.join(WORKER_SRC, 'routes/api/ops-connections-probe.ts')]: 'the deploy probe: one call ops refuses by name, for a signed in caller',
}

/** The money path: every module here, and everything it loads, must never reach the binding. */
export function moneyRoots(files: string[]): string[] {
  const under = (dir: string) => (f: string) => f.startsWith(path.join(WORKER_SRC, dir) + path.sep)
  const named = new Set(['routes/webhooks.ts', 'routes/shadow.ts', 'routes/custom-endpoint.ts'].map((f) => path.join(WORKER_SRC, f)))
  return files.filter((f) => under('engine')(f) || under('durable-objects')(f) || named.has(f))
}

type Reader = (file: string) => string | undefined

const diskReader: Reader = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

/** A relative specifier resolved to a worker source file, the way the bundler resolves it. */
function resolveRelative(from: string, specifier: string, read: Reader): string | null {
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && read(candidate) !== undefined) return candidate
  }
  return null
}

/** The relative modules a file loads at run time: type only imports and exports are erased, so they are skipped. */
export function runtimeImports(file: string, read: Reader): string[] {
  const src = read(file)
  if (src === undefined) return []
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const typeOnly = clause !== undefined && (clause.isTypeOnly || (
        clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)
      ))
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly))
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specifiers.filter((s) => s.startsWith('.')).map((s) => resolveRelative(file, s, read)).filter((f): f is string => f !== null)
}

/** For each module the roots load at run time, the chain of imports that reaches it. */
export function runtimeClosure(roots: string[], read: Reader): Map<string, string[]> {
  const chains = new Map<string, string[]>()
  const queue: string[] = []
  for (const root of roots) {
    if (!chains.has(root)) { chains.set(root, [root]); queue.push(root) }
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const next of runtimeImports(file, read)) {
      if (chains.has(next)) continue
      chains.set(next, [...chains.get(file)!, next])
      queue.push(next)
    }
  }
  return chains
}

const rel = (file: string) => path.relative(WORKER_SRC, file)

/** Every way the binding could be reached from where it must not be. Empty when it cannot. */
export function offenders(files: string[], read: Reader = diskReader): string[] {
  const out: string[] = []
  for (const file of files) {
    const raw = read(file)
    if (raw === undefined) continue
    const src = sanitizeSource(raw, { blankStrings: false })
    if (!BINDING_NAMED_IN.has(file)) {
      for (const m of src.matchAll(/\bOPS_CONNECTIONS\b/g)) {
        out.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length} names the OPS_CONNECTIONS binding outside lib/ops-connections-client.ts`)
      }
    }
    if (file !== CLIENT && !Object.hasOwn(CLIENT_IMPORTERS, file) && runtimeImports(file, read).includes(CLIENT)) {
      out.push(`${rel(file)} imports lib/ops-connections-client.ts and is not a listed caller`)
    }
  }
  const closure = runtimeClosure(moneyRoots(files), read)
  const chain = closure.get(CLIENT)
  if (chain) out.push(`the money path reaches lib/ops-connections-client.ts: ${chain.map(rel).join(' -> ')}`)
  return out
}

describe('OPS_CONNECTIONS never sits on the money path (Hard Rule 1)', () => {
  const files = listTsFiles(WORKER_SRC)

  it('finds what it scans, so it cannot pass on nothing', () => {
    expect(files).toContain(CLIENT)
    expect(files).toContain(ENV)
    for (const importer of Object.keys(CLIENT_IMPORTERS)) expect(files, rel(importer)).toContain(importer)
    const roots = moneyRoots(files)
    for (const f of ['engine/index.ts', 'engine/nodes/partner-bid.ts', 'durable-objects/daily-cap.ts', 'routes/webhooks.ts', 'routes/custom-endpoint.ts', 'routes/shadow.ts']) {
      expect(roots, f).toContain(path.join(WORKER_SRC, f))
    }
    // The closure is the real run time graph: the engine reaches the Supabase client and the webhooks route reaches the engine.
    const closure = runtimeClosure(roots, diskReader)
    expect(closure.has(path.join(WORKER_SRC, 'lib/supabase.ts'))).toBe(true)
    expect(closure.get(path.join(WORKER_SRC, 'engine/index.ts'))).toBeDefined()
    // And the client really is reached from where it is allowed: its listed importer loads it.
    for (const importer of Object.keys(CLIENT_IMPORTERS)) expect(runtimeImports(importer, diskReader)).toContain(CLIENT)
  })

  it('the binding is named only where it is declared and called, the client is imported only by its listed callers, and the money path never reaches it', () => {
    expect(offenders(files)).toEqual([])
  })

  describe('seen red on each planted route to the binding', () => {
    const planted = (extra: Record<string, string>): Reader => (file) => extra[file] ?? diskReader(file)
    const withFile = (extra: Record<string, string>) => [...new Set([...files, ...Object.keys(extra)])]
    const engineIndex = path.join(WORKER_SRC, 'engine/index.ts')
    const node = path.join(WORKER_SRC, 'engine/nodes/partner-bid.ts')
    const webhooks = path.join(WORKER_SRC, 'routes/webhooks.ts')

    it('a direct import in the engine', () => {
      const extra = { [engineIndex]: `import { callOpsConnections } from '../lib/ops-connections-client'\n${readFileSync(engineIndex, 'utf8')}` }
      const found = offenders(withFile(extra), planted(extra))
      expect(found).toContain('engine/index.ts imports lib/ops-connections-client.ts and is not a listed caller')
      expect(found.some((o) => o.startsWith('the money path reaches lib/ops-connections-client.ts: engine/index.ts -> lib/ops-connections-client.ts'))).toBe(true)
    })

    it('an indirect import through a helper a node loads', () => {
      const helper = path.join(WORKER_SRC, 'lib/planted-connections-helper.ts')
      const extra = {
        [helper]: `export { callOpsConnections } from './ops-connections-client'\n`,
        [node]: `import { callOpsConnections } from '../../lib/planted-connections-helper'\n${readFileSync(node, 'utf8')}`,
      }
      const found = offenders(withFile(extra), planted(extra))
      expect(found.some((o) => /^the money path reaches lib\/ops-connections-client\.ts: .*engine\/nodes\/partner-bid\.ts -> lib\/planted-connections-helper\.ts -> lib\/ops-connections-client\.ts$/.test(o))).toBe(true)
    })

    it('a dynamic import in the webhook route', () => {
      const extra = { [webhooks]: `${readFileSync(webhooks, 'utf8')}\nexport const later = () => import('../lib/ops-connections-client')\n` }
      expect(offenders(withFile(extra), planted(extra)).some((o) => o.includes('routes/webhooks.ts -> lib/ops-connections-client.ts'))).toBe(true)
    })

    it('the binding read straight off the env, by property or by string key', () => {
      for (const use of ['const b = env.OPS_CONNECTIONS', "const b = env['OPS_CONNECTIONS']"]) {
        const extra = { [node]: `${readFileSync(node, 'utf8')}\n${use}\n` }
        expect(offenders(withFile(extra), planted(extra)).some((o) => o.startsWith('engine/nodes/partner-bid.ts:') && o.includes('names the OPS_CONNECTIONS binding'))).toBe(true)
      }
    })

    it('but not a type only import, which compilation erases and so carries nothing to run', () => {
      const extra = { [engineIndex]: `import type { OpsConnectionsUnavailable } from '../lib/ops-connections-client'\n${readFileSync(engineIndex, 'utf8')}` }
      expect(offenders(withFile(extra), planted(extra))).toEqual([])
    })
  })
})
