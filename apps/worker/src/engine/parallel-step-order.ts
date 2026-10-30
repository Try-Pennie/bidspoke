/**
 * The step orders a parallel block gives its rows (#3084).
 *
 * A reader lists a run's steps by `step_order` (the run page's step list, the
 * test panel, the money gate's record), and rows sharing an order come back in
 * whatever order the store chooses. Each slot's steps used to take
 * `childOrderBase + childIndex + chainIndex`, so a slot whose chain was longer
 * than one step took the next slot's orders, and the last slot took
 * parallel_end's: the block's steps could be listed out of order.
 *
 * So each slot is given a RANGE of orders as wide as the most steps its chain
 * can walk, and the ranges sit one after another:
 *
 *   start, slot 0's range, slot 1's range, ..., parallel_end
 *
 * A step of slot i at chain index k takes `slotBases[i] + k`, so sorting by
 * order lists the block start, each slot's steps in slot then chain order,
 * then parallel_end. A block whose slots are all single steps gets exactly the
 * orders it always had (start, one order a slot, parallel_end), so its rows,
 * and every order after the block, are unchanged.
 *
 * The width is the count of distinct nodes the slot's chain can reach before
 * parallel_end: the chain walk (runParallelChild) follows one edge out of each
 * step and stops at parallel_end, and a saved definition has no loop
 * (findWorkflowCycle refuses one), so it visits each of those nodes at most
 * once and can never walk more steps than that. A slot with a branch is given
 * room for every arm, so an arm not taken leaves a gap in the orders, which no
 * reader minds: they sort by order, never count on it being contiguous.
 *
 * `step_order` is an INTEGER column, and a block's orders grow by at most the
 * number of nodes in the definition, far from its limit.
 */
import type { EdgeDefinition, NodeDefinition } from '../types'
import { findNode, outgoingEdges } from './graph'

/** The orders of one parallel block's rows. */
export interface ParallelStepOrders {
  /** The parallel start's own row. */
  start: number
  /** The first order of each slot's range, by slot index. */
  slotBases: number[]
  /** The parallel_end row. */
  end: number
  /** The first order after the block, for whatever the walk runs next. */
  next: number
}

/**
 * The most steps a slot's chain can walk: the distinct nodes reachable from its
 * first step without passing parallel_end. A slot that is not walked as a chain
 * (a legacy block with no parallel_end, `chainEndId` absent) runs its first
 * step only, so is one wide.
 */
export function slotOrderWidth(
  child: NodeDefinition,
  definition: { nodes: NodeDefinition[]; edges: EdgeDefinition[] } | undefined,
  chainEndId: string | undefined,
): number {
  if (!definition || !chainEndId) return 1
  const seen = new Set<string>()
  const queue: NodeDefinition[] = [child]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.type === 'parallel_end' || seen.has(cur.id)) continue
    seen.add(cur.id)
    for (const e of outgoingEdges(cur.id, definition.edges)) {
      const t = findNode(e.target, definition.nodes)
      if (t) queue.push(t)
    }
  }
  return Math.max(1, seen.size)
}

/** Lays a block's slot ranges one after another from `start`. */
export function parallelStepOrders(start: number, slotWidths: number[]): ParallelStepOrders {
  const slotBases: number[] = []
  let base = start + 1
  for (const width of slotWidths) {
    slotBases.push(base)
    base += Math.max(1, width)
  }
  return { start, slotBases, end: base, next: base + 1 }
}
