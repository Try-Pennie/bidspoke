import type { Edge } from '@xyflow/react'

/**
 * A node's outputs are identified by handle. An edge drawn before a node had a
 * proper renderer carries a null handle, and the same physical output later
 * reports 'output', so the two must compare equal or an old wire and a new one to
 * the same target read as two different outputs (they are not).
 */
function outputOf(sourceHandle: string | null | undefined): string {
  return sourceHandle ?? 'output'
}

/**
 * Is this connection one the canvas already has?
 *
 * The key is (source, OUTPUT, target). Keying it on (source, target) alone, as it
 * was, broke two legitimate graphs (#566):
 *
 *   1. A branch arm wired straight to its own branch_end. Every branch is born
 *      with a HIDDEN backbone edge (branch -> branch_end) that exists only so
 *      Dagre ranks the end below the start. It is scaffolding, not a wire the user
 *      drew, but the check counted it, so the source/target pair was already taken
 *      on every branch and the drop silently did nothing.
 *   2. Two different arms of one branch folding into the same node. That is a real
 *      graph ("neither of these paths needs special handling"), and the arms are
 *      distinct outputs firing under distinct conditions, so it is not a duplicate
 *      of anything.
 *
 * What it still rejects is the case it was written for: the SAME output wired to
 * the same target twice, which offers the engine nothing and corrupts the layout.
 */
export function isDuplicateConnection(
  edges: Edge[],
  connection: { source: string | null; sourceHandle?: string | null; target?: string | null },
): boolean {
  return edges.some(
    (e) =>
      !e.hidden &&
      e.source === connection.source &&
      e.target === connection.target &&
      outputOf(e.sourceHandle) === outputOf(connection.sourceHandle),
  )
}
