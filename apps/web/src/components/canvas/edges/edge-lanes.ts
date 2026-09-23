/**
 * Lanes for edges that share a source node and a target node (#1489).
 *
 * A late bend edge bends a fixed distance above its target and drops onto the
 * target handle, so two handles of one node wired to the same target (the
 * buyer_select not_applicable and deferred exits) used to share their last two
 * segments and read as one bracket. Each sibling gets its own drop x, one lane
 * gap apart and centred on the handle, and its own bend height, chosen so no
 * two siblings overlap or cross: an edge that travels farther across bends
 * lower, which keeps its horizontal run under the shorter edge's vertical one.
 */

/** Distance above the target where a lone edge's horizontal run sits. */
export const TURN_OFFSET = 32
/** Horizontal distance between sibling drops onto one target. */
export const LANE_GAP = 24
/** Vertical distance between sibling bend heights. */
export const LANE_STEP = 16

export interface LaneInput {
  index: number
  count: number
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
}

export function laneGeometry({ index, count, sourceX, sourceY, targetX, targetY }: LaneInput): { targetX: number; centerY: number } {
  const dropX = targetX + (index - (count - 1) / 2) * LANE_GAP
  // Siblings are ordered left to right by source handle, so from the left the
  // farthest traveller is the lowest index, and from the right the highest.
  const rank = sourceX < dropX ? index : sourceX > dropX ? count - 1 - index : 0
  const span = Math.max(0, targetY - sourceY)
  // Clamp to half the vertical span so a short edge never bends above its source.
  const offset = Math.min(TURN_OFFSET + rank * LANE_STEP, span / 2)
  return { targetX: dropX, centerY: targetY - offset }
}

/** This edge's lane among its siblings, ordered by source handle x, then edge id. */
export function siblingLane(edgeId: string, siblings: Array<{ id: string; handleX: number }>): { index: number; count: number } {
  const ordered = [...siblings].sort((a, b) => a.handleX - b.handleX || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const index = ordered.findIndex((s) => s.id === edgeId)
  return index < 0 ? { index: 0, count: 1 } : { index, count: ordered.length }
}
