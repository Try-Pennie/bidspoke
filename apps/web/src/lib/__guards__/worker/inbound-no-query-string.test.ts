/**
 * Nothing a sender puts in an address is read (#1815, Dan's decision of
 * 2026-10-06, option 1).
 *
 * Workers Logs keeps every request's full address, query string included
 * (`invocation_logs = true` in both wrangler configs), and a query string
 * percent-encodes an email's @ and a phone's brackets, so no scrub catches lead
 * data in one (L741). Dan chose to keep those logs and instead never to act on a
 * query string: partners send their data in the body, and ported Pipedream
 * workflows that read the query string have their senders move it to the body.
 * This scan is the check that holds the code to that. It fails on:
 *
 *  1. `query`, `queries` or `url` read from a Hono request anywhere in the
 *     worker except under routes/api/ (the signed-in app, whose query strings
 *     are its own filters and carry no lead data), whether by property access,
 *     element access or destructuring;
 *  2. in the code a sender reaches (routes/ outside api/, ops/, middleware/ and
 *     both Workers' entry points), `url` read from a raw Request, and `search`,
 *     `searchParams`, `href`, `toString` or `toJSON` read from a URL.
 *
 * Two shapes are allowed. `new URL(<request>.url).pathname`, which keeps only
 * the path. And controlWordFromQuery in apps/worker/src/lib/control-word.ts,
 * which answers only with a word from a fixed list the caller names (the shadow
 * route's `?mode=stand_in`), so a sender can choose between our words but no
 * text of theirs is ever read back. Any other read of the query goes through
 * neither and fails here.
 *
 * It asks the TypeScript checker for each receiver's TYPE rather than matching
 * `c.req`, so an alias, a parameter or a helper handed the Context is caught
 * the same way (the approach of ops-reads-through-helper.test.ts).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const WORKER_ROOT = path.dirname(WORKER_SRC)
const HELPER_FILE = path.join(WORKER_SRC, 'lib/control-word.ts')
const HELPER = 'controlWordFromQuery'

const rel = (file: string) => path.relative(WORKER_SRC, file).replace(/\\/g, '/')

/** Code a sender's request reaches. The signed-in app's routes are not in it. */
const isInbound = (file: string) => {
  const r = rel(file)
  if (r.startsWith('routes/api/')) return false
  return r.startsWith('routes/') || r.startsWith('ops/') || r.startsWith('middleware/') || r === 'index.ts'
}
const isSignedInApp = (file: string) => rel(file).startsWith('routes/api/')

const HONO_REQUEST_READS = new Set(['query', 'queries', 'url'])
const REQUEST_READS = new Set(['url'])
const URL_READS = new Set(['search', 'searchParams', 'href', 'toString', 'toJSON'])

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(WORKER_ROOT, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p))
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  // The config's own path, so `types` (@cloudflare/workers-types) resolves from
  // apps/worker. Without it TypeScript looks from this test's directory, finds
  // nothing, and types every Request and URL as `any`, which this scan reads as
  // neither and so passes everything.
  return ts.parseJsonConfigFileContent(config.config, ts.sys, WORKER_ROOT, undefined, configPath).options
}

function buildProgram(roots: string[], extra: Record<string, string> = {}): ts.Program {
  const options = compilerOptions()
  const host = ts.createCompilerHost(options, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (f) => extra[f] ?? readFile(f)
  host.fileExists = (f) => f in extra || fileExists(f)
  host.getSourceFile = (f, lang, onError, create) =>
    f in extra ? ts.createSourceFile(f, extra[f], lang, true) : getSourceFile(f, lang, onError, create)
  return ts.createProgram({ rootNames: [...roots, ...Object.keys(extra)], options, host })
}

type Kind = 'hono' | 'request' | 'url'

/** What a receiver is, by its declared type's name (a union counts if any part does). */
function kindOf(checker: ts.TypeChecker, type: ts.Type): Kind | null {
  for (const t of type.isUnion() ? type.types : [type]) {
    const name = (t.aliasSymbol ?? t.getSymbol())?.getName()
    if (name === 'HonoRequest') return 'hono'
    if (name === 'Request') return 'request'
    if (name === 'URL') return 'url'
  }
  return null
}

interface Finding {
  file: string
  line: number
  what: string
}

/** `new URL(<this>).pathname`: the one shape in which a request's url may be read. */
function isPathnameOnly(access: ts.Node): boolean {
  const call = access.parent
  if (!call || !ts.isNewExpression(call)) return false
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'URL') return false
  if (call.arguments?.length !== 1 || call.arguments[0] !== access) return false
  const next = call.parent
  return !!next && ts.isPropertyAccessExpression(next) && next.expression === call && next.name.text === 'pathname'
}

