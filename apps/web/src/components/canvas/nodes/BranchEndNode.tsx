'use client'

import { useEffect } from 'react'
import { Handle, Position, useStore, useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'
import { nodeWidth } from '@/lib/layout'

export function BranchEndNode({ id, data, selected }: NodeProps) {
  const { executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const pairId = (data as { _pairId?: string })._pairId

  const startNode = useStore((s) => {
    if (!pairId) return null
    return (s.nodes as Node[]).find((n) => n.id === pairId) ?? null
  })

  // Single source of truth for full-card vs pill: layout decides whether this
  // end is "effectively connected" (chains converge into it) and, if so,
  // inherits the paired branch's width onto the end's `_spanWidth`. So the
  // presence of `_spanWidth` IS the full-card signal. Deriving it here instead
  // of recomputing the connectivity heuristic prevents the layout and the
  // renderer from disagreeing — which produced a full card stuck at NODE_W
  // (a "half node": full-card chrome, pill width) when they diverged.
  const ownSpanWidth = (data as { _spanWidth?: number } | undefined)?._spanWidth
  const effectivelyConnected = ownSpanWidth != null

  // The render shape (compact pill vs full card) changes the handle DOM
  // positions. Without re-registering, React Flow's handle position cache
  // stays stuck on the previous shape and a connection drag from the bottom
  // handle aims at the wrong screen point — which feels like "I can't
  // connect branch ends to each other anymore."
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, effectivelyConnected, updateNodeInternals])
  const startData = startNode?.data as CanvasNodeData | undefined
  const startLabel = startData?.label || startData?.namespace || 'branch'
  const derivedLabel = `${startLabel} End`
  const derivedNamespace = `${startData?.namespace ?? 'branch'}_end`

  if (!effectivelyConnected) {
    // Compact pill — present and wirable, but visually out of the way until
    // the user actually feeds a chain into it. Wrap in a NODE_W-wide flex
    // container that centers the pill so the visual matches the layout's
    // position math: layout writes `position.x = center - NODE_W/2` for an
    // unconnected branch_end, so the rendered DOM must also occupy that full
    // width or the auto-sized inline pill drifts left-of-center.
    return (
      <div className="flex justify-center" style={{ width: nodeWidth('branch_end', data) }}>
        <div
          className={`relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border bg-white px-3 py-1 text-xs ${
            selected ? 'border-purple-400 ring-2 ring-purple-200' : 'border-purple-100'
          } ${getNodeClasses(executionStep, hasError, isReachable)}`}
          style={getExecutionStyle(executionStep)}
        >
          <NoteBadge note={note} />
          <Handle type="target" position={Position.Top} id="input" />
          <GitMerge className="h-3 w-3 shrink-0 text-purple-400" />
          <span className="font-medium text-purple-500">{derivedLabel}</span>
          <Handle type="source" position={Position.Bottom} id="output" />
        </div>
      </div>
    )
  }

  // Full card: render at the end's OWN _spanWidth — the exact width layout used
  // to place this node (`position.x = center - _spanWidth/2`). We only reach
  // here when ownSpanWidth is set (effectivelyConnected), so start and end stay
  // perfectly stacked at the same width.
  const width = ownSpanWidth ?? nodeWidth('branch_end', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-purple-400 ring-2 ring-purple-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <SuccessBadge visible={isSuccessNode} />
      <NoteBadge note={note} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-purple-50 border-b border-purple-100 px-3 py-2">
        <GitMerge className="h-4 w-4 text-purple-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">Branch End</span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{derivedLabel}</p>
        <p className="truncate font-mono text-xs text-slate-400">{derivedNamespace}</p>
        <p className="mt-0.5 truncate text-xs text-slate-400">(end)</p>
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
