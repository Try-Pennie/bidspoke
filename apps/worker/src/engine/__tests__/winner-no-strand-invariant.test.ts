/**
 * The load-bearing invariant: winning Engine leads do not strand (#377).
 *
 * A winning lead's outcome is finalized in a post-response continuation (the
 * block-2 finalize in engine/index.ts). That continuation only completes because
 * the winning path keeps the Cloudflare isolate alive past the early response:
 * after the Offer Response is sent, the walk continues to the Salesforce
 * prospect writeback (the `patch_prospect` node), and that post-response work is
 * what holds the isolate open long enough for the finalize to land. Measured
 * 2026 during #353 Phase 3: 0 of 5,450 winners stranded in a 48h sample, which
 * is why the strand drain's winner-flip path has never run in production and is
 * validated only synthetically (#366).
 *
 * This is an invisible structural dependency on the WORKFLOW DEFINITION, not on
 * engine code. If the Engine flow is ever reordered so the Salesforce writeback
 * runs BEFORE the response (or is removed), winners would begin stranding and the
 * untested-in-production winner-flip + per-attempt bid recovery would suddenly
 * carry real traffic. A prose note alone is a hope (L27), so this guards the
 * invariant against the in-repo money-gate snapshot of the live definition.
 *
 * LIMIT: CI cannot read the live DB definition, so this is a snapshot check. A
 * live reorder is caught when the fixture is next refreshed from production
 * (which a definition change drives anyway, because the money gate replays the
 * definition), not at the instant of the reorder. A runtime monitor that reads
 * the live definition would close that window; it is beyond this documentation
 * issue and is filed as a #377 follow-up.
 *
 * See docs/adr/0002-observability-vs-outcome-write-tiers.md and the finalize
 * comment in engine/index.ts.
 */
import { describe, it, expect } from 'vitest'
// Read the fixture through Vite's ?raw suffix rather than node:fs, because the
// worker tsconfig targets the Workers runtime and carries no Node types (the
// same pattern as archive/__tests__/archived-columns.test.ts). The fixture is
// keyed by the Engine workflow's stable production id; if that file is removed or
// renamed this import fails loudly, and the name assertion below catches a swap.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text; there is no
// ambient declaration for it in this package.
import ENGINE_FIXTURE_RAW from '../../../money-gate/fixtures/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json?raw'

const ENGINE_WORKFLOW_NAME = 'Engine Bidding Workflow'
/** The winner response node (sends the offer), and the Salesforce writeback that must follow it. */
const WINNER_RESPONSE = 'offer_response'
const WINNER_WRITEBACK = 'patch_prospect'

interface DefNode { id: string; namespace: string; config?: { continue_after_response?: boolean } }
interface DefEdge { source: string; target: string }
interface Definition { nodes: DefNode[]; edges: DefEdge[] }

/**
 * Does this node send its response and then CONTINUE the walk (post-response),
 * rather than terminating at the response? That flag is what makes the
 * downstream writeback run at all after the caller is answered, and run in the
 * background that holds the isolate open. Edge-reachability alone does not
 * capture it: without this flag the walk stops at the response and the writeback
 * never runs, so the invariant needs both.
 */
function continuesAfterResponse(def: Definition, namespace: string): boolean {
  return def.nodes.find((n) => n.namespace === namespace)?.config?.continue_after_response === true
}

/**
 * Is `to` reachable downstream of `from` by following edges, with both nodes
 * addressed by namespace? Edges address nodes by id, so this maps namespace to
 * id first. Returns false if either namespace is absent, so a renamed node reads
 * as "not downstream" and trips the guard rather than passing silently.
 */
