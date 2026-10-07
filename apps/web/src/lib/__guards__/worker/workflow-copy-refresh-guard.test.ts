/**
 * Every write to an existing workflows row refreshes the last-good copy in the
 * same request (#1845).
 *
 * The copy (engine/definition-loader.ts) is what a live lead runs when the
 * database is down. A route that saves, switches off, deletes or restores a
 * workflow and leaves the copy alone leaves an outage running the definition
 * from before the change, a switched off workflow included. So this reads every
 * worker source file, finds each route handler whose supabase chain writes an
 * existing `workflows` row (update, upsert or delete), and requires that handler
 * to await refreshWorkflowCaches after its last such write. A plain insert is
 * the one exemption, by its reason: it makes a new row whose id the database
 * mints, so no copy of that id can exist yet. A write outside any route handler
 * fails too, because no request is there to refresh the copy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource, consumeParens } from '../../__tests__/_scan-utils'

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const REFRESH_CALL = /\bawait\s+refreshWorkflowCaches\s*\(/g

interface Write { file: string; at: number; methods: string[] }
interface Handler { file: string; label: string; start: number; end: number }

/** The method names chained onto a `.from(...)`, read call by call. */
function chainAfter(src: string, start: number): string[] {
  const methods: string[] = []
  let i = start
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (src[i] !== '.') return methods
    const m = /^\.(\w+)\s*\(/.exec(src.slice(i))
    if (!m) return methods
    methods.push(m[1])
    i = consumeParens(src, i + m[0].length - 1)
  }
}

/** Every chain on `.from('workflows')` that writes, in source with comments blanked. */
function workflowWrites(file: string, src: string): Write[] {
  const writes: Write[] = []
  for (const m of src.matchAll(/\.from\(\s*(['"`])workflows\1\s*\)/g)) {
    const methods = chainAfter(src, (m.index ?? 0) + m[0].length)
    if (methods.some((name) => WRITE_METHODS.has(name))) writes.push({ file, at: m.index ?? 0, methods })
  }
  return writes
}

function createsANewRowOnly(write: Write): boolean {
  return write.methods.filter((name) => WRITE_METHODS.has(name)).every((name) => name === 'insert')
}

/** Route handlers, each running from its registration to the next one. */
function handlersOf(file: string, src: string): Handler[] {
  const starts = [...src.matchAll(/^\s*\w+\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]*)\2\s*,/gm)]
  return starts.map((m, k) => ({
    file,
    label: `${m[1].toUpperCase()} ${m[3]}`,
    start: m.index ?? 0,
    end: k + 1 < starts.length ? (starts[k + 1].index ?? src.length) : src.length,
  }))
}

function scan() {
  const writingHandlers = new Map<Handler, Write[]>()
  const refreshes = new Map<Handler, number[]>()
  const orphanWrites: Write[] = []
  for (const full of listTsFiles(WORKER_SRC)) {
    // Comments blanked, strings kept: the table name and route paths are strings.
    const src = sanitizeSource(readFileSync(full, 'utf8'), { blankStrings: false })
    const file = path.relative(WORKER_SRC, full)
    const handlers = handlersOf(file, src)
    const inHandler = (at: number) => handlers.find((h) => at >= h.start && at < h.end)
    for (const write of workflowWrites(file, src).filter((w) => !createsANewRowOnly(w))) {
      const handler = inHandler(write.at)
      if (!handler) { orphanWrites.push(write); continue }
      writingHandlers.set(handler, [...(writingHandlers.get(handler) ?? []), write])
    }
    for (const m of src.matchAll(REFRESH_CALL)) {
      const handler = inHandler(m.index ?? 0)
      if (handler) refreshes.set(handler, [...(refreshes.get(handler) ?? []), m.index ?? 0])
    }
  }
  return { writingHandlers, refreshes, orphanWrites }
}

describe('every write to an existing workflows row refreshes the last-good copy (#1845)', () => {
  const { writingHandlers, refreshes, orphanWrites } = scan()
  const labels = [...writingHandlers.keys()].map((h) => `${h.file} ${h.label}`)

  it('finds the routes it exists to check (a scan that found none would pass on nothing)', () => {
    for (const expected of [
      'routes/api/workflows.ts PUT /:id',
      'routes/api/workflows.ts PATCH /:id',
      'routes/api/workflows.ts DELETE /:id',
      'routes/api/workflows.ts POST /:id/versions/:version_id/restore',
      'routes/api/workflows.ts PATCH /:id/test-payloads',
    ]) {
      expect(labels).toContain(expected)
    }
  })

  it('has no write to an existing workflows row outside a route handler, where no request could refresh the copy', () => {
    expect(orphanWrites.map((w) => `${w.file} @${w.at} .${w.methods.join('.')}`)).toEqual([])
  })

  it('awaits refreshWorkflowCaches after the last write in every handler that writes one', () => {
    const missing: string[] = []
    for (const [handler, writes] of writingHandlers) {
      const lastWrite = Math.max(...writes.map((w) => w.at))
      const lastRefresh = Math.max(-1, ...(refreshes.get(handler) ?? []))
      if (lastRefresh < lastWrite) missing.push(`${handler.file} ${handler.label}`)
    }
    expect(missing).toEqual([])
  })
})

// The scanner itself, on text it must judge both ways.
describe('the scanner', () => {
  const blanked = (src: string) => sanitizeSource(src, { blankStrings: false })

  it('reads a write through a multi line chain whose arguments hold parentheses and strings', () => {
    const src = blanked(`x.put('/:id', async (c) => {\n  await supabase\n    .from('workflows')\n    .update({ at: new Date().toISOString(), note: ')' })\n    .eq('id', id)\n})\n`)
    expect(workflowWrites('f.ts', src)[0].methods).toEqual(['update', 'eq'])
  })

  it('does not count a read, or a write to another table, as a workflows write', () => {
    const src = blanked(`x.get('/', async (c) => {\n  await supabase.from('workflows').select('id').eq('id', id)\n  await supabase.from('workflow_versions').insert({})\n  await kv.delete(key)\n})\n`)
    expect(workflowWrites('f.ts', src)).toEqual([])
  })

  it('ignores a write that only appears in a comment', () => {
    const src = blanked(`// supabase.from('workflows').update(x)\n/* supabase.from('workflows').delete() */\nconst u = 'https://a.test'; supabase.from('workflows').upsert({})\n`)
    expect(workflowWrites('f.ts', src).map((w) => w.methods)).toEqual([['upsert']])
  })

  it('exempts only a plain insert: an update or upsert of an existing row is not exempt', () => {
    const at = { file: 'f.ts', at: 0 }
    expect(createsANewRowOnly({ ...at, methods: ['insert', 'select', 'single'] })).toBe(true)
    expect(createsANewRowOnly({ ...at, methods: ['upsert', 'select'] })).toBe(false)
    expect(createsANewRowOnly({ ...at, methods: ['update', 'eq'] })).toBe(false)
  })
})
