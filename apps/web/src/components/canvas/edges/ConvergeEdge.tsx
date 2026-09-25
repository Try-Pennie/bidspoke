import { BaseEdge } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { edgePath, turnY } from './edge-routes'
import { useEdgeHops } from './edge-hops'

/**
 * Convergence edge into a parallel_end: each chain leaf descends in its own
 * column, turns on the shared line above the join, and converges there. It
 * follows the same routing and hop rule as every other wire (#1570).
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
  const hops = useEdgeHops(id)
  const path = edgePath({ id, sx: sourceX, sy: sourceY, tx: targetX, ty: targetY, by: turnY({ sourceY, targetY }) }, hops)
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
