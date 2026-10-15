/**
 * Whether a run's work still out at the cut-off pages (#2024, phase F of #2015).
 *
 * It stays quiet only when every step the walk was on is a write the Salesforce
 * read-back holds as its own, and nothing left to walk can do anything outside
 * the run. Anything else pages, and so does any doubt about the record.
 */
import { describe, it, expect } from 'vitest'
import type { WorkflowDefinition } from '../../types'
import { unfinishedWorkPages, UNFINISHED_READ_DEADLINE_MS } from '../unfinished-work'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'

type Node = { id: string; namespace: string; type: string; config?: Record<string, unknown>; children?: string[] }

function def(nodes: Node[], edges: Array<[string, string]>): Pick<WorkflowDefinition, 'nodes' | 'edges'> {
  return {
    nodes: nodes.map((n) => ({ config: {}, ...n })) as unknown as WorkflowDefinition['nodes'],
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
  }
}

const held = (...namespaces: string[]) => {
  const asked: string[] = []
  return {
    asked,
    deps: {
      clock: new VirtualClock(),
      readBackHolds: async (ns: string) => {
        asked.push(ns)
        return namespaces.includes(ns)
      },
    },
  }
}

const patch = { id: 'p', namespace: 'patch_prospect', type: 'salesforce', config: { operation: 'update' } }
const end = { id: 'end', namespace: 'route_end', type: 'branch_end' }

describe('unfinishedWorkPages (#2024)', () => {
  it('stays quiet when the only step still out is a write the read-back holds, with nothing after it that sends', async () => {
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch, end], [['p', 'end']]), ['patch_prospect'], deps)).toBe(false)
  })

  it('pages when a recorded write is followed by a step the read-back does not track', async () => {
    const achieve = { id: 'a', namespace: 'achieve_after', type: 'achieve_offers' }
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch, achieve], [['p', 'a']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when one of the steps still running is held and another is not', async () => {
    const code = { id: 'c', namespace: 'shape_body', type: 'code' }
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch, code], []), ['patch_prospect', 'shape_body'], deps)).toBe(true)
  })

  it('pages when the step still out is a write the read-back does not hold', async () => {
    const { deps } = held()
    expect(await unfinishedWorkPages(def([patch, end], [['p', 'end']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when a later write is still to be walked, even one the read-back would hold once it runs', async () => {
    const next = { id: 'q', namespace: 'patch_lead', type: 'salesforce', config: { operation: 'update' } }
    const { deps } = held('patch_prospect', 'patch_lead')
    expect(await unfinishedWorkPages(def([patch, end, next], [['p', 'end'], ['end', 'q']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('follows a fallback node, which the walk reaches without an edge', async () => {
    const fallbackPatch = { ...patch, config: { operation: 'update', on_error: 'fallback', fallback_node: 'w' } }
    const relay = { id: 'w', namespace: 'relay_post', type: 'webhook' }
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([fallbackPatch, relay], []), ['patch_prospect'], deps)).toBe(true)
  })

  it('follows a parallel node\'s listed children', async () => {
    const fork = { id: 'f', namespace: 'fork', type: 'parallel', children: ['c'] }
    const code = { id: 'c', namespace: 'child', type: 'code' }
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch, fork, code], [['p', 'f']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when nothing says what was running', async () => {
    const { deps, asked } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch], []), [], deps)).toBe(true)
    expect(asked).toEqual([])
  })

  it('pages when a running step is not in the definition', async () => {
    const { deps } = held('ghost')
    expect(await unfinishedWorkPages(def([patch], []), ['ghost'], deps)).toBe(true)
  })

  it('pages when an edge leads to a node the definition does not hold', async () => {
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch], [['p', 'missing']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when a step still to be walked has a type this build does not know', async () => {
    const odd = { id: 'o', namespace: 'odd', type: 'teleport' }
    const { deps } = held('patch_prospect')
    expect(await unfinishedWorkPages(def([patch, odd], [['p', 'o']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when the record cannot be read', async () => {
    const deps = { clock: new VirtualClock(), readBackHolds: async () => { throw new Error('KV GET failed: 503') } }
    expect(await unfinishedWorkPages(def([patch, end], [['p', 'end']]), ['patch_prospect'], deps)).toBe(true)
  })

  it('pages when the record does not answer in time, without waiting past its deadline', async () => {
    const clock = new VirtualClock()
    const deps = { clock, readBackHolds: () => clock.hang() as Promise<boolean> }
    const verdict = unfinishedWorkPages(def([patch, end], [['p', 'end']]), ['patch_prospect'], deps)
    let settledAt = -1
    void verdict.then(() => { settledAt = clock.now() })
    await clock.run()
    expect(await verdict).toBe(true)
    expect(settledAt).toBe(UNFINISHED_READ_DEADLINE_MS)
  })
})
