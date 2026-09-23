/**
 * Lanes for edges that share a source node and a target handle (#1489).
 *
 * A late bend edge bends a fixed distance above its target and drops onto the
 * target handle, so two handles of one node wired to the same target (the
 * buyer_select not_applicable and deferred exits) used to run their horizontal
 * segments along one line and read as a single bracket. Each sibling now bends
 * at its own height, and every edge still ends ON the handle, so they are two
 * lines until they join just above it. The edge that travels farther across
 * bends lowest, which keeps its horizontal run under the nearer edge's
 * vertical one, so siblings never cross.
 */

/** Distance above the target where a lone edge's horizontal run sits. */
export const TURN_OFFSET = 32
/** Vertical distance between sibling bend heights. */
export const LANE_STEP = 16

/** The height of this edge's horizontal run, for its rank among its siblings. */
export function laneBendY({ rank, sourceY, targetY }: { rank: number; sourceY: number; targetY: number }): number {
  const span = Math.max(0, targetY - sourceY)
  // Clamp to half the vertical span so a short edge never bends above its source.
  return targetY - Math.min(TURN_OFFSET + rank * LANE_STEP, span / 2)
}

/**
 * This edge's rank among its siblings, farthest horizontal travel first, then
 * edge id. `handleX` is each sibling's handle x relative to the shared source
 * node, so it is converted to absolute through this edge's own `sourceX`.
 */
export function siblingRank(
  edgeId: string,
  siblings: Array<{ id: string; handleX: number }>,
  sourceX: number,
  targetX: number,
): { rank: number; count: number } {
  const mine = siblings.find((s) => s.id === edgeId)
  if (!mine) return { rank: 0, count: 1 }
  const travel = (s: { handleX: number }) => Math.abs(sourceX + (s.handleX - mine.handleX) - targetX)
  const ordered = [...siblings].sort((a, b) => travel(b) - travel(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { rank: ordered.findIndex((s) => s.id === edgeId), count: ordered.length }
}
