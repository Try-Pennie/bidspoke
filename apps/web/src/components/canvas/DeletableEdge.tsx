'use client'

import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'

/**
 * Default edge with a hover-revealed delete button at the midpoint.
 * On delete, calls data.onDelete(edgeId) — wired by WorkflowCanvas via
 * per-edge data injection, so there's one handler and edges stay serializable.
 */
export default function DeletableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const onDelete = (data as { onDelete?: (id: string) => void } | undefined)?.onDelete
  const [hover, setHover] = useState(false)

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {/* Wider invisible hit target so the thin edge line reveals the button on hover */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ cursor: 'pointer' }}
      />
      {onDelete && (
        <EdgeLabelRenderer>
          <div
            className="absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: hover ? 'auto' : 'none',
              opacity: hover ? 1 : 0,
              transition: 'opacity 120ms ease-out',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
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
