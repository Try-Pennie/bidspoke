'use client'

import { Handle, Position, useStore } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'
import { nodeWidth } from '@/lib/layout'

export function BranchEndNode({ data, selected }: NodeProps) {
  const { executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const pairId = (data as { _pairId?: string })._pairId

  const startNode = useStore((s) => {
    if (!pairId) return null
    return (s.nodes as Node[]).find((n) => n.id === pairId) ?? null
  })
  const startData = startNode?.data as CanvasNodeData | undefined
  const startLabel = startData?.label || startData?.namespace || 'branch'
  const derivedLabel = `${startLabel} End`
  const derivedNamespace = `${startData?.namespace ?? 'branch'}_end`

  // Match the paired branch's effective width so the join visually closes the
  // cluster instead of being a narrow box under a wide branch.
  const startSpanWidth = (startData as { _spanWidth?: number } | undefined)?._spanWidth
  const width = startSpanWidth ?? nodeWidth('branch_end', data)

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
