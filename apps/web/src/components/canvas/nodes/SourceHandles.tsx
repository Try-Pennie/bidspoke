import { useEffect, type ReactNode } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { handleLeftFractions, outputHandles } from '@/lib/handle-geometry'

export interface HandleLabel {
  /** What the label row shows above the handle. */
  label: ReactNode
  /** Classes for the label, its colour and weight. */
  className?: string
}

/**
 * Every multi output card's handles and their labels (#1577, milestone 55).
 * The ids come from outputHandles, the one list the layout places children by,
 * so a card only says how each label reads. They are drawn where the layout
 * published them (`_handleOffsets`, from
 * lib/handle-geometry), so the card and the layout cannot disagree about where
 * a handle is. Each label gets the room up to its neighbours, so labels never
 * sit on each other however the handles are spread. When the positions change
 * at a constant width (an arm wired on a fixed card), React Flow is told the
 * handles moved, so the wires re-anchor to them.
 */
export function SourceHandles({
  nodeId,
  type,
  describe,
  width,
  data,
  rowHeight = 28,
  textClassName = 'text-xs',
  wrap = false,
}: {
  /** The card's node id, to tell React Flow its handles moved. */
  nodeId: string
  type: string
  /** How the label over each handle reads, by handle id. */
  describe: (id: string) => HandleLabel
  width: number
  data: unknown
  rowHeight?: number
  textClassName?: string
  /** Let a label wrap to two lines in its room rather than truncate. */
  wrap?: boolean
}) {
  const handles = outputHandles({ type, data }).map((id) => ({ id, ...describe(id) }))
  const offsets = (data as { _handleOffsets?: number[] } | undefined)?._handleOffsets
  const fractions = handleLeftFractions(type, handles.map((h) => h.id), offsets, width)
  const updateNodeInternals = useUpdateNodeInternals()
  const positionsKey = handles.map((h, i) => `${h.id}@${fractions[i].toFixed(4)}`).join(',')
  useEffect(() => {
    updateNodeInternals(nodeId)
  }, [nodeId, positionsKey, updateNodeInternals])

  // A label's room: twice the distance to the nearer of its neighbours' midpoints
  // or the card's edge, in pixels.
  const room = fractions.map((f, i) => {
    const leftEdge = i > 0 ? (f - fractions[i - 1]) / 2 : f
    const rightEdge = i < fractions.length - 1 ? (fractions[i + 1] - f) / 2 : 1 - f
    return Math.max(0, 2 * Math.min(leftEdge, rightEdge) * width)
  })

  if (handles.length === 0) return null
  return (
    <>
      <div className={`relative border-t border-gray-100 ${textClassName} ${wrap ? 'leading-tight' : ''}`} style={{ height: rowHeight }}>
        {handles.map((h, i) => (
          <span
            key={h.id}
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 px-0.5 text-center ${wrap ? '' : 'truncate'} ${h.className ?? ''}`}
            style={{ left: `${fractions[i] * 100}%`, ...(wrap ? { width: room[i] } : { maxWidth: room[i] }) }}
          >
            {h.label}
          </span>
        ))}
      </div>
      {handles.map((h, i) => (
        <Handle key={h.id} type="source" position={Position.Bottom} id={h.id} style={{ left: `${fractions[i] * 100}%` }} />
      ))}
    </>
  )
}
