/**
 * Base against head, fixture by fixture (#1704).
 *
 * The money gate does not know the right answer for a lead. It knows what the
 * merge base did with it and what the head does with it, and any difference is a
 * behaviour change the pull request has to own. Each difference names the
 * fixture, the check that found it, the node and the field, so a red gate says
 * which of the things that move money moved (L154).
 */
import type { RecordedWrite } from './supabase-double'

export interface RouteRecord { node: string; namespace: string; type: string; route: string }
export interface OutboundRecord {
  via: 'engine' | 'code'
  /** The node that made the request: the code chain's namespaces, or the engine step running at the time. */
  node: string
  method: string
  host: string
  path: string
  headers: Record<string, string>
  body: unknown
}
export interface CodeDispatchRecord { binding: string; name: string; path: string; namespaces: string[] }

export interface FixtureRecord {
  id: string
  workflow_id: string
  workflow_name: string
  variant: string
  trigger: unknown
  routes: RouteRecord[]
  nodes_executed: string[]
  final_node: string | null
  response: { status: number; body: unknown; headers?: Record<string, string> }
  outbound: OutboundRecord[]
  code_dispatch: CodeDispatchRecord[]
  supabase_writes: RecordedWrite[]
  do_state: Record<string, unknown>
  kv_state: Record<string, unknown>
  error?: string
}

export interface WorkflowArms {
  workflow_id: string
  workflow_name: string
  /** Every node namespace in the definition. */
  nodes: string[]
  /** Every multi output node and the handles wired out of it. */
  arms: Array<{ node: string; namespace: string; handles: string[] }>
}

export interface Transcript {
  version: 1
  side: 'base' | 'head'
  fixtures: FixtureRecord[]
  workflows: WorkflowArms[]
  unstubbed_hosts: string[]
  unknown_tables: string[]
  /** Queries the Supabase double answered loosely (an or filter, an undeclared embed). */
  unsupported_queries?: string[]
}

export const CHECKS = [
  'fixture_set', 'error', 'golden_trigger', 'route', 'nodes_executed', 'final_node', 'response',
  'outbound_request', 'code_namespace', 'supabase_write', 'do_state', 'kv_state',
] as const

export type Check = (typeof CHECKS)[number]

export interface Difference {
  fixture: string
  check: Check
  node?: string
  field: string
  base: unknown
  head: unknown
}

const MAX_PER_CHECK = 20

export function canonical(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export function deepDiff(base: unknown, head: unknown, path = ''): Array<{ path: string; base: unknown; head: unknown }> {
  if (canonical(base) === canonical(head)) return []
  const bothObjects = base && head && typeof base === 'object' && typeof head === 'object' && Array.isArray(base) === Array.isArray(head)
  if (!bothObjects) return [{ path: path || '(value)', base, head }]
  const out: Array<{ path: string; base: unknown; head: unknown }> = []
  if (Array.isArray(base)) {
    const h = head as unknown[]
    const n = Math.max(base.length, h.length)
    for (let i = 0; i < n; i++) out.push(...deepDiff(base[i], h[i], `${path}[${i}]`))
    return out
  }
  const b = base as Record<string, unknown>
  const hh = head as Record<string, unknown>
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(hh)])].sort()) {
    out.push(...deepDiff(b[k], hh[k], path ? `${path}.${k}` : k))
  }
  return out
}

function routeKeyed(routes: RouteRecord[]): Map<string, RouteRecord> {
  const seen = new Map<string, number>()
  const out = new Map<string, RouteRecord>()
  for (const r of routes) {
    const n = seen.get(r.node) ?? 0
    seen.set(r.node, n + 1)
    out.set(n === 0 ? r.node : `${r.node}#${n + 1}`, r)
  }
  return out
}

/**
 * Order is not part of what is compared where the engine runs things concurrently:
 * a bid group calls its partners at once, so their requests and their step rows land
 * in whichever order the answers do. Requests sort by target then content; rows inside
 * one write sort by step order then namespace (or content), so a changed field stays
 * aligned with its own row and is named.
 */
const outboundKey = (r: OutboundRecord) => `${r.via} ${r.method} ${r.host}${r.path} ${canonical(r.body)}`

function rowKey(r: unknown): string {
  if (r && typeof r === 'object' && 'step_namespace' in r) {
    const row = r as Record<string, unknown>
    return `${String(row.step_order ?? '').padStart(8, '0')} ${String(row.step_namespace)}`
  }
  return canonical(r)
}

function normalizeWrite(w: RecordedWrite): RecordedWrite {
  return Array.isArray(w.values) ? { ...w, values: [...w.values].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0)) } : w
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

