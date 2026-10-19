/**
 * Every connection bound request on the ops Worker goes through connectionFetch
 * (#2335, PR 8 of phase 5 of #1689; asked for on #2335 by the lessons review of
 * the CLAUDE.md docs PR, once OpsConnections calls connection code).
 *
 * connectionFetch is where a request is held to the connection's declared hosts,
 * the Salesforce pool, the deadline, the record first rule and the expiry
 * renewal, and where nothing a login or token carries can leave in an error
 * (F120). A module that reached the platform's fetch itself, holding an opened
 * login or a minted token, would skip all of that and nothing would say so. So:
 *
 *  1. No ops module reaches the platform's fetch (a bare `fetch(...)`, `fetch`
 *     passed as a value, `globalThis.fetch`, `self.fetch`) except those listed
 *     below with the reason they may. The listed live wiring hands it to
 *     connectionFetch's dependencies; everything else receives a fetch it was
 *     given. Read from the syntax tree, so a method or property NAMED fetch (the
 *     fetch handler, `deps.fetch`, `{ fetch: ... }`) is not a use, and a comment
 *     or a string never is.
 *  2. The schema lookups (lib/schema-sync), which send whatever fetch they are
 *     handed, are reached from ops by OpsConnections' lookup alone, and it hands
 *     them boundFetch, which is connectionFetch.
 *
 * Scanned: every non test source under apps/worker/src/ops. An entry for a file
 * that no longer reaches the platform's fetch fails too (L96), so the list stays
 * the truth.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const ALLOWED_PLATFORM_FETCH: Readonly<Record<string, string>> = {
  'apps/worker/src/ops/ops-connections-live.ts':
    'the OpsConnections live wiring: hands the platform fetch to connectionFetch\'s dependencies and to nothing else',
  'apps/worker/src/ops/connection-token-object.ts':
    'ConnectionTokenObject (#2335): its default fetchToken asks a person bound login\'s OAuth token endpoint (an https URL the token object contract checks) for a refresh or a code exchange; it sends no connection bound request',
}

const OPS_SRC = path.join(WORKER_SRC, 'ops')
const LOOKUP_CALLER = 'apps/worker/src/ops/connections/ops-connections.ts'

const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window'])

/** Where a source reaches the platform's fetch, as `line: what`. */
export function platformFetchUses(source: string, fileName = 'source.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const at = (node: ts.Node, what: string) => found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`)

  const isDeclarationName = (node: ts.Identifier): boolean => {
    const p = node.parent
    return (
      (ts.isPropertyAccessExpression(p) && p.name === node)
      || ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)
        || ts.isPropertyAssignment(p) || ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p)
        || ts.isFunctionDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)
        || ts.isPropertyAssignment(p) || ts.isEnumMember(p)) && (p as ts.NamedDeclaration).name === node)
    )
  }

  /** In a type (`typeof fetch`), which sends nothing. */
  const inType = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true
    return false
  }

  const bindsFetch = (name: ts.BindingName): boolean =>
    ts.isIdentifier(name) ? name.text === 'fetch' : name.elements.some((e) => !ts.isOmittedExpression(e) && bindsFetch(e.name))

  /** A parameter or a declaration named fetch in an enclosing scope: the fetch a module was handed, not the platform's. */
  const boundLocally = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsFetch(p.name))) return true
      if (ts.isBlock(n) || ts.isSourceFile(n)) {
        for (const s of n.statements) {
          if (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => bindsFetch(d.name))) return true
          if (ts.isFunctionDeclaration(s) && s.name?.text === 'fetch') return true
        }
      }
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch' && !isDeclarationName(node) && !inType(node) && !boundLocally(node)) {
      at(node, ts.isCallExpression(node.parent) && node.parent.expression === node ? 'calls the platform fetch' : 'passes the platform fetch as a value')
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'fetch' && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
      at(node, `reads ${node.expression.text}.fetch`)
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)
      && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'fetch') {
      at(node, `reads ${node.expression.text}['fetch']`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const rel = (full: string) => path.relative(REPO_ROOT, full).replace(/\\/g, '/')
const files = listTsFiles(OPS_SRC).map((full) => ({ rel: rel(full), source: readFileSync(full, 'utf8') }))

describe('every connection bound request on the ops Worker goes through connectionFetch (#2335)', () => {
  it('scans the ops Worker\'s source, so it cannot pass by reading nothing (L98)', () => {
    expect(files.length).toBeGreaterThan(25)
    expect(files.some((f) => f.rel === 'apps/worker/src/ops/connections/connection-fetch.ts')).toBe(true)
    expect(files.some((f) => f.rel === 'apps/worker/src/ops/ops-connections-entrypoint.ts')).toBe(true)
  })

  it('no ops module but the listed ones reaches the platform\'s fetch', () => {
    const offenders = files
      .filter((f) => !Object.hasOwn(ALLOWED_PLATFORM_FETCH, f.rel))
      .map((f) => ({ file: f.rel, uses: platformFetchUses(f.source, f.rel) }))
      .filter((o) => o.uses.length > 0)
    expect(offenders).toEqual([])
  })

  it('every listed module exists, still reaches it, and says why it may', () => {
    for (const [file, reason] of Object.entries(ALLOWED_PLATFORM_FETCH)) {
      const full = path.join(REPO_ROOT, file)
      expect(existsSync(full), `${file} is listed and does not exist`).toBe(true)
      expect(platformFetchUses(readFileSync(full, 'utf8')).length, `${file} is listed and no longer reaches the platform fetch`).toBeGreaterThan(0)
      expect(reason.length, `${file} needs its reason`).toBeGreaterThan(20)
    }
  })

  it('the live wiring hands the platform fetch to connectionFetch\'s dependencies alone', () => {
    const live = files.find((f) => f.rel === 'apps/worker/src/ops/ops-connections-live.ts')!
    expect(platformFetchUses(live.source)).toHaveLength(1)
    expect(live.source).toMatch(/^\s+fetch: \(input, init\) => fetch\(input, init\),$/m)
  })

  it('the schema lookups are reached from ops only by OpsConnections\' lookup, which hands them connectionFetch', () => {
    const importers = files.filter((f) => /from\s+['"][^'"]*lib\/schema-sync\//.test(f.source)).map((f) => f.rel)
    expect(importers).toEqual([LOOKUP_CALLER])
    const caller = files.find((f) => f.rel === LOOKUP_CALLER)!.source
    const calls = [...caller.matchAll(/\blookupSchema\(([^\n]*)/g)].map((m) => m[1])
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatch(/fetch: boundFetch\(/)
    expect(caller).toMatch(/const answer = await connectionFetch\(deps, call, url, init\)/)
  })

  it('sees each planted way of reaching the platform fetch, and not a name, a comment or a string (seen red)', () => {
    expect(platformFetchUses('export async function f() { return fetch("https://x.test") }')).toEqual(['1: calls the platform fetch'])
    expect(platformFetchUses('const deps = { fetch }')).toEqual(['1: passes the platform fetch as a value'])
    expect(platformFetchUses('const deps = { send: fetch }')).toEqual(['1: passes the platform fetch as a value'])
    expect(platformFetchUses('await globalThis.fetch(url)')).toEqual(['1: reads globalThis.fetch'])
    expect(platformFetchUses('await self["fetch"](url)')).toEqual(['1: reads self[\'fetch\']'])
    expect(platformFetchUses('await (0, fetch)(url)')).toEqual(['1: passes the platform fetch as a value'])
    // Not uses: a name, a parameter's own fetch, a property of something else, a comment, a string.
    expect(platformFetchUses('export default { fetch(req: Request) { return handle(req) } }')).toEqual([])
    expect(platformFetchUses('function f(deps: { fetch: typeof globalThis.fetch }) { return deps.fetch("x") }')).toEqual([])
    expect(platformFetchUses('const o = { fetch: deps.fetch }; o.fetch("x")')).toEqual([])
    expect(platformFetchUses('function g(fetch: (u: string) => Promise<Response>) { return fetch("x") }')).toEqual([])
    expect(platformFetchUses('const probe = { async measure(fetch: F) { return fetch("x") } }')).toEqual([])
    expect(platformFetchUses('let f: typeof fetch; type T = { fetch?: typeof fetch }')).toEqual([])
    expect(platformFetchUses('// fetch(url)\nconst s = "fetch(url)"')).toEqual([])
    // A parameter of an OUTER function named fetch does not hide a use beside it.
    expect(platformFetchUses('function g(fetch: F) { return 1 }\nexport function h() { return fetch("x") }')).toEqual(['2: calls the platform fetch'])
  })
})