function helperBody(sf: ts.SourceFile): [number, number] | null {
  let span: [number, number] | null = null
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === HELPER && node.body) span = [node.body.getStart(sf), node.body.getEnd()]
  })
  return span
}

export function scanQueryReads(program: ts.Program, files: string[]): Finding[] {
  const checker = program.getTypeChecker()
  const offenders: Finding[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) throw new Error(`${rel(file)} is not in the program, so it was not scanned`)
    const inbound = isInbound(file)
    const signedIn = isSignedInApp(file)
    const helper = file === HELPER_FILE ? helperBody(sf) : null

    const judge = (node: ts.Node, receiver: ts.Node, name: string) => {
      const kind = kindOf(checker, checker.getTypeAtLocation(receiver))
      if (kind === null) return
      const inHelper = helper !== null && node.getStart(sf) >= helper[0] && node.getEnd() <= helper[1]
      let bad = false
      if (kind === 'hono' && HONO_REQUEST_READS.has(name)) {
        bad = !signedIn && !inHelper && !(name === 'url' && isPathnameOnly(node))
      } else if (inbound && kind === 'request' && REQUEST_READS.has(name)) {
        bad = !isPathnameOnly(node)
      } else if (inbound && kind === 'url' && URL_READS.has(name)) {
        bad = true
      }
      if (bad) {
        offenders.push({ file: rel(file), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what: `${kind}.${name}` })
      }
    }

    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) judge(node, node.expression, node.name.text)
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        judge(node, node.expression, node.argumentExpression.text)
      } else if (ts.isObjectBindingPattern(node)) {
        for (const el of node.elements) {
          const key = el.propertyName ?? el.name
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) judge(el, node, key.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return offenders
}

const SOURCE_FILES = listTsFiles(WORKER_SRC)

describe('no code a sender reaches reads the query string (#1815)', () => {
  // Built and scanned once, while the suite is collected, as
  // ops-reads-through-helper.test.ts does: type checking the whole worker took
  // 7.4s on a CI runner (1.4s locally), past a single test's 5s limit.
  const program = buildProgram(SOURCE_FILES)
  const offenders = scanQueryReads(program, SOURCE_FILES)

  // The planted files share one program, built here for the same reason: each
  // program loads the Workers types again.
  const PLANTED_ROUTE = path.join(WORKER_SRC, 'routes/__planted_query__.ts')
  const PLANTED_HELPER = path.join(WORKER_SRC, 'lib/__planted_helper__.ts')
  const PLANTED_FILTER = path.join(WORKER_SRC, 'routes/api/__planted_filter__.ts')
  const planted = {
    [PLANTED_ROUTE]: [
      "import type { Context } from 'hono'",
      'export function a(c: Context) { return c.req.query("email") }',
      'export function b(c: Context) { const r = c.req; return r.queries("x") }',
      'export function d(c: Context) { const { query } = c.req; return query }',
      'export function e(c: Context) { return c.req["query"]("x") }',
      'export function f(c: Context) { console.log(c.req.url) }',
      'export function g(req: Request) { return new URL(req.url).searchParams.get("phone") }',
      'export function h(req: Request) { const u = new URL(req.url); return u.search }',
      'export function i(req: Request) { return req.url }',
      'export function ok1(c: Context) { return new URL(c.req.url).pathname }',
      'export function ok2(req: Request) { return new URL(req.url).pathname }',
      '',
    ].join('\n'),
    [PLANTED_HELPER]: "import type { Context } from 'hono'\nexport const read = (c: Context) => c.req.query('ssn')\n",
    [PLANTED_FILTER]: "import type { Context } from 'hono'\nexport const read = (c: Context) => c.req.query('status')\n",
  }
  const plantedProgram = buildProgram([HELPER_FILE], planted)
  const plantedResults = new Map(Object.keys(planted).map((file) => [file, scanQueryReads(plantedProgram, [file])]))
  const plantedFindings = (file: string): Finding[] => {
    const found = plantedResults.get(file)
    if (!found) throw new Error(`${rel(file)} was not planted`)
    return found
  }

  it('loads the Workers types, without which every Request and URL is `any` and nothing is found', () => {
    const messages = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(messages).toEqual([])
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(path.join(WORKER_SRC, 'ops/index.ts'))
    expect(sf).toBeDefined()
    const request = checker.resolveName('Request', sf as ts.SourceFile, ts.SymbolFlags.Type, false)
    const url = checker.resolveName('URL', sf as ts.SourceFile, ts.SymbolFlags.Type, false)
    expect(request && kindOf(checker, checker.getDeclaredTypeOfSymbol(request))).toBe('request')
    expect(url && kindOf(checker, checker.getDeclaredTypeOfSymbol(url))).toBe('url')
  })

  it('scans both entry points, every inbound route and the helper', () => {
    const scanned = new Set(SOURCE_FILES.map(rel))
    for (const f of ['index.ts', 'ops/index.ts', 'routes/webhooks.ts', 'routes/custom-endpoint.ts', 'routes/shadow.ts', 'lib/control-word.ts']) {
      expect(scanned.has(f)).toBe(true)
    }
  })

  it('treats each Worker\'s entry point as inbound code', () => {
    for (const config of ['wrangler.toml', 'wrangler.ops.toml']) {
      const main = /^main = "src\/([^"]+)"$/m.exec(readFileSync(path.join(WORKER_ROOT, config), 'utf8'))?.[1]
      expect(main, config).toBeDefined()
      expect(isInbound(path.join(WORKER_SRC, main as string)), `${config} main ${main}`).toBe(true)
    }
  })

  it('mounts every route a sender reaches from a file this treats as inbound', () => {
    const index = readFileSync(path.join(WORKER_SRC, 'index.ts'), 'utf8')
    const mounts = [...index.matchAll(/app\.route\('([^']+)',\s*(\w+)\)/g)].filter(([, at]) => at !== '/api')
    expect(mounts.length).toBeGreaterThan(0)
    for (const [, at, name] of mounts) {
      const from = new RegExp(`import\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s+from\\s+'\\./([^']+)'`).exec(index)?.[1]
      expect(from, `${at} mounts ${name}`).toBeDefined()
      expect(isInbound(path.join(WORKER_SRC, `${from}.ts`)), `${at} mounts ${from}`).toBe(true)
    }
  })

  it('finds no query string read in the worker outside the signed-in app', () => {
    expect(offenders).toEqual([])
  })

  it('fails on each planted way of reading the query, by file, line and kind (L1)', () => {
    expect(plantedFindings(PLANTED_ROUTE).map((f) => `${f.line} ${f.what}`).sort()).toEqual([
      '2 hono.query',
      '3 hono.queries',
      '4 hono.query',
      '5 hono.query',
      '6 hono.url',
      '7 request.url',
      '7 url.searchParams',
      '8 request.url',
      '8 url.search',
      '9 request.url',
    ])
  })

  it('fails on a helper outside routes that is handed the Context and reads the query', () => {
    expect(plantedFindings(PLANTED_HELPER).map((f) => f.what)).toEqual(['hono.query'])
  })

  it('leaves the signed-in app\'s own filters alone', () => {
    expect(plantedFindings(PLANTED_FILTER)).toEqual([])
  })
})