function compareFixture(b0: FixtureRecord, h0: FixtureRecord): Difference[] {
  const b = { ...b0, outbound: [...b0.outbound].sort(byKey(outboundKey)), supabase_writes: b0.supabase_writes.map(normalizeWrite) }
  const h = { ...h0, outbound: [...h0.outbound].sort(byKey(outboundKey)), supabase_writes: h0.supabase_writes.map(normalizeWrite) }
  const out: Difference[] = []
  // At most MAX_PER_CHECK differences per check per fixture: the first ones name the fault.
  const add = (items: Difference[]) => out.push(...items.slice(0, MAX_PER_CHECK))
  const id = b.id

  if ((b.error ?? null) !== (h.error ?? null)) add([{ fixture: id, check: 'error', field: 'error', base: b.error ?? null, head: h.error ?? null }])

  add(deepDiff(b.trigger, h.trigger, 'trigger').map((d) => ({ fixture: id, check: 'golden_trigger', field: d.path, base: d.base, head: d.head })))

  const br = routeKeyed(b.routes)
  const hr = routeKeyed(h.routes)
  const routeDiffs: Difference[] = []
  for (const key of [...new Set([...br.keys(), ...hr.keys()])]) {
    const x = br.get(key)
    const y = hr.get(key)
    if (x?.route !== y?.route) routeDiffs.push({ fixture: id, check: 'route', node: (x ?? y)!.namespace, field: 'route', base: x?.route ?? '(not reached)', head: y?.route ?? '(not reached)' })
  }
  add(routeDiffs)

  if (canonical(b.nodes_executed) !== canonical(h.nodes_executed)) {
    add([{ fixture: id, check: 'nodes_executed', field: 'nodes_executed', base: b.nodes_executed, head: h.nodes_executed }])
  }
  if (b.final_node !== h.final_node) add([{ fixture: id, check: 'final_node', field: 'final_node', base: b.final_node, head: h.final_node }])
  add(deepDiff(b.response, h.response, 'response').map((d) => ({ fixture: id, check: 'response', field: d.path, base: d.base, head: d.head })))

  const outDiffs: Difference[] = []
  const n = Math.max(b.outbound.length, h.outbound.length)
  if (b.outbound.length !== h.outbound.length) {
    outDiffs.push({ fixture: id, check: 'outbound_request', field: 'outbound.length', base: b.outbound.length, head: h.outbound.length })
  }
  for (let i = 0; i < n; i++) {
    const x = b.outbound[i]
    const y = h.outbound[i]
    const label = (r: OutboundRecord) => `outbound[${i}] ${r.method} ${r.host}${r.path}`
    if (!x || !y) {
      outDiffs.push({ fixture: id, check: 'outbound_request', node: (x ?? y)!.node, field: label((x ?? y)!), base: x ? 'sent' : '(not sent)', head: y ? 'sent' : '(not sent)' })
      continue
    }
    const keyX = `${x.method} ${x.host}${x.path}`
    const keyY = `${y.method} ${y.host}${y.path}`
    if (keyX !== keyY) {
      outDiffs.push({ fixture: id, check: 'outbound_request', node: y.node, field: `outbound[${i}] target`, base: keyX, head: keyY })
      continue
    }
    for (const d of deepDiff({ headers: x.headers, body: x.body, via: x.via }, { headers: y.headers, body: y.body, via: y.via })) {
      outDiffs.push({ fixture: id, check: 'outbound_request', node: y.node, field: `${label(y)} ${d.path}`, base: d.base, head: d.head })
    }
  }
  add(outDiffs)

  const codeDiffs: Difference[] = []
  const m = Math.max(b.code_dispatch.length, h.code_dispatch.length)
  for (let i = 0; i < m; i++) {
    const x = b.code_dispatch[i]
    const y = h.code_dispatch[i]
    const node = ((y ?? x)!.namespaces ?? []).join(',')
    for (const d of deepDiff(x, y, `code_dispatch[${i}]`)) codeDiffs.push({ fixture: id, check: 'code_namespace', node, field: d.path, base: d.base, head: d.head })
  }
  add(codeDiffs)

  const bw = b.supabase_writes.map(canonical).sort()
  const hw = h.supabase_writes.map(canonical).sort()
  if (canonical(bw) !== canonical(hw)) {
    const onlyBase = bw.filter((w) => !hw.includes(w))
    const onlyHead = hw.filter((w) => !bw.includes(w))
    const describe = (w: string) => { const p = JSON.parse(w) as RecordedWrite; return `${p.op} ${p.table}` }
    const writeDiffs: Difference[] = []
    // Pair a base only write with a head only write on the same table and op, so the
    // field that changed is named rather than two whole rows.
    const pool = [...onlyHead]
    for (const w of onlyBase) {
      const j = pool.findIndex((x) => describe(x) === describe(w))
      if (j >= 0) {
        const other = pool.splice(j, 1)[0]
        for (const d of deepDiff(JSON.parse(w), JSON.parse(other))) writeDiffs.push({ fixture: id, check: 'supabase_write', node: describe(w), field: `${describe(w)} ${d.path}`, base: d.base, head: d.head })
      } else {
        writeDiffs.push({ fixture: id, check: 'supabase_write', node: describe(w), field: describe(w), base: 'written', head: '(not written)' })
      }
    }
    for (const w of pool) writeDiffs.push({ fixture: id, check: 'supabase_write', node: describe(w), field: describe(w), base: '(not written)', head: 'written' })
    add(writeDiffs)
  }

  add(deepDiff(b.do_state, h.do_state, 'do_state').map((d) => ({ fixture: id, check: 'do_state', field: d.path, base: d.base, head: d.head })))
  add(deepDiff(b.kv_state, h.kv_state, 'kv_state').map((d) => ({ fixture: id, check: 'kv_state', field: d.path, base: d.base, head: d.head })))
  return out
}

