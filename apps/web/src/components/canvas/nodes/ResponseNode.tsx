import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { ArrowRight } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function ResponseNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const statusCode = (config.status_code as number | undefined) ?? 200
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-green-300 ring-2 ring-green-100' : 'border-gray-200'
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
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
