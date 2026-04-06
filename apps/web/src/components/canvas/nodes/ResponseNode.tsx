import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { ArrowRight } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle } from './execution-status'

export function ResponseNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const statusCode = (config.status_code as number | undefined) ?? 200

  return (
    <div
      className={`relative w-52 rounded-lg border-l-4 border-l-green-500 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-green-300 border-r-green-300 border-b-green-300 ring-2 ring-green-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      {/* Terminal node — no source handle */}

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <ArrowRight className="h-3.5 w-3.5 text-green-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-green-600">Response</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">HTTP {statusCode}</p>
      </div>
    </div>
  )
}
