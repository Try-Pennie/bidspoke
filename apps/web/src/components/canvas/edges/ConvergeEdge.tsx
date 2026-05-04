import { BaseEdge } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

/**
 * Convergence edge routed with the bend near the target (parallel_end), so
 * each chain leaf descends in its own column before turning to converge at
 * the join. Three segments: source down to just above target, horizontal to
 * target X, into target. Compared to default smoothstep (bend at midpoint),
 * this keeps the vertical segment in the source's column instead of cutting
 * sideways through the middle of the cluster.
 */
export function ConvergeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
}: EdgeProps) {
  const turnOffset = 24
  const turnY = targetY - turnOffset
  const d = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX},${turnY}`,
    `L ${targetX},${turnY}`,
    `L ${targetX},${targetY}`,
  ].join(' ')
  return <BaseEdge id={id} path={d} style={style} markerEnd={markerEnd} />
}
