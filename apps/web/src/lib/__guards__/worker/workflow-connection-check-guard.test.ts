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
 *
 * Switching a workflow on (#2576, build PR 9) writes no definition, so the
 * trigger, which fires on a write of the definition, never judges it: a
 * workflow switched on while it names a connection that is gone would fail on
 * every run. So a handler that switches a workflow on (assigns is_active onto
 * what it writes, or writes is_active as anything but false) must ask the same
 * check first, about the definition it makes live.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, chainCallsAfter, routeHandlersOf, type RouteHandler } from '../../__tests__/_scan-utils'

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const DEFINITION_WRITES = new Set(['insert', 'update', 'upsert'])
const CHECK_CALL = /\bawait\s+(?:connectionRefusal|checkDefinitionConnections)\s*\(/g
const ASSIGNS_DEFINITION = /\.definition\s*=(?!=)/
/** Writes is_active from something other than the literal false: an assignment, or a key whose value is not false. */
const SWITCHES_ON = /\.is_active\s*=(?!=)|\bis_active\s*:(?!\s*false\b)/

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

interface Scan { definitionWriters: RouteHandler[]; switchers: RouteHandler[]; unchecked: string[]; orphans: number[] }

function scanSource(file: string, raw: string): Scan {
  const src = sanitizeSource(raw, { blankStrings: false })
  const handlers = routeHandlersOf(file, src)
  const writes = writesOf(src)
  const inHandler = (at: number) => handlers.find((h) => at >= h.start && at < h.end)
  const definitionWriters: RouteHandler[] = []
  const switchers: RouteHandler[] = []
  const unchecked: string[] = []
  const orphans = writes.filter((w) => w.writesDefinitionArg && !inHandler(w.at)).map((w) => w.at)
  for (const h of handlers) {
    const own = writes.filter((w) => w.at >= h.start && w.at < h.end)
    const workflowsWrites = own.filter((w) => w.table === 'workflows')
    if (workflowsWrites.length === 0) continue
    const body = src.slice(h.start, h.end)
    const writesDefinition = workflowsWrites.some((w) => w.writesDefinitionArg) || ASSIGNS_DEFINITION.test(body)
    const switchesOn = SWITCHES_ON.test(body)
    if (!writesDefinition && !switchesOn) continue
    if (writesDefinition) definitionWriters.push(h)
    if (switchesOn) switchers.push(h)
    const firstWrite = Math.min(...own.map((w) => w.at))
    const checks = [...body.matchAll(CHECK_CALL)].map((m) => h.start + (m.index ?? 0))
    if (!checks.some((at) => at < firstWrite)) unchecked.push(`${h.file} ${h.label}`)
  }
  return { definitionWriters, switchers, unchecked, orphans }
}

function scan(): { labels: string[]; switchers: string[]; unchecked: string[]; orphans: string[] } {
  const labels: string[] = []
  const switchers: string[] = []
  const unchecked: string[] = []
  const orphans: string[] = []
  for (const full of listTsFiles(WORKER_SRC)) {
    const file = path.relative(WORKER_SRC, full)
    const one = scanSource(file, readFileSync(full, 'utf8'))
    labels.push(...one.definitionWriters.map((h) => `${h.file} ${h.label}`))
    switchers.push(...one.switchers.map((h) => `${h.file} ${h.label}`))
    unchecked.push(...one.unchecked)
    orphans.push(...one.orphans.map((at) => `${file} @${at}`))
  }
  return { labels, switchers, unchecked, orphans }
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

  it('finds the switch on writer (#2576), and not the delete, which only switches a workflow off', () => {
    expect(result.switchers).toContain('routes/api/workflows.ts PATCH /:id')
    expect(result.switchers).not.toContain('routes/api/workflows.ts DELETE /:id')
  })

  it('has no definition write outside a route handler', () => {
    expect(result.orphans).toEqual([])
  })

  it('awaits the check before the first write in every handler that writes a definition or switches a workflow on', () => {
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
    "workflows.patch('/:id/folder', async (c) => {",
    "  await supabase.from('workflows').update({ folder_id: f }).eq('id', id)",
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

  it('fails a handler that switches a workflow on and never asks (#2576)', () => {
    const src = planted(['  updates.is_active = body.is_active', "  await supabase.from('workflows').update(updates).eq('id', id)"])
    expect(scanSource('p.ts', src).switchers.map((h) => h.label)).toEqual(['PUT /:id'])
    expect(scanSource('p.ts', src).unchecked).toEqual(['p.ts PUT /:id'])
    const literal = planted(["  await supabase.from('workflows').update({ is_active: true }).eq('id', id)"])
    expect(scanSource('p.ts', literal).unchecked).toEqual(['p.ts PUT /:id'])
  })

  it('passes a switch on that asks before its write, and does not count a switch off', () => {
    const asked = planted([check, '  updates.is_active = body.is_active', "  await supabase.from('workflows').update(updates).eq('id', id)"])
    expect(scanSource('p.ts', asked).unchecked).toEqual([])
    const off = planted(["  await supabase.from('workflows').update({ deleted_at: now, is_active: false }).eq('id', id)"])
    expect(scanSource('p.ts', off).switchers).toEqual([])
  })

  it('does not count a check that sits only in a comment', () => {
    const src = planted(['  // await connectionRefusal(c, supabase, orgId, def)', write])
    expect(scanSource('p.ts', src).unchecked).toEqual(['p.ts PUT /:id'])
  })
})
