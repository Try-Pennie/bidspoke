/**
 * Every worker surface keyed by node type covers every node type (#1411, L233).
 *
 * Two worker sites cannot be typed: the shadow side effect guard's exemption
 * list, which names EXECUTOR FILES (`bid-group`) rather than node types
 * (`bid_group`), and the changelog drafter's prose glossary inside a prompt.
 * Both are checked here by mapping each node type through its executorFile
 * trait, so the comparison is between like and like. The trait itself is
 * checked against the disk: every named executor file exists, and every card's
 * declared sources exist, so neither list can point at a file that was renamed.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES, type NodeType } from '@bidspoke/node-types'
import { SHADOW_EXEMPT_NODES, SHADOW_GUARD_RE } from '../../shadow-side-effect-guard'
import { CARD_EXECUTORS } from '../../node-card-config-guard'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

describe('executorFile trait against the worker tree', () => {
  it('every named executor file exists under engine/nodes', () => {
    const missing = NODE_TYPES.filter((t) => {
      const file = NODE_TRAITS[t].executorFile
      return file !== null && !existsSync(path.join(WORKER_SRC, 'engine/nodes', `${file}.ts`))
    })
    expect(missing).toEqual([])
  })

  it('the types with no executor file are exactly the ones executeNode handles inline or the walker owns', () => {
    const inline = NODE_TYPES.filter((t) => NODE_TRAITS[t].executorFile === null).sort()
    expect(inline).toEqual(['branch_end', 'exit', 'parallel_end'])
    // The executor registry (#1707): one entry per type inside the EXECUTORS record.
    const src = readFileSync(path.join(WORKER_SRC, 'engine/nodes/index.ts'), 'utf8')
    const start = src.indexOf('const EXECUTORS: Record<NodeType, NodeExecutor> = {')
    expect(start, 'engine/nodes/index.ts has no EXECUTORS registry').toBeGreaterThan(-1)
    const registry = src.slice(start, src.indexOf('\n}\n', start))
    for (const t of inline) expect(registry, `the executor registry has an entry for ${t}`).toMatch(new RegExp(`\\n  ${t}: `))
  })

  it('every card source the config guard names exists', () => {
    const missing = Object.entries(CARD_EXECUTORS).flatMap(([card, { sources }]) =>
      sources.filter((s) => !existsSync(path.join(WORKER_SRC, s))).map((s) => `${card}: ${s}`)
    )
    expect(missing).toEqual([])
  })
})

describe('shadow side effect exemptions', () => {
  /**
   * Every saved node type is, through its executor file, either exempt (pure),
   * shadow aware (carries a shadow guard, checked by the shadow guard test), or
   * has no executor file of its own. A type in none of those is a new executor
   * nobody classified, which the shadow guard would also report, but only once
   * a shadow run reaches it.
   */
  const SHADOW_AWARE: Partial<Record<NodeType, string>> = {
    code: 'dispatches a Workers for Platforms script; short circuits under the shadow flag',
    partner_bid: 'calls a partner API; short circuits under the shadow flag',
    webhook: 'makes an outbound HTTP call; short circuits under the shadow flag',
    salesforce: 'writes Salesforce; short circuits under the shadow flag',
    data_store: 'writes KV; skips the write under the shadow flag',
    latency_gate: 'writes a KV mark; short circuits under the shadow flag',
    achieve_offers: 'calls Achieve; short circuits under the shadow flag',
    buyer_select: 'sells a lead to a buyer; a shadow or test run evaluates and reports only, claiming, reserving, calling and mirroring nothing',
    buyer_click_send: 'posts a click to a buyer; a shadow or test run validates and reports only, claiming, sending, counting and paging nothing',
  }

  it('places every node type with an executor file as exempt or shadow aware, never both, never neither', () => {
    const problems: string[] = []
    for (const t of NODE_TYPES) {
      const file = NODE_TRAITS[t].executorFile
      if (file === null) continue
      const exempt = SHADOW_EXEMPT_NODES.includes(file)
      const aware = SHADOW_AWARE[t]
      if (exempt && aware) problems.push(`${t} (${file}): exempt and shadow aware`)
      if (!exempt && !aware) problems.push(`${t} (${file}): neither exempt nor shadow aware`)
    }
    expect(problems).toEqual([])
  })

  it('every shadow aware executor really carries a shadow guard token', () => {
    for (const [t, reason] of Object.entries(SHADOW_AWARE) as Array<[NodeType, string]>) {
      const file = NODE_TRAITS[t].executorFile
      expect(file, `${t} has an executor file`).not.toBeNull()
      const src = readFileSync(path.join(WORKER_SRC, 'engine/nodes', `${file}.ts`), 'utf8')
      expect(src, `${t}: ${reason}`).toMatch(SHADOW_GUARD_RE)
    }
  })
})

describe('changelog drafter glossary', () => {
  it('names every saved node type, so the drafter can describe a change to any of them', () => {
    const src = readFileSync(path.join(WORKER_SRC, 'lib/changelog-drafter.ts'), 'utf8')
    const glossary = src.slice(src.indexOf('Common node types and what they do:'), src.indexOf('Rules:'))
    expect(glossary.length).toBeGreaterThan(100)
    const missing = NODE_TYPES.filter((t) => !new RegExp(`(^|[\\s/-])${t}(?=[:/\\s])`, 'm').test(glossary))
    expect(missing).toEqual([])
  })

  it('does not teach the drafter a spelling that is not a node type', () => {
    const src = readFileSync(path.join(WORKER_SRC, 'lib/changelog-drafter.ts'), 'utf8')
    const glossary = src.slice(src.indexOf('Common node types and what they do:'), src.indexOf('Rules:'))
    expect(glossary).not.toMatch(/\bintegration\b/)
  })
})
