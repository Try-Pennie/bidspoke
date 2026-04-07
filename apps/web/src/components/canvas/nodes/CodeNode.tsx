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
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-amber-300 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-amber-50 border-b border-amber-100 px-3 py-2">
        <Code className="h-4 w-4 text-amber-500" />
        <span className="font-mono text-xs font-bold tracking-wide text-amber-700">CODE</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-gray-900">{namespace}</p>
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
