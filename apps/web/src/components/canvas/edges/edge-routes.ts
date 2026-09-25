/**
 * How every wire on the canvas is routed and drawn (#1570, Dan's design rounds of
 * 2026-09-25).
 *
 * 1. A wire runs down its source handle's column, turns on ONE line a fixed
 *    distance above its target, runs across, and drops onto the target handle.
 *    Wires into the same card therefore join on that line. This replaced #1489's
 *    staggered heights, which gave each wire into a card its own height and read
 *    as a staircase under a card with seven outputs.
 * 2. Where a wire's horizontal run crosses another wire's drop, the run arches
 *    over it (a hop), so a crossing is never mistaken for a join.
 *
 * Both lateBend and converge wires follow this, so one rule holds everywhere.
 */

/** Distance above the target where a wire turns, when the gap allows it. */
export const TURN_OFFSET = 32
/** Radius of the rounded corners where a wire turns. */
export const CORNER_RADIUS = 8
/** Radius of the arch a wire draws over a drop it crosses. */
export const HOP_RADIUS = 9

/** One wire's geometry: source point, target point, and the height it turns at. */
export interface Route {
  id: string
  sx: number
  sy: number
  tx: number
  ty: number
  by: number
}

/** The height a wire turns at: TURN_OFFSET above its target, or halfway down a tighter gap. */
export function turnY({ sourceY, targetY }: { sourceY: number; targetY: number }): number {
  const span = Math.max(0, targetY - sourceY)
  return targetY - Math.min(TURN_OFFSET, span / 2)
}

const isStraight = (r: Route) => Math.abs(r.tx - r.sx) < 0.5

/** The vertical pieces of a wire: its source column down to the turn, and its drop into the target. */
function verticals(r: Route): Array<{ x: number; y0: number; y1: number }> {
  if (isStraight(r)) return [{ x: r.sx, y0: r.sy, y1: r.ty }]
  return [{ x: r.sx, y0: r.sy, y1: r.by }, { x: r.tx, y0: r.by, y1: r.ty }]
}

/**
 * For each wire, the x positions where its horizontal run crosses another wire's
 * vertical piece. A vertical that only touches the run's line (a wire joining it
 * into the same card) is not a crossing, and neither is one within a corner's
 * reach of the run's ends, where the wire is already turning. Wires with no hops
 * are absent from the map. Computed once per canvas over every wire.
 */
export function crossingHops(routes: readonly Route[]): Map<string, number[]> {
  const hops = new Map<string, number[]>()
  const margin = CORNER_RADIUS + HOP_RADIUS
  const pieces = routes.map((r) => ({ id: r.id, v: verticals(r) }))
  for (const a of routes) {
    if (isStraight(a)) continue
    const lo = Math.min(a.sx, a.tx) + margin
    const hi = Math.max(a.sx, a.tx) - margin
    if (hi <= lo) continue
    const found = new Set<number>()
    for (const b of pieces) {
      if (b.id === a.id) continue
      for (const v of b.v) {
        if (v.x <= lo || v.x >= hi) continue
        if (a.by <= Math.min(v.y0, v.y1) + 1 || a.by >= Math.max(v.y0, v.y1) - 1) continue
        found.add(v.x)
      }
    }
    if (found.size > 0) hops.set(a.id, [...found].sort((p, q) => p - q))
  }
  return hops
}

/** The SVG path for one wire: down, across (arching over each hop), down into the target. */
export function edgePath(r: Route, hops: readonly number[]): string {
  const { sx, sy, tx, ty, by } = r
  if (isStraight(r)) return `M${sx} ${sy} L${sx} ${ty}`
  const dir = tx > sx ? 1 : -1
  const c = Math.max(0, Math.min(CORNER_RADIUS, Math.abs(tx - sx) / 2, by - sy, ty - by))
  const sweep = dir > 0 ? 1 : 0
  const ordered = [...hops].sort((p, q) => (p - q) * dir)
  let d = `M${sx} ${sy} L${sx} ${by - c} Q${sx} ${by} ${sx + dir * c} ${by}`
  for (const h of ordered) {
    d += ` L${h - dir * HOP_RADIUS} ${by} A${HOP_RADIUS} ${HOP_RADIUS} 0 0 ${sweep} ${h + dir * HOP_RADIUS} ${by}`
  }
  return `${d} L${tx - dir * c} ${by} Q${tx} ${by} ${tx} ${by + c} L${tx} ${ty}`
}
