'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitFork } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'

interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
}

export function ParallelNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError } = data as unknown as CanvasNodeData

  const waitFor = (config.wait_for as string | undefined) ?? 'all'
  const children = (config.children as string[] | undefined) ?? []

  let resultLine: string | null = null
  if (executionStep?.output && Array.isArray(executionStep.output)) {
    const results = executionStep.output as ParallelChildResult[]
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    const total = results.length
    resultLine = `${fulfilled}/${total} completed`
  }

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-slate-400 ring-2 ring-slate-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-beige border-b border-gray-100 px-3 py-2">
        <GitFork className="h-4 w-4 text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Parallel</span>
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
          wait {waitFor}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {resultLine ? (
          <p className="mt-1 truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
            {resultLine}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {children.length > 0
              ? `${children.length} branch${children.length !== 1 ? 'es' : ''}`
              : 'No branches configured'}
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
