/**
 * Every worker route that writes a workflow definition asks the connection
 * check before its first write (#2338, build PR 7).
 *
 * A definition naming a removed connection, or one of another organization, is
 * refused at the store by the trigger workflows_refuse_missing_connections
 * whoever writes it. What the trigger cannot do is answer by name before any
 * other write of the request: a save writes its version snapshot first, so a
 * route that skipped the check would leave that snapshot behind and answer the
 * trigger's refusal as an internal error. So this reads every worker source
 * file, finds each route handler whose chain writes a workflows row carrying a
 * definition (an insert, update or upsert whose arguments name `definition`, or
 * a handler that assigns one onto the object it writes), and requires that
 * handler to await the check (connectionRefusal, or checkDefinitionConnections
 * itself) before its first write to workflows or workflow_versions. A
 * definition write outside any route handler fails too, since no request is
 * there to answer by name.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, chainCallsAfter, routeHandlersOf, type RouteHandler } from '../../__tests__/_scan-utils'

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const DEFINITION_WRITES = new Set(['insert', 'update', 'upsert'])
const CHECK_CALL = /\bawait\s+(?:connectionRefusal|checkDefinitionConnections)\s*\(/g
const ASSIGNS_DEFINITION = /\.definition\s*=(?!=)/

interface Write { at: number; table: string; writesDefinitionArg: boolean }

/** Every write chain on workflows or workflow_versions. */
function writesOf(src: string): Write[] {
  const out: Write[] = []
  for (const m of src.matchAll(/\.from\(\s*(['"`])(workflows|workflow_versions)\1\s*\)/g)) {
    const calls = chainCallsAfter(src, (m.index ?? 0) + m[0].length)
    if (!calls.some((call) => WRITES.has(call.name))) continue
    out.push({
      at: m.index ?? 0,
      table: m[2],
      writesDefinitionArg: m[2] === 'workflows' && calls.some((call) => DEFINITION_WRITES.has(call.name) && /\bdefinition\b/.test(call.args)),
    })
  }
  return out
}

interface Scan { definitionWriters: RouteHandler[]; unchecked: string[]; orphans: number[] }

function scanSource(file: string, raw: string): Scan {
  const src = sanitizeSource(raw, { blankStrings: false })
  const handlers = routeHandlersOf(file, src)
  const writes = writesOf(src)
  const inHandler = (at: number) => handlers.find((h) => at >= h.start && at < h.end)
  const definitionWriters: RouteHandler[] = []
  const unchecked: string[] = []
  const orphans = writes.filter((w) => w.writesDefinitionArg && !inHandler(w.at)).map((w) => w.at)
  for (const h of handlers) {
    const own = writes.filter((w) => w.at >= h.start && w.at < h.end)
    const workflowsWrites = own.filter((w) => w.table === 'workflows')
    if (workflowsWrites.length === 0) continue
    const body = src.slice(h.start, h.end)
    const writesDefinition = workflowsWrites.some((w) => w.writesDefinitionArg) || ASSIGNS_DEFINITION.test(body)
    if (!writesDefinition) continue
    definitionWriters.push(h)
    const firstWrite = Math.min(...own.map((w) => w.at))
    const checks = [...body.matchAll(CHECK_CALL)].map((m) => h.start + (m.index ?? 0))
    if (!checks.some((at) => at < firstWrite)) unchecked.push(`${h.file} ${h.label}`)
  }
  return { definitionWriters, unchecked, orphans }
}

function scan(): { labels: string[]; unchecked: string[]; orphans: string[] } {
  const labels: string[] = []
  const unchecked: string[] = []
  const orphans: string[] = []
  for (const full of listTsFiles(WORKER_SRC)) {
    const file = path.relative(WORKER_SRC, full)
    const one = scanSource(file, readFileSync(full, 'utf8'))
    labels.push(...one.definitionWriters.map((h) => `${h.file} ${h.label}`))
    unchecked.push(...one.unchecked)
    orphans.push(...one.orphans.map((at) => `${file} @${at}`))
  }
  return { labels, unchecked, orphans }
}

describe('every workflow definition writer asks the connection check first (#2338)', () => {
  const result = scan()

  it('finds the writers it exists to check (a scan that found none would pass on nothing)', () => {
    expect(result.labels).toEqual(expect.arrayContaining([
      'routes/api/workflows.ts POST /',
      'routes/api/workflows.ts POST /:id/duplicate',
      'routes/api/workflows.ts PUT /:id',
      'routes/api/workflows.ts POST /:id/versions/:version_id/restore',
    ]))
  })

  it('counts no route that writes no definition (switching on, deleting, test payloads)', () => {
    for (const label of ['PATCH /:id', 'DELETE /:id', 'PATCH /:id/test-payloads']) {
      expect(result.labels).not.toContain(`routes/api/workflows.ts ${label}`)
    }
  })

  it('has no definition write outside a route handler', () => {
    expect(result.orphans).toEqual([])
  })

  it('awaits the check before the first write in every handler that writes a definition', () => {
    expect(result.unchecked).toEqual([])
  })
})

// The scanner itself, on text it must judge both ways.
describe('the scanner', () => {
  const planted = (lines: string[]) => [
    'const workflows = new Hono()',
    "workflows.put('/:id', async (c) => {",
    ...lines,
    '  return c.json({ ok: true })',
    '})',
    "workflows.patch('/:id', async (c) => {",
    "  await supabase.from('workflows').update({ is_active: true }).eq('id', id)",
    '})',
    '',
  ].join('\n')
  const write = "  await supabase.from('workflows').update({ definition: def }).eq('id', id)"
  const snapshot = "  await supabase.from('workflow_versions').insert({ definition: def })"
  const check = '  const missing = await connectionRefusal(c, supabase, orgId, def)'

  it('fails a handler that writes a definition and never asks', () => {
    expect(scanSource('p.ts', planted([write])).unchecked).toEqual(['p.ts PUT /:id'])
  })

  it('fails a handler that asks only after its version snapshot', () => {
    expect(scanSource('p.ts', planted([snapshot, check, write])).unchecked).toEqual(['p.ts PUT /:id'])
  })

  it('passes a handler that asks before every write', () => {
    expect(scanSource('p.ts', planted([check, snapshot, write])).unchecked).toEqual([])
  })

  it('reads a definition assigned onto the object written', () => {
    const lines = ['  updates.definition = asJson(def)', "  await supabase.from('workflows').update(updates).eq('id', id)"]
    expect(scanSource('p.ts', planted(lines)).definitionWriters.map((h) => h.label)).toEqual(['PUT /:id'])
  })

  it('does not count a write naming no definition, nor a comparison', () => {
    const lines = ["  if (row.definition === def) return", "  await supabase.from('workflows').update({ name }).eq('id', id)"]
    expect(scanSource('p.ts', planted(lines)).definitionWriters).toEqual([])
  })

  it('does not count a check that sits only in a comment', () => {
    const src = planted(['  // await connectionRefusal(c, supabase, orgId, def)', write])
    expect(scanSource('p.ts', src).unchecked).toEqual(['p.ts PUT /:id'])
  })
})
