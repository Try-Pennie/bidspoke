import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { edgePath, turnY } from './edge-routes'
import { useEdgeHops } from './edge-hops'

/**
 * The canvas's default wire. It stays in its source handle's column most of the
 * way down, turns on one shared line just above its target, and drops in, so a
 * multi-output card's wires stay in their own columns for as long as possible
 * and wires into the same card join on that line (#1570). Where its run crosses
 * another wire's drop it arches over it. Aligned source and target draw a plain
 * vertical line.
 *
 * A wire whose target sits above its source cannot be drawn down, across and
 * down, so it keeps React Flow's smooth step routing.
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
  const hops = useEdgeHops(id)
  const path = targetY > sourceY
    ? edgePath({ id, sx: sourceX, sy: sourceY, tx: targetX, ty: targetY, by: turnY({ sourceY, targetY }) }, hops)
    : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 })[0]
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
