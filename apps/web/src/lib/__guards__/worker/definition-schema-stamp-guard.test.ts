/**
 * Every worker definition write stamps definition_schema_version, from the
 * Worker's own rule and never from the request (#1947).
 *
 * The stamp says which rules a stored definition is judged by. A write that
 * leaves it out stores NULL, which reads as unstamped (version 1) however new
 * the definition is, and a write that took it from the request would let a
 * caller choose the rules its own definition is judged by. So this reads every
 * worker source file and requires:
 *
 * 1. each route handler to name definition_schema_version once for every
 *    definition it writes: a workflows insert, update or upsert whose
 *    arguments name `definition`, a `.definition =` assignment onto the object
 *    a handler writes, and every workflow_versions insert or upsert (a version
 *    row is always a definition);
 * 2. every value written to the column to come from lib/definition-stamp.ts
 *    (writtenDefinitionStamp or copiedDefinitionStamp), directly or through a
 *    const assigned from them that reads nothing of the request.
 *
 * The routes' own tests prove which stamp each writer chooses; this catches a
 * new writer, or a copy of an old one, that forgets the column.
 *
 * Since #1947 A2 every definition write is a writeWorkflow call (the
 * write_workflow database function). The function decides a COPIED stamp
 * itself (duplicate, restore, the snapshot of a save that sends no
 * definition) and refuses one from the caller, and it refuses an AUTHORED
 * definition (create, a save that sends one) that carries no stamp
 * (supabase/tests/write_workflow.test.sql). What it cannot see is where an
 * authored stamp came from, so this still reads each writeWorkflow call whose
 * op authors a definition (create, save) as a definition write that must name
 * the stamp, from the helpers, as above.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, chainCallsAfter, routeHandlersOf } from '../../__tests__/_scan-utils'

const DEFINITION_WRITES = new Set(['insert', 'update', 'upsert'])
const VERSION_WRITES = new Set(['insert', 'upsert'])
const STAMP_WRITE = /\bdefinition_schema_version\s*(?::|=(?!=))\s*([^,\n}]+)/g
const HELPER = /\b(?:writtenDefinitionStamp|copiedDefinitionStamp)\s*\(/
const REQUEST = /\bbody\b|\bc\.req\b|\.json\s*\(/

/** A writeWorkflow call whose op authors a definition (#1947): its stamp is the caller's to send. */
const AUTHORING_WRITE = /\bwriteWorkflow\s*\(\s*\w+\s*,\s*\{\s*op\s*:\s*(['"`])(create|save)\1/g

/**
 * Positions of every definition write in `kept` (comments blanked, strings
 * kept): a writeWorkflow call that authors a definition; a workflows write
 * whose arguments name `definition`, or that writes an object a
 * `.definition =` assignment fills before it (in the same text, which is one
 * handler when called per handler); and every version row write.
 */
function definitionWritesOf(kept: string): number[] {
  const out: number[] = []
  for (const m of kept.matchAll(AUTHORING_WRITE)) out.push(m.index ?? 0)
  for (const m of kept.matchAll(/\.from\(\s*(['"`])(workflows|workflow_versions)\1\s*\)/g)) {
    const at = m.index ?? 0
    const calls = chainCallsAfter(kept, at + m[0].length)
    if (m[2] === 'workflow_versions') {
      if (calls.some((call) => VERSION_WRITES.has(call.name))) out.push(at)
      continue
    }
    const writes = calls.filter((call) => DEFINITION_WRITES.has(call.name))
    const named = writes.some((call) => /\bdefinition\b/.test(call.args))
    const filled = writes.some((call) => {
      const object = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(call.args)?.[1]
      return object !== undefined && new RegExp(`\\b${object}\\.definition\\s*=(?!=)`).test(kept.slice(0, at))
    })
    if (named || filled) out.push(at)
  }
  return out
}

/**
 * Whether a value is a helper's answer: one helper call, or a conditional whose
 * every branch is one. The condition may read the request, since it only picks
 * which rule applies (a save that sends a definition, or one that does not);
 * a branch may not.
 */
function fromHelpers(value: string): boolean {
  const isHelper = (branch: string) => HELPER.test(branch) && !REQUEST.test(branch)
  // Either side of a fallback can be the value, so both must be a helper's.
  const fallbacks = value.split('??')
  if (fallbacks.length > 1) return fallbacks.every(isHelper)
  const question = value.indexOf('?')
  const branches = question === -1 ? [value] : value.slice(question + 1).split(':')
  return branches.every(isHelper)
}

interface Finding { unstamped: string[]; fromRequest: string[]; writers: string[] }

export function scanSource(file: string, raw: string): Finding {
  const kept = sanitizeSource(raw, { blankStrings: false })
  const blanked = sanitizeSource(raw)
  const unstamped: string[] = []
  const fromRequest: string[] = []
  const writers: string[] = []
  const handlers = routeHandlersOf(file, kept)
  const stamps = [...blanked.matchAll(STAMP_WRITE)].map((m) => ({ at: m.index ?? 0, value: m[1].trim() }))

  for (const h of handlers) {
    // Read per handler, so an object another handler fills is not counted here.
    const own = definitionWritesOf(kept.slice(h.start, h.end)).length
    if (own === 0) continue
    writers.push(`${h.file} ${h.label}`)
    const named = stamps.filter((s) => s.at >= h.start && s.at < h.end).length
    if (named < own) unstamped.push(`${h.file} ${h.label}: ${own} definition writes, ${named} stamps`)
  }
  const outside = definitionWritesOf(kept).filter((at) => !handlers.some((h) => at >= h.start && at < h.end))
  if (outside.length > 0) unstamped.push(`${file}: ${outside.length} definition writes outside any route handler`)

  for (const s of stamps) {
    if (fromHelpers(s.value)) continue
    const name = /^[A-Za-z_$][\w$]*$/.exec(s.value)?.[0]
    const decl = name ? new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^\\n]+)`).exec(blanked) : null
    if (decl && fromHelpers(decl[1])) continue
    fromRequest.push(`${file}: definition_schema_version from ${s.value}`)
  }
  return { unstamped, fromRequest, writers }
}

function scan(): Finding {
  const all: Finding = { unstamped: [], fromRequest: [], writers: [] }
  for (const full of listTsFiles(WORKER_SRC)) {
    const file = path.relative(WORKER_SRC, full)
    if (file === path.join('types', 'database.ts')) continue
    const one = scanSource(file, readFileSync(full, 'utf8'))
    all.unstamped.push(...one.unstamped)
    all.fromRequest.push(...one.fromRequest)
    all.writers.push(...one.writers)
  }
  return all
}

describe('every worker definition write stamps definition_schema_version from the Worker (#1947)', () => {
  const result = scan()

  it('finds the writers it exists to check (a scan that found none would pass on nothing)', () => {
    // Duplicate and restore copy a stamp, which write_workflow decides (#1947).
    expect(result.writers).toEqual(expect.arrayContaining([
      'routes/api/workflows.ts POST /',
      'routes/api/workflows.ts PUT /:id',
    ]))
  })

  it('stamps every definition each writer writes', () => {
    expect(result.unstamped).toEqual([])
  })

  it('takes every stamp from lib/definition-stamp.ts, never from the request', () => {
    expect(result.fromRequest).toEqual([])
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
    '',
  ].join('\n')

  it('fails a workflows definition write with no stamp', () => {
    const src = planted(["  await supabase.from('workflows').update({ definition: def }).eq('id', id)"])
    expect(scanSource('p.ts', src).unstamped).toEqual(['p.ts PUT /:id: 1 definition writes, 0 stamps'])
  })

  it('fails a version snapshot with no stamp beside a stamped workflows write', () => {
    const src = planted([
      "  await supabase.from('workflow_versions').insert({ definition: def })",
      "  await supabase.from('workflows').update({ definition: def, definition_schema_version: writtenDefinitionStamp() }).eq('id', id)",
    ])
    expect(scanSource('p.ts', src).unstamped).toEqual(['p.ts PUT /:id: 2 definition writes, 1 stamps'])
  })

  it('counts a definition assigned onto the object written', () => {
    const src = planted(['  updates.definition = asJson(def)', "  await supabase.from('workflows').update(updates).eq('id', id)"])
    expect(scanSource('p.ts', src).unstamped).toEqual(['p.ts PUT /:id: 1 definition writes, 0 stamps'])
    const stamped = planted(['  updates.definition = asJson(def)', '  updates.definition_schema_version = writtenDefinitionStamp()', "  await supabase.from('workflows').update(updates).eq('id', id)"])
    expect(scanSource('p.ts', stamped).unstamped).toEqual([])
  })

  it('does not count a stamp named only in a select string or a comment', () => {
    const src = planted([
      "  await supabase.from('workflows').select('definition_schema_version: x')",
      '  // definition_schema_version: writtenDefinitionStamp()',
      "  await supabase.from('workflows').update({ definition: def }).eq('id', id)",
    ])
    expect(scanSource('p.ts', src).unstamped).toEqual(['p.ts PUT /:id: 1 definition writes, 0 stamps'])
  })

  it('fails a stamp taken from the request, directly or through a const', () => {
    const direct = planted(["  await supabase.from('workflows').update({ definition: def, definition_schema_version: body.definition_schema_version }).eq('id', id)"])
    expect(scanSource('p.ts', direct).fromRequest).toEqual(['p.ts: definition_schema_version from body.definition_schema_version'])
    const viaConst = planted(['  const stamp = body.stamp ?? writtenDefinitionStamp()', "  await supabase.from('workflows').update({ definition: def, definition_schema_version: stamp }).eq('id', id)"])
    expect(scanSource('p.ts', viaConst).fromRequest).toEqual(['p.ts: definition_schema_version from stamp'])
    const branch = planted(['  const pick = def ? writtenDefinitionStamp() : body.stamp', "  await supabase.from('workflows').update({ definition: def, definition_schema_version: pick }).eq('id', id)"])
    expect(scanSource('p.ts', branch).fromRequest).toEqual(['p.ts: definition_schema_version from pick'])
  })

  it('lets a condition read the request to pick which helper applies', () => {
    const src = planted(['  const pick = body.definition !== undefined ? writtenDefinitionStamp() : copiedDefinitionStamp(row)', "  await supabase.from('workflows').update({ definition: def, definition_schema_version: pick }).eq('id', id)"])
    expect(scanSource('p.ts', src).fromRequest).toEqual([])
  })

  it('does not count a write onto an object another handler fills with a definition', () => {
    const src = [
      'const workflows = new Hono()',
      "workflows.put('/:id', async (c) => {",
      '  updates.definition = def',
      '  updates.definition_schema_version = writtenDefinitionStamp()',
      "  await supabase.from('workflows').update(updates).eq('id', id)",
      '})',
      "workflows.patch('/:id', async (c) => {",
      "  await supabase.from('workflows').update(updates).eq('id', id)",
      '})',
      '',
    ].join('\n')
    expect(scanSource('p.ts', src)).toEqual({ unstamped: [], fromRequest: [], writers: ['p.ts PUT /:id'] })
  })

  it('passes a stamp from a helper, directly or through a const', () => {
    const src = planted([
      '  const saved = def ? writtenDefinitionStamp() : copiedDefinitionStamp(row)',
      "  await supabase.from('workflow_versions').insert({ definition: def, definition_schema_version: saved })",
      "  await supabase.from('workflows').update({ definition: def, definition_schema_version: copiedDefinitionStamp(row) }).eq('id', id)",
    ])
    expect(scanSource('p.ts', src)).toEqual({ unstamped: [], fromRequest: [], writers: ['p.ts PUT /:id'] })
  })

  it('counts a writeWorkflow call that authors a definition, and not one that copies (#1947)', () => {
    const save = "  await writeWorkflow(supabase, {\n    op: 'save',\n    fields,\n  })"
    expect(scanSource('p.ts', planted([save])).unstamped).toEqual(['p.ts PUT /:id: 1 definition writes, 0 stamps'])
    expect(scanSource('p.ts', planted(['  fields.definition_schema_version = writtenDefinitionStamp()', save])).unstamped).toEqual([])
    expect(scanSource('p.ts', planted(["  await writeWorkflow(supabase, { op: 'restore', fields })"])).writers).toEqual([])
  })

  it('fails a definition write outside any route handler', () => {
    const src = "export async function save() { await supabase.from('workflows').update({ definition: def }) }\n"
    expect(scanSource('p.ts', src).unstamped).toEqual(['p.ts: 1 definition writes outside any route handler'])
  })
})
