import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

/**
 * Smoothstep-style edge that bends NEAR THE TARGET instead of at the midpoint
 * between source and target. The wire stays in the source's column most of
 * the way down, then makes a single right-angle bend just above the target
 * and drops in. Two benefits over default smoothstep:
 *   1. Multi-output handles (branch, parallel) keep their wire in the
 *      handle's column for as long as possible, so it can't visually be
 *      mistaken for a sibling handle's wire.
 *   2. When two wires terminate at the same target (e.g., a branch_end with
 *      multiple incoming chains), they both bend at the same y-line near the
 *      target — symmetrical, easier to read.
 *
 * Aligned source/target (same x) renders as a plain vertical line — the
 * horizontal bend segment collapses to zero.
 */
export function LateBendEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const turnOffset = 32
  // Distance from target where the horizontal bend sits. Clamp to half the
  // vertical span so very short edges don't try to bend past their source.
  const span = Math.max(0, targetY - sourceY)
  const offset = Math.min(turnOffset, span / 2)
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    centerY: targetY - offset,
    borderRadius: 8,
  })
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
