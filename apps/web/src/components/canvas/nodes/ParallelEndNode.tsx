'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'

export function ParallelEndNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError } = data as unknown as CanvasNodeData

  const waitFor = (config.wait_for as string | undefined) ?? 'all'

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-slate-400 ring-2 ring-slate-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
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
        <p className="mt-0.5 truncate text-xs text-slate-400">(end)</p>
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
