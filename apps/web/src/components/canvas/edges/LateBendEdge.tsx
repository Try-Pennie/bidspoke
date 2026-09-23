import { BaseEdge, getSmoothStepPath, useStore } from '@xyflow/react'
import type { EdgeProps, ReactFlowState } from '@xyflow/react'
import { laneBendY, siblingRank } from './edge-lanes'

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
 *
 * Two handles of ONE node wired to the same target handle would otherwise run
 * along one horizontal line and read as a single bracket (#1489), so each such
 * sibling bends at its own height from `edge-lanes.ts`, still ending on the handle.
 */
/**
 * The edges sharing this edge's source node and target handle, as `id:handleX`
 * pairs. A string, so the store compares it by value and the edge re-renders
 * only when its siblings or their handle positions change.
 */
function siblingKey(state: ReactFlowState, id: string, source: string, target: string, targetHandle: string | null): string {
  const outgoing = state.connectionLookup.get(`${source}-source`)
  if (!outgoing || outgoing.size < 2) return ''
  const handles = state.nodeLookup.get(source)?.internals.handleBounds?.source ?? []
  const parts: string[] = []
  for (const c of outgoing.values()) {
    if (c.target !== target || (c.targetHandle ?? null) !== targetHandle) continue
    const h = handles.find((b) => (b.id ?? null) === (c.sourceHandle ?? null))
    parts.push(`${c.edgeId}:${h ? h.x + h.width / 2 : 0}`)
  }
  return parts.length < 2 || !parts.some((p) => p.startsWith(`${id}:`)) ? '' : parts.join('|')
}

function parseSiblings(key: string): Array<{ id: string; handleX: number }> {
  if (!key) return []
  return key.split('|').map((p) => {
    const at = p.lastIndexOf(':')
    return { id: p.slice(0, at), handleX: Number(p.slice(at + 1)) }
  })
}

export function LateBendEdge({
  id,
  source,
  target,
  targetHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const key = useStore((s) => siblingKey(s, id, source, target, targetHandleId ?? null))
  const { rank } = siblingRank(id, parseSiblings(key), sourceX, targetX)
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    centerY: laneBendY({ rank, sourceY, targetY }),
    borderRadius: 8,
  })
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}
