import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The ops Worker's own config (#1709 part 3, plan 0.E): its lane, its code
 * namespace and that namespace's outbound Worker, and its tail consumer.
 *
 * src/ops/index.ts refuses every request unless LANE is "ops", so the var is
 * what lets it serve at all. The namespace's outbound Worker must be the ops
 * one, never the compare one (a shadow run's deny Worker, which Phase 2 must
 * not loosen) and never absent (the platform would then send ops code's
 * requests straight to the internet).
 */
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/** The bodies of every `[name]` or `[[name]]` table, each up to the next header. */
function tables(toml: string, name: string): string[] {
  const header = new RegExp(`^\\[{1,2}${name.replace(/\./g, '\\.')}\\]{1,2}\\s*$`)
  const out: string[] = []
  let current: string[] | null = null
  for (const line of toml.split('\n')) {
    if (/^\[/.test(line)) {
      if (current) out.push(current.join('\n'))
      current = header.test(line) ? [] : null
    } else if (current) current.push(line)
  }
  if (current) out.push(current.join('\n'))
  return out
}

describe('wrangler.ops.toml (#1709)', () => {
  const toml = read('apps/worker/wrangler.ops.toml')

  it('reads the tables it asserts on, so a renamed header fails rather than passing on nothing', () => {
    expect(tables(toml, 'r2_buckets')).toHaveLength(1)
    expect(tables(toml, 'r2_buckets')[0]).toMatch(/^binding = "PORTING_TEE"$/m)
    expect(tables(toml, 'nothing_here')).toEqual([])
  })

  it('sets LANE to ops, without which the Worker serves nothing', () => {
    expect(tables(toml, 'vars')).toHaveLength(1)
    expect(tables(toml, 'vars')[0]).toMatch(/^LANE = "ops"$/m)
  })

  it('binds the ops code namespace with the ops outbound Worker, never the compare or bidding namespace', () => {
    const namespaces = tables(toml, 'dispatch_namespaces')
    expect(namespaces).toHaveLength(1)
    expect(namespaces[0]).toMatch(/^binding = "CODE_NODES_OPS"$/m)
    expect(namespaces[0]).toMatch(/^namespace = "bidspoke-code-nodes-ops"$/m)
    expect(namespaces[0]).toMatch(/^outbound = \{ service = "bidspoke-ops-outbound" \}$/m)
  })

  it('names the outbound Worker the ops-outbound app deploys', () => {
    expect(read('apps/ops-outbound/wrangler.toml')).toMatch(/^name = "bidspoke-ops-outbound"$/m)
  })

  it('sends its traces to the tail consumer, which skips them until Phase 1', () => {
    const tails = tables(toml, 'tail_consumers')
    expect(tails).toHaveLength(1)
    expect(tails[0]).toMatch(/^service = "bidspoke-worker-tail"$/m)
    expect(read('apps/worker-tail/wrangler.toml')).toMatch(/^name = "bidspoke-worker-tail"$/m)
  })

  it('still holds no binding of the bidding Worker: no KV, no Durable Object, no service binding', () => {
    for (const name of ['kv_namespaces', 'durable_objects.bindings', 'services', 'd1_databases', 'hyperdrive']) {
      expect(tables(toml, name), name).toEqual([])
    }
  })
})
