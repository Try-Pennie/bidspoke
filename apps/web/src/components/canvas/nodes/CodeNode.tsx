import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Code } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function CodeNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const workerName = config.worker_name as string | undefined
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border-l-4 border-l-amber-500 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-amber-300 border-r-amber-300 border-b-amber-300 ring-2 ring-amber-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Code className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-600">Code</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 truncate text-xs text-gray-400">
          {workerName ?? 'No worker configured'}
        </p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
