'use client'

import { Handle, Position, useStore } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'

interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
}

export function ParallelEndNode({ data, selected }: NodeProps) {
  const { executionStep, hasError, isReachable, isSuccessNode } = data as unknown as CanvasNodeData
  const pairId = (data as { _pairId?: string })._pairId

  // Look up the paired start node to derive the end node's display.
  const startNode = useStore((s) => {
    if (!pairId) return null
    return (s.nodes as Node[]).find((n) => n.id === pairId) ?? null
  })
  const startData = startNode?.data as CanvasNodeData | undefined
  const startLabel = startData?.label || startData?.namespace || 'parallel'
  const derivedLabel = `${startLabel} End`
  const derivedNamespace = `${startData?.namespace ?? 'parallel'}_end`

  let failedLine: string | null = null
  let hasChildFailure = false
  if (executionStep?.output && Array.isArray(executionStep.output)) {
    const results = executionStep.output as ParallelChildResult[]
    const failed = results.filter((r) => r.status !== 'fulfilled').length
    if (failed > 0) {
      failedLine = `${results.length - failed}/${results.length} completed`
      hasChildFailure = true
    }
  }

  const effectiveStep = hasChildFailure && executionStep
    ? { ...executionStep, status: 'failed' as const }
    : executionStep

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-slate-400 ring-2 ring-slate-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(effectiveStep, hasError, isReachable)}`}
      style={getExecutionStyle(effectiveStep)}
    >
      <SuccessBadge visible={isSuccessNode} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-beige border-b border-gray-100 px-3 py-2">
        <GitMerge className="h-4 w-4 text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Parallel End</span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{derivedLabel}</p>
        <p className="truncate font-mono text-xs text-slate-400">{derivedNamespace}</p>
        {failedLine ? (
          <p className="mt-1 truncate rounded bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-700">
            {failedLine}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-400">(end)</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
