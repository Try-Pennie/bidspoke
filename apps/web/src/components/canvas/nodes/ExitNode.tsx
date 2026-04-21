import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { LogOut } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function ExitNode({ data, selected }: NodeProps) {
  const { namespace, label, executionStep, hasError } = data as unknown as CanvasNodeData
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-red-50 shadow-sm ${
        selected ? 'border-red-400 ring-2 ring-red-200' : 'border-red-200'
      } ${getNodeClasses(executionStep, hasError)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      {/* Terminal node — no source handle */}

      <div className="flex items-center gap-2 rounded-t-lg bg-red-100 border-b border-red-200 px-3 py-2">
        <LogOut className="h-4 w-4 text-red-600" />
        <span className="text-xs font-semibold uppercase tracking-wide text-red-700">Exit</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 text-xs text-slate-400">Early termination</p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
