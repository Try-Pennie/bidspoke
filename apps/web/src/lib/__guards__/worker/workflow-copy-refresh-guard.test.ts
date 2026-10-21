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
import { WORKER_SRC, listTsFiles, sanitizeSource, chainCallsAfter, routeHandlersOf, type RouteHandler } from '../../__tests__/_scan-utils'

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])
const REFRESH_CALL = /\bawait\s+refreshWorkflowCaches\s*\(/g

interface Write { file: string; at: number; methods: string[] }
type Handler = RouteHandler

/** The method names chained onto a `.from(...)`, read call by call. */
function chainAfter(src: string, start: number): string[] {
  return chainCallsAfter(src, start).map((call) => call.name)
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

/** Route handlers, each from its registration to the next (the shared reader in _scan-utils). */
const handlersOf = routeHandlersOf

interface SourceScan {
  writingHandlers: Map<Handler, Write[]>
  refreshes: Map<Handler, number[]>
  orphanWrites: Write[]
}

/** One file's writes and refreshes, attributed to the handler each sits in. Comments blanked, strings kept. */
function scanSource(file: string, raw: string): SourceScan {
  const src = sanitizeSource(raw, { blankStrings: false })
  const writingHandlers = new Map<Handler, Write[]>()
  const refreshes = new Map<Handler, number[]>()
  const orphanWrites: Write[] = []
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
  return { writingHandlers, refreshes, orphanWrites }
}

/** Handlers whose last workflows write has no awaited refresh after it. */
function missingRefreshes({ writingHandlers, refreshes }: SourceScan): string[] {
  const missing: string[] = []
  for (const [handler, writes] of writingHandlers) {
    const lastWrite = Math.max(...writes.map((w) => w.at))
    const lastRefresh = Math.max(-1, ...(refreshes.get(handler) ?? []))
    if (lastRefresh < lastWrite) missing.push(`${handler.file} ${handler.label}`)
  }
  return missing
}

function scan(): SourceScan {
  const all: SourceScan = { writingHandlers: new Map(), refreshes: new Map(), orphanWrites: [] }
  for (const full of listTsFiles(WORKER_SRC)) {
    const one = scanSource(path.relative(WORKER_SRC, full), readFileSync(full, 'utf8'))
    for (const [h, w] of one.writingHandlers) all.writingHandlers.set(h, w)
    for (const [h, r] of one.refreshes) all.refreshes.set(h, r)
    all.orphanWrites.push(...one.orphanWrites)
  }
  return all
}

describe('every write to an existing workflows row refreshes the last-good copy (#1845)', () => {
  const result = scan()
  const { writingHandlers, orphanWrites } = result
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
    expect(missingRefreshes(result)).toEqual([])
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

  // A key value call on a line of its own (`kv.get('x', 'json')`) is shaped like a
  // route registration. Only the file's own Hono routers register routes, so it
  // must neither end the handler it sits in nor start one of its own.
  const plantedHandler = (between: string, after: string) => [
    'const workflows = new Hono()',
    "workflows.patch('/:id', async (c) => {",
    "  await supabase.from('workflows').update({ is_active: false }).eq('id', id)",
    between,
    after,
    '  return c.json({ ok: true })',
    '})',
    "workflows.get('/', async (c) => c.json([]))",
    '',
  ].join('\n')

  it('still fails a handler that writes workflows and never refreshes, with a key value call on a line of its own inside it', () => {
    const scanned = scanSource('planted.ts', plantedHandler("  kv.get('x', 'json')", "  kv.delete('y', 1)"))
    expect(missingRefreshes(scanned)).toEqual(['planted.ts PATCH /:id'])
    expect([...scanned.writingHandlers.keys()].map((h) => h.label)).toEqual(['PATCH /:id'])
  })

  it('passes that handler once it refreshes after the key value call, which the call must not cut off', () => {
    const scanned = scanSource('planted.ts', plantedHandler("  kv.get('x', 'json')", '  await refreshWorkflowCaches(id, c.env.WORKFLOW_CACHE, supabase)'))
    expect(missingRefreshes(scanned)).toEqual([])
  })

  it('reads routes registered on every router the file declares, and on nothing else', () => {
    const src = sanitizeSource([
      'const app = new Hono<{ Bindings: Env }>()',
      'const admin = new Hono()',
      "app.get('/a', (c) => c.text('a'))",
      "admin.post('/b', (c) => c.text('b'))",
      "  cache.all('/c', x)",
      '',
    ].join('\n'), { blankStrings: false })
    expect(handlersOf('f.ts', src).map((h) => h.label)).toEqual(['GET /a', 'POST /b'])
  })

  it('exempts only a plain insert: an update or upsert of an existing row is not exempt', () => {
    const at = { file: 'f.ts', at: 0 }
    expect(createsANewRowOnly({ ...at, methods: ['insert', 'select', 'single'] })).toBe(true)
    expect(createsANewRowOnly({ ...at, methods: ['upsert', 'select'] })).toBe(false)
    expect(createsANewRowOnly({ ...at, methods: ['update', 'eq'] })).toBe(false)
  })
})
