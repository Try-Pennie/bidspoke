import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Package } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function ConstantsNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError } = data as unknown as CanvasNodeData
  const dataObj = config.data as Record<string, unknown> | undefined
  const keyCount = dataObj ? Object.keys(dataObj).length : 0
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-indigo-50 border-b border-indigo-100 px-3 py-2">
        <Package className="h-4 w-4 text-indigo-500" />
        <span className="font-mono text-xs font-bold tracking-wide text-indigo-700">CONSTANTS</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 text-xs text-slate-400">
          {keyCount > 0 ? `${keyCount} workflow key${keyCount === 1 ? '' : 's'} + partner data` : 'No constants configured'}
        </p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
