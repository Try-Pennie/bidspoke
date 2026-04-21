'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Cloud } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'

const OPERATION_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  upsert: 'Upsert',
  query: 'Query',
}

export function SalesforceNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError } = data as unknown as CanvasNodeData

  const operation = (config.operation as string | undefined) ?? 'create'
  const object = (config.object as string | undefined) ?? ''
  const opLabel = OPERATION_LABELS[operation] ?? operation

  const execOutput = executionStep?.output as { status?: number; body?: unknown } | null | undefined
  const statusCode = execOutput?.status

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-blue-400 ring-2 ring-blue-100' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-blue-50 border-b border-blue-100 px-3 py-2">
        <Cloud className="h-4 w-4 text-blue-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">Salesforce</span>
        {object && (
          <span className="ml-auto rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">
            {opLabel}
          </span>
        )}
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400">
          {object ? `${opLabel} ${object}` : 'Unconfigured'}
        </p>
        {statusCode !== undefined && (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${statusCode >= 200 && statusCode < 300 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {statusCode}
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
