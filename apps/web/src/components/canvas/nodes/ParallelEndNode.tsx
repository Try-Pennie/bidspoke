'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'

interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
}

export function ParallelEndNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable, isSuccessNode } = data as unknown as CanvasNodeData

  const waitFor = (config.wait_for as string | undefined) ?? 'all'

  // Parallel_end inherits the parallel's output (child results array). If any
  // child failed, render the end node red even when the parallel's own status
  // is 'completed' (on_child_error:'continue' case).
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
      {/* Single target handle accepts edges from all children */}
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-beige border-b border-gray-100 px-3 py-2">
        <GitMerge className="h-4 w-4 text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Parallel</span>
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
          {waitFor === 'all' ? 'wait all' : 'wait first'}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
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
