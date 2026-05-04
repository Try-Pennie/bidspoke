import { BaseEdge } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

/**
 * Convergence edge that routes around the right edge of a cluster instead
 * of slicing through it diagonally. Used when a parallel slot's chain leaf
 * is far above its parallel_end and the slot child's column is to the right
 * of the cluster's center — a default bezier or smoothstep would otherwise
 * land its horizontal segment on a populated rank.
 *
 * Path: source bottom → down a touch → right past the cluster → down past
 * target top → left to target X → into target. Five right-angle segments.
 */
export function AroundClusterEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
}: EdgeProps) {
  const turnGap = 24
  const sidePadding = 80
  const turnY = sourceY + turnGap
  const approachY = targetY - turnGap
  const rightX = Math.max(sourceX, targetX) + sidePadding
  const d = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX},${turnY}`,
    `L ${rightX},${turnY}`,
    `L ${rightX},${approachY}`,
    `L ${targetX},${approachY}`,
    `L ${targetX},${targetY}`,
  ].join(' ')
  return <BaseEdge id={id} path={d} style={style} markerEnd={markerEnd} />
}
