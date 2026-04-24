'use client'

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'

/**
 * Default edge that renders a delete button at the midpoint when hovered.
 * Hover is tracked by the parent canvas via onEdgeMouseEnter/Leave on ReactFlow
 * and passed in as data.hovered — that way we don't add any invisible DOM
 * paths that would steal pointer events from nodes or the edge itself.
 */
export default function DeletableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const d = data as { onDelete?: (id: string) => void; hovered?: boolean } | undefined
  const onDelete = d?.onDelete
  const hovered = d?.hovered === true

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {onDelete && hovered && (
        <EdgeLabelRenderer>
          <div
            className="absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'auto',
            }}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(id) }}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 shadow-sm hover:border-red-400 hover:bg-red-50 hover:text-red-600"
              title="Disconnect"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
