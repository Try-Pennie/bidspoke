import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { LogOut } from 'lucide-react'

export function ExitNode({ data, selected }: NodeProps) {
  const { namespace } = data as unknown as CanvasNodeData

  return (
    <div
      className={`w-52 rounded-lg border-l-4 border-l-red-500 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-red-300 border-r-red-300 border-b-red-300 ring-2 ring-red-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      }`}
    >
      <Handle type="target" position={Position.Top} id="input" />
      {/* Terminal node — no source handle */}

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <LogOut className="h-3.5 w-3.5 text-red-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-red-600">Exit</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">Early termination</p>
      </div>
    </div>
  )
}
