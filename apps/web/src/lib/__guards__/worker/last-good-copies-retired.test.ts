/**
 * Guard: every handler that writes webhook_endpoints or partner_configs retires
 * the stored copy of what it changed, after the write (#1846).
 *
 * Two last-good copies live in KV with no expiry and are served when the
 * database read fails (#1296):
 * - `ep-lastgood:<subdomain>:<path>`, the custom endpoint record
 *   (routes/custom-endpoint.ts, keys and retire in lib/endpoint-copies.ts);
 * - `partner-lastgood:<partnerId>`, the partner config the Partner Bid node
 *   bids from (lib/partner-last-good.ts).
 * Before #1846 nothing retired either, so in an outage an endpoint deleted or
 * switched off, or a partner disabled, minutes earlier was served from its copy.
 *
 * The handlers are ENUMERATED from source, never listed by hand (L41, L96): every
 * function in any app's source holding a write to the table (a `.from(table)`
 * chain ending in a write method, or an `.rpc()` of a database function whose
 * body writes the table, read from supabase/migrations) must also call the
 * retire function, and call it AFTER the write, since retiring first lets a lead
 * in flight put the old copy straight back. A write is attributed to the
 * OUTERMOST enclosing function, so one inside a callback (requireRowOr404's
 * thunk) counts against the route handler that owns it.
 *
 * A `.from(x)` whose table is not a literal cannot be judged by name, so each
 * such site must be listed below with the reason it never names either table.
 *
 * Seen to fail on the code before #1846 (naming all six handlers), with the
 * retire call removed from endpoints.ts DELETE and from partners.ts PUT, and
 * with the endpoints.ts DELETE retire moved above its write. The order check
 * asks only that SOME retire follows the write, so a handler with two (the PUT
 * retires the old address and, when it moved, the new one) is held to order by
 * its route tests, not by this guard.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

interface Kind {
  table: string
  retire: string
  /** PostgREST builder methods that change or remove a row this copy could describe. */
  writeMethods: string[]
  /** SQL statements that do the same inside a database function. */
  sqlWrites: RegExp
}

const KINDS: Kind[] = [
  {
    table: 'webhook_endpoints',
    retire: 'retireEndpointCopies',
    // An INSERT counts: the copy is keyed by address, and an address can be
    // reused by a new endpoint while an old endpoint's copy still sits there.
    writeMethods: ['insert', 'upsert', 'update', 'delete'],
    sqlWrites: /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?webhook_endpoints\b/i,
  },
  {
    table: 'partner_configs',
    retire: 'retirePartnerLastGood',
    // A plain INSERT does not count: the copy is keyed by the row's id, and a
    // new row has a new id, so no copy can exist under it. An upsert can land
    // on an existing row, so it counts.
    writeMethods: ['upsert', 'update', 'delete'],
    sqlWrites: /\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?partner_configs\b/i,
  },
]

/**
 * Each `.from()` with a non-literal table, with the reason it can never be
 * either table (L362: the reason, not merely the site).
 */
const DYNAMIC_FROM_REASONS: Record<string, string> = {
  'apps/worker/src/lib/sightings-export.ts': 'tableName ranges over the sightings tables being exported to Snowflake',
  'apps/worker/src/engine/step-logger.ts': 'table is one of the execution step tables the step logger flushes',
  'apps/worker/src/ops/ops-db.ts': 'read.table is a declared read of the ops project, which holds neither table',
}

const BUILDER_METHODS = new Set(['select', 'insert', 'upsert', 'update', 'delete'])

/** The worker's source first (where every writer is today), then every other app's. */
function sourceRoots(): string[] {
  const apps = path.join(REPO_ROOT, 'apps')
  const others = readdirSync(apps)
    .map((d) => path.join(apps, d, 'src'))
    .filter((d) => d !== WORKER_SRC)
    .filter((d) => {
      try {
        return readdirSync(d).length > 0
      } catch {
        return false
      }
    })
  return [WORKER_SRC, ...others]
}

function sourceFiles(): string[] {
  return sourceRoots().flatMap((root) => listTsFiles(root))
}