export function compareTranscripts(base: Transcript, head: Transcript): Difference[] {
  const out: Difference[] = []
  const bm = new Map(base.fixtures.map((f) => [f.id, f]))
  const hm = new Map(head.fixtures.map((f) => [f.id, f]))
  for (const id of [...new Set([...bm.keys(), ...hm.keys()])].sort()) {
    const b = bm.get(id)
    const h = hm.get(id)
    if (!b || !h) {
      out.push({ fixture: id, check: 'fixture_set', field: 'fixture', base: b ? 'ran' : '(absent)', head: h ? 'ran' : '(absent)' })
      continue
    }
    out.push(...compareFixture(b, h))
  }
  return out
}

function show(v: unknown): string {
  const s = v === undefined ? 'undefined' : JSON.stringify(v)
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}

export function formatDifferences(diffs: Difference[]): string {
  return diffs
    .map((d) => `[${d.check}] ${d.fixture}${d.node ? ` node ${d.node}` : ''} field ${d.field}: base ${show(d.base)} head ${show(d.head)}`)
    .join('\n')
}

export function coverageReport(t: Transcript): { text: string; failures: string[] } {
  const lines: string[] = []
  const failures: string[] = []
  for (const wf of t.workflows) {
    const fixtures = t.fixtures.filter((f) => f.workflow_id === wf.workflow_id)
    const executed = new Set(fixtures.flatMap((f) => f.nodes_executed))
    const reached = new Set(fixtures.flatMap((f) => f.routes.map((r) => `${r.namespace} -> ${r.route}`)))
    const armNames = wf.arms.flatMap((a) => a.handles.map((h) => `${a.namespace} -> ${h}`))
    const hit = armNames.filter((a) => reached.has(a))
    const miss = armNames.filter((a) => !reached.has(a))
    const notExecuted = wf.nodes.filter((n) => !executed.has(n))
    lines.push(`${wf.workflow_name}: ${fixtures.length} fixtures, nodes executed ${[...executed].filter((n) => wf.nodes.includes(n)).length} of ${wf.nodes.length}, arms reached ${hit.length} of ${armNames.length}`)
    lines.push(`  reached: ${hit.join('; ') || '(none)'}`)
    lines.push(`  not reached: ${miss.join('; ') || '(none)'}`)
    lines.push(`  not executed: ${notExecuted.join(', ') || '(none)'}`)
    const errored = fixtures.filter((f) => f.error)
    if (errored.length) lines.push(`  fixtures that threw: ${errored.map((f) => f.variant).join(', ')}`)
    if (executed.size === 0) failures.push(`${wf.workflow_name} executed no node in any fixture`)
  }
  if (t.unstubbed_hosts.length) lines.push(`hosts with no stub rule (answered 599): ${t.unstubbed_hosts.join(', ')}`)
  if (t.unsupported_queries?.length) lines.push(`queries the Supabase double answered loosely: ${t.unsupported_queries.join('; ')}`)
  if (t.unknown_tables.length) lines.push(`tables read that the snapshot does not hold (answered empty): ${t.unknown_tables.join(', ')}`)
  return { text: lines.join('\n'), failures }
}
