import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Box } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function GenericNode({ data, selected, type }: NodeProps) {
  const { namespace, label, executionStep, hasError } = data as unknown as CanvasNodeData
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-gray-400 ring-2 ring-gray-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-gray-50 border-b border-gray-200 px-3 py-2">
        <Box className="h-4 w-4 text-slate-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {type?.replace('_', ' ') ?? 'Node'}
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
