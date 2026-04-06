import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Box } from 'lucide-react'
import { getExecutionClasses, ExecutionBadge } from './execution-status'

export function GenericNode({ data, selected, type }: NodeProps) {
  const { namespace, executionStep } = data as unknown as CanvasNodeData

  return (
    <div
      className={`relative w-52 rounded-lg border-l-4 border-l-gray-400 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-gray-300 border-r-gray-300 border-b-gray-300 ring-2 ring-gray-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      } ${getExecutionClasses(executionStep)}`}
    >
      <ExecutionBadge exec={executionStep} />
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Box className="h-3.5 w-3.5 text-gray-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {type?.replace('_', ' ') ?? 'Node'}
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
      </div>
    </div>
  )
}