/** Database functions whose latest definition writes the table, from the migrations in order. */
export function sqlFunctionsWriting(kind: Kind, migrations: Array<{ name: string; text: string }>): Set<string> {
  const bodies = new Map<string, string>()
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(|DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi
  for (const { text } of migrations) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text))) {
      if (m[2]) {
        bodies.delete(m[2])
        continue
      }
      const after = text.slice(m.index)
      const tag = /\bAS\s+(\$\w*\$)/i.exec(after)
      if (!tag) continue
      const start = tag.index + tag[0].length
      const end = after.indexOf(tag[1], start)
      if (end < 0) continue
      bodies.set(m[1], after.slice(start, end))
    }
  }
  const out = new Set<string>()
  for (const [name, body] of bodies) if (kind.sqlWrites.test(body)) out.add(name)
  // A function that calls a writer writes too (#2140: both delete_partner_config
  // overloads reach the table through _delete_partner_config), followed until
  // nothing new is found.
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, body] of bodies) {
      if (out.has(name)) continue
      if ([...out].some((w) => new RegExp(`\\b(?:public\\.)?${w}\\s*\\(`, 'i').test(body))) {
        out.add(name)
        grew = true
      }
    }
  }
  return out
}

function readMigrations(): Array<{ name: string; text: string }> {
  const dir = path.join(REPO_ROOT, 'supabase/migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }))
}

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

/** The builder methods chained onto a call, in order (`.from(t).update(x).eq(...)` gives update, eq). */
function chainedMethods(call: ts.CallExpression): string[] {
  const names: string[] = []
  let cur: ts.Node = call
  while (
    cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur &&
    cur.parent.parent && ts.isCallExpression(cur.parent.parent) && cur.parent.parent.expression === cur.parent
  ) {
    names.push(cur.parent.name.text)
    cur = cur.parent.parent
  }
  return names
}

function outermostFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null
  for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) found = p
  return found
}

/** `PUT /:id` when the function is a Hono handler, its own name otherwise. */
function handlerLabel(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
  const parent = fn.parent
  if (parent && ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const route = parent.arguments[0]
    if (route && ts.isStringLiteralLike(route)) return `${parent.expression.name.text.toUpperCase()} ${route.text}`
  }
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text
  return `function at line ${sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1}`
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

export interface Finding {
  /** `<file> <handler>`, one per writing handler. */
  handlers: string[]
  offenders: string[]
  dynamicFroms: string[]
}

/** Judge one file's source for one kind. `rel` is the repo-relative path used in messages. */
export function judge(kind: Kind, rel: string, src: string, rpcWriters: Set<string>): Finding {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const writes: Array<{ node: ts.CallExpression; what: string }> = []
  const dynamicFroms: string[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text
      const arg = n.arguments[0]
      if (method === 'from' && arg) {
        const chain = chainedMethods(n)
        if (ts.isStringLiteralLike(arg)) {
          const write = chain.find((m) => kind.writeMethods.includes(m))
          if (arg.text === kind.table && write) writes.push({ node: n, what: `.${write}() on ${kind.table}` })
        } else if (chain.some((m) => BUILDER_METHODS.has(m))) {
          dynamicFroms.push(`${rel}:${lineOf(n)}`)
        }
      }
      if (method === 'rpc' && arg && ts.isStringLiteralLike(arg) && rpcWriters.has(arg.text)) {
        writes.push({ node: n, what: `rpc ${arg.text}, which writes ${kind.table}` })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  const handlers = new Set<string>()
  const offenders: string[] = []
  for (const w of writes) {
    const fn = outermostFunction(w.node)
    if (!fn || !fn.body) {
      offenders.push(`${rel}:${lineOf(w.node)} ${w.what} outside any function, so nothing can retire the copy with it`)
      continue
    }
    const label = `${rel} ${handlerLabel(fn, sf)}`
    handlers.add(label)
    let retiredAfter = false
    const find = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === kind.retire && n.getStart(sf) > w.node.getEnd()) retiredAfter = true
      ts.forEachChild(n, find)
    }
    find(fn.body)
    if (!retiredAfter) offenders.push(`${label} (line ${lineOf(w.node)}): ${w.what} without a later ${kind.retire}()`)
  }
  return { handlers: [...handlers], offenders, dynamicFroms }
}

function scan(kind: Kind): Finding {
  const rpcWriters = sqlFunctionsWriting(kind, readMigrations())
  const all: Finding = { handlers: [], offenders: [], dynamicFroms: [] }
  for (const file of sourceFiles()) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
    const f = judge(kind, rel, readFileSync(file, 'utf8'), rpcWriters)
    all.handlers.push(...f.handlers)
    all.offenders.push(...f.offenders)
    all.dynamicFroms.push(...f.dynamicFroms)
  }
  return all
}

const [ENDPOINTS, PARTNERS] = KINDS

describe('every handler writing webhook_endpoints retires the endpoint copies (#1846)', () => {
  const found = scan(ENDPOINTS)

  it('no handler writes the table without a later retireEndpointCopies()', () => {
    expect(found.offenders).toEqual([])
  })

  it('the enumeration finds the endpoint routes, so an empty offender list is a measurement (L1)', () => {
    expect(found.handlers).toEqual(expect.arrayContaining([
      'apps/worker/src/routes/api/endpoints.ts POST /',
      'apps/worker/src/routes/api/endpoints.ts PUT /:id',
      'apps/worker/src/routes/api/endpoints.ts DELETE /:id',
    ]))
  })
})

