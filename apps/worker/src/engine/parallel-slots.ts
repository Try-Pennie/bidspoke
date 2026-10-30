/**
 * A parallel block's slots, as one list (#3125).
 *
 * A slot is a `child-N` edge off the parallel step; its first step is that
 * edge's target. Every reader that names a slot (wait_for specific's
 * `wait_for_slot`, the `on_failure: 'continue'` mark of #2832, the step order
 * ranges of #3084, and the child index the block runs each child under) reads
 * this one list, by the same index, so a slot index means the same slot in
 * each of them.
 *
 * They used to read two lists: every `child-N` handle, and the children with an
 * empty slot dropped. With an empty slot the two differed in length, so from
 * that slot on, slot i of one was a different slot of the other.
 *
 * An empty slot is skipped, here and so everywhere: one wired straight to
 * parallel_end (what deleting the only step of a slot leaves), or to a step
 * that no longer exists. It runs nothing and takes no step orders, as an
 * unwired slot never has. The save does not refuse it, because a slot with no
 * step in it is an ordinary half edited block on the canvas. A
 * `wait_for_slot` naming an empty slot is refused when the block runs, as one
 * naming an unwired slot always has been.
 */
import type { EdgeDefinition, NodeDefinition } from '../types'
import { findNode, outgoingEdges } from './graph'

export interface ParallelSlot {
  /** The slot's handle id (`child-N`), or null for a legacy block's `children` entry, which has none. */
  handleId: string | null
  /** The slot's first step. */
  node: NodeDefinition
}

const SLOT_HANDLE_PREFIX = 'child-'

/** The slot's number, or null when the handle carries none (`child-x`). */
function slotNumber(handle: string): number | null {
  const rest = handle.slice(SLOT_HANDLE_PREFIX.length)
  return /^\d+$/.test(rest) ? Number(rest) : null
}

/**
 * Numbered slots by number, then any unnumbered one by its handle text. A NaN
 * from parsing an unnumbered handle compares as equal to everything, which left
 * that slot wherever its edge happened to be stored (L50).
 */
function compareSlotHandles(a: string, b: string): number {
  const an = slotNumber(a)
  const bn = slotNumber(b)
  if (an !== null && bn !== null) return an - bn
  if (an !== null) return -1
  if (bn !== null) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The block's slots that hold a step, in slot number order. A definition from
 * before 2026-04-30 kept its child ids on the node's `children` list with no
 * slot edges; when no slot holds a step, that list is read instead.
 */
export function parallelSlots(
  node: NodeDefinition,
  definition: { nodes: NodeDefinition[]; edges: EdgeDefinition[] },
): ParallelSlot[] {
  const slots: ParallelSlot[] = []
  const slotEdges = outgoingEdges(node.id, definition.edges)
    .filter((e) => (e.source_handle ?? '').startsWith(SLOT_HANDLE_PREFIX))
    .sort((a, b) => compareSlotHandles(a.source_handle ?? '', b.source_handle ?? ''))
  for (const e of slotEdges) {
    const first = findNode(e.target, definition.nodes)
    if (first === undefined || first.type === 'parallel_end') continue
    slots.push({ handleId: e.source_handle ?? null, node: first })
  }
  if (slots.length > 0) return slots
  return (node.children ?? [])
    .map((id) => findNode(id, definition.nodes))
    .filter((n): n is NodeDefinition => n !== undefined)
    .map((n) => ({ handleId: null, node: n }))
}