function reachableDownstream(def: Definition, from: string, to: string): boolean {
  const idByNs = new Map(def.nodes.map((n) => [n.namespace, n.id]))
  const startId = idByNs.get(from)
  const targetId = idByNs.get(to)
  if (startId === undefined || targetId === undefined) return false
  const adj = new Map<string, string[]>()
  for (const e of def.edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }
  const seen = new Set<string>()
  const queue = [startId]
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const next of adj.get(node) ?? []) {
      if (next === targetId) return true
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

/**
 * Does EVERY path leaving `from` reach `to` before it ends? This is stronger
 * than reachability: a winner must ALWAYS run the writeback, so a branch after
 * the response where one arm skips the writeback would satisfy reachability
 * (some path reaches it) but not this (one path ends without it). A terminal
 * that is not `to`, and a cycle that can keep looping without passing through
 * `to`, both count as a way for a winner to finish without the writeback.
 *
 * Computed as a least fixpoint rather than a DFS, so it is sound with cycles: a
 * node "always reaches `to`" iff it is `to`, or it has successors and ALL of
 * them always reach `to`. A node that can loop forever off `to` never enters the
 * set. (A stack-dependent DFS memo would cache a cycle's "false" against a node
 * that is true on another path.)
 */
function alwaysReaches(def: Definition, from: string, to: string): boolean {
  const idByNs = new Map(def.nodes.map((n) => [n.namespace, n.id]))
  const startId = idByNs.get(from)
  const targetId = idByNs.get(to)
  if (startId === undefined || targetId === undefined) return false
  const adj = new Map<string, string[]>()
  for (const e of def.edges) {
    const list = adj.get(e.source) ?? []
    list.push(e.target)
    adj.set(e.source, list)
  }
  const always = new Set<string>([targetId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of def.nodes) {
      if (always.has(node.id)) continue
      const outs = adj.get(node.id) ?? []
      if (outs.length > 0 && outs.every((t) => always.has(t))) {
        always.add(node.id)
        changed = true
      }
    }
  }
  return always.has(startId)
}

function loadEngineDefinition(): Definition {
  const fixture = JSON.parse(ENGINE_FIXTURE_RAW as string) as { name?: string; definition?: Definition }
  if (fixture.name !== ENGINE_WORKFLOW_NAME || !fixture.definition) {
    throw new Error(
      `The money-gate fixture imported for the #377 guard is not "${ENGINE_WORKFLOW_NAME}" (got "${fixture.name}"). ` +
        `The Engine workflow fixture was renamed or swapped; re-verify the winner path and update the guard.`,
    )
  }
  return fixture.definition
}

describe('reachableDownstream (the invariant checker has teeth)', () => {
  const nodes = [
    { id: 'a', namespace: WINNER_RESPONSE },
    { id: 'b', namespace: WINNER_WRITEBACK },
  ]

  it('sees the writeback as downstream when the response comes first (the healthy order)', () => {
    const def: Definition = { nodes, edges: [{ source: 'a', target: 'b' }] }
    expect(reachableDownstream(def, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(true)
  })

  it('sees the writeback as NOT downstream, and the response as downstream of it, in the stranding order', () => {
    // The failure #377 is about: the Salesforce writeback moved ahead of the
    // response, so nothing holds the isolate open and winners begin to strand.
    // Both directions are asserted, so the real-fixture guard's "writeback is
    // downstream of the response" AND its "response is not downstream of the
    // writeback" checks each have teeth here.
    const def: Definition = { nodes, edges: [{ source: 'b', target: 'a' }] }
    expect(reachableDownstream(def, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(false)
    expect(reachableDownstream(def, WINNER_WRITEBACK, WINNER_RESPONSE)).toBe(true)
  })

  it('reads a renamed node as not downstream rather than passing silently', () => {
    const def: Definition = { nodes, edges: [{ source: 'a', target: 'b' }] }
    expect(reachableDownstream(def, WINNER_RESPONSE, 'renamed_writeback')).toBe(false)
  })

  it('requires EVERY path to reach the writeback, not just one, so a branch that skips it fails', () => {
    const branchNodes = [
      { id: 'r', namespace: WINNER_RESPONSE },
      { id: 'br', namespace: 'branch' },
      { id: 'w', namespace: WINNER_WRITEBACK },
      { id: 'end', namespace: 'skip_end' },
    ]
    // One arm reaches the writeback, the other ends without it: a winner down the
    // second arm strands. Reachability would pass; alwaysReaches must not.
    const def: Definition = {
      nodes: branchNodes,
      edges: [
        { source: 'r', target: 'br' },
        { source: 'br', target: 'w' },
        { source: 'br', target: 'end' },
      ],
    }
    expect(reachableDownstream(def, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(true)
    expect(alwaysReaches(def, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(false)
  })

  it('alwaysReaches passes an unconditional chain through to the writeback', () => {
    const chain = [
      { id: 'r', namespace: WINNER_RESPONSE },
      { id: 'm', namespace: 'middle' },
      { id: 'w', namespace: WINNER_WRITEBACK },
    ]
    const def: Definition = { nodes: chain, edges: [{ source: 'r', target: 'm' }, { source: 'm', target: 'w' }] }
    expect(alwaysReaches(def, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(true)
  })

  it('is sound with cycles: a loop that still always reaches the writeback passes, one that can avoid it fails', () => {
    // A back-edge from the writeback does not change that every path reaches it.
    const throughTarget: Definition = {
      nodes: [{ id: 'r', namespace: WINNER_RESPONSE }, { id: 'w', namespace: WINNER_WRITEBACK }],
      edges: [{ source: 'r', target: 'w' }, { source: 'w', target: 'r' }],
    }
    expect(alwaysReaches(throughTarget, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(true)

    // A loop the response can enter that never passes through the writeback: a
    // winner could spin there forever without the writeback, so this must fail
    // (and must terminate, which the old stack-memo DFS could get wrong).
    const bypassLoop: Definition = {
      nodes: [
        { id: 'r', namespace: WINNER_RESPONSE },
        { id: 'a', namespace: 'loop_a' },
        { id: 'b', namespace: 'loop_b' },
        { id: 'w', namespace: WINNER_WRITEBACK },
      ],
      edges: [{ source: 'r', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    }
    expect(alwaysReaches(bypassLoop, WINNER_RESPONSE, WINNER_WRITEBACK)).toBe(false)
  })

  it('sees a response node as continuing only when it carries the flag', () => {
    const withFlag: Definition = { nodes: [{ id: 'a', namespace: WINNER_RESPONSE, config: { continue_after_response: true } }], edges: [] }
    const without: Definition = { nodes: [{ id: 'a', namespace: WINNER_RESPONSE, config: {} }], edges: [] }
    expect(continuesAfterResponse(withFlag, WINNER_RESPONSE)).toBe(true)
    expect(continuesAfterResponse(without, WINNER_RESPONSE)).toBe(false)
  })
})

describe('the Engine Bidding Workflow keeps winners from stranding (#377)', () => {
  it('runs the Salesforce prospect writeback AFTER the Offer Response (post-response), so the isolate stays alive for the finalize', () => {
    const def = loadEngineDefinition()
    // Both nodes still exist under the names the invariant depends on.
    const names = new Set(def.nodes.map((n) => n.namespace))
    expect(names.has(WINNER_RESPONSE), `the winner response node "${WINNER_RESPONSE}" is gone; re-verify the #377 invariant`).toBe(true)
    expect(names.has(WINNER_WRITEBACK), `the winner Salesforce writeback node "${WINNER_WRITEBACK}" is gone; re-verify the #377 invariant`).toBe(true)

    // The response node continues the walk after answering the caller, rather
    // than terminating at the response. Without this the writeback below never
    // runs post-response and nothing holds the isolate open.
    expect(
      continuesAfterResponse(def, WINNER_RESPONSE),
      `"${WINNER_RESPONSE}" no longer has continue_after_response, so the walk stops at the response and the ` +
        `Salesforce writeback never runs post-response. Winners would strand (see #377 and docs/adr/0002).`,
    ).toBe(true)

    // EVERY winner path runs the writeback after the response (not merely some
    // path): a branch after the response where one arm skipped the writeback
    // would strand the winners that took it.
    expect(
      alwaysReaches(def, WINNER_RESPONSE, WINNER_WRITEBACK),
      `not every path from "${WINNER_RESPONSE}" reaches "${WINNER_WRITEBACK}". If the Engine flow was reordered so the ` +
        `Salesforce writeback runs before the response, or a branch lets a winner skip it, winners will begin ` +
        `stranding (see #377 and docs/adr/0002).`,
    ).toBe(true)
    // ...and NOT before it, which would leave nothing to hold the isolate open.
    expect(
      reachableDownstream(def, WINNER_WRITEBACK, WINNER_RESPONSE),
      `"${WINNER_RESPONSE}" is downstream of "${WINNER_WRITEBACK}": the writeback now precedes the response, the ` +
        `exact reordering #377 warns strands winners.`,
    ).toBe(false)
  })
})