describe('every handler writing partner_configs retires the partner copy (#1846)', () => {
  const found = scan(PARTNERS)

  it('no handler writes the table without a later retirePartnerLastGood()', () => {
    expect(found.offenders).toEqual([])
  })

  it('the enumeration finds the partner routes, the delete function and the rename function (L1)', () => {
    expect(found.handlers).toEqual(expect.arrayContaining([
      'apps/worker/src/routes/api/partners.ts PUT /:id',
      'apps/worker/src/routes/api/partner-delete.ts DELETE /:id',
      'apps/worker/src/routes/api/workflows.ts POST /:id/rename-apply',
    ]))
    expect([...sqlFunctionsWriting(PARTNERS, readMigrations())]).toEqual(expect.arrayContaining(['delete_partner_config', 'rename_partner_step_namespace']))
  })
})

describe('a .from() with a computed table name is accounted for', () => {
  it('each one sits in a file with a recorded reason it can never be either table', () => {
    const files = [...new Set(scan(ENDPOINTS).dynamicFroms.map((s) => s.split(':')[0]))].sort()
    expect(files).toEqual(Object.keys(DYNAMIC_FROM_REASONS).sort())
  })
})

describe('the detector', () => {
  const rpcWriters = new Set(['delete_partner_config'])
  const run = (src: string) => judge(PARTNERS, 'x.ts', src, rpcWriters)

  it('flags a handler that writes without retiring, and one that retires BEFORE the write', () => {
    expect(run(`r.put('/:id', async (c) => { await sb.from('partner_configs').update({}).eq('id', id) })`).offenders).toHaveLength(1)
    expect(run(`r.put('/:id', async (c) => { await retirePartnerLastGood(kv, id); await sb.from('partner_configs').update({}).eq('id', id) })`).offenders).toHaveLength(1)
  })

  it('accepts a retire after the write, and attributes a write inside a callback to the handler around it', () => {
    const ok = run(`r.delete('/:id', async (c) => { await guard(() => sb.from('partner_configs').delete().eq('id', id)); await retirePartnerLastGood(kv, id) })`)
    expect(ok.offenders).toEqual([])
    expect(ok.handlers).toEqual(['x.ts DELETE /:id'])
  })

  it('counts an rpc of a function that writes the table, and ignores a plain insert and a read', () => {
    expect(run(`async function drop() { await sb.rpc('delete_partner_config', {}) }`).offenders).toHaveLength(1)
    expect(run(`async function add() { await sb.from('partner_configs').insert({}).select().single() }`).offenders).toEqual([])
    expect(run(`async function read() { await sb.from('partner_configs').select('*').eq('id', id) }`).offenders).toEqual([])
  })

  it('reads which functions write a table from their latest definition, and forgets a dropped one', () => {
    const mig = [
      { name: '1.sql', text: 'CREATE FUNCTION public.a() RETURNS void AS $$ BEGIN UPDATE partner_configs SET x = 1; END $$ LANGUAGE plpgsql;\nCREATE OR REPLACE FUNCTION b() RETURNS void AS $fn$ DELETE FROM public.partner_configs; $fn$;' },
      { name: '2.sql', text: 'CREATE OR REPLACE FUNCTION public.a() RETURNS void AS $$ SELECT 1 FROM partner_configs $$;\nDROP FUNCTION IF EXISTS public.b(uuid);' },
    ]
    expect([...sqlFunctionsWriting(PARTNERS, mig)]).toEqual([])
    expect([...sqlFunctionsWriting(PARTNERS, mig.slice(0, 1))].sort()).toEqual(['a', 'b'])
  })

  it('counts a function that reaches the table through another function, however deep (#2140)', () => {
    const mig = [{ name: '1.sql', text: [
      'CREATE FUNCTION public._body(p uuid) RETURNS void AS $$ BEGIN DELETE FROM partner_configs WHERE id = p; END $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.outer_one(p uuid) RETURNS void AS $$ BEGIN PERFORM public._body(p); END $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.outer_two(p uuid) RETURNS void AS $$ BEGIN PERFORM outer_one(p); END $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION public.reader(p uuid) RETURNS void AS $$ SELECT 1 FROM partner_configs $$ LANGUAGE sql;',
    ].join('\n') }]
    expect([...sqlFunctionsWriting(PARTNERS, mig)].sort()).toEqual(['_body', 'outer_one', 'outer_two'])
  })
})
