import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData, ConditionGroup } from '@/types/workflow'
import { Filter } from 'lucide-react'

export function FilterNode({ data, selected }: NodeProps) {
  const { namespace, config } = data as unknown as CanvasNodeData
  const rules = config.rules as { groups?: ConditionGroup[] } | undefined
  const ruleCount = rules?.groups?.flatMap((g) => g.conditions).length ?? 0

  return (
    <div
      className={`w-52 rounded-lg border-l-4 border-l-blue-500 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-blue-300 border-r-blue-300 border-b-blue-300 ring-2 ring-blue-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      }`}
    >
      <Handle type="target" position={Position.Left} id="input" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Filter className="h-3.5 w-3.5 text-blue-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">Filter</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">
          {ruleCount === 0 ? 'No rules' : `${ruleCount} rule${ruleCount !== 1 ? 's' : ''}`}
        </p>
      </div>
      <div className="flex flex-col items-end gap-2 border-t border-gray-100 px-3 py-2 text-xs">
        <span className="text-green-600">pass →</span>
        <span className="text-red-500">exit →</span>
      </div>

      {/* Two source handles — pass ~40%, exit ~80% of node height */}
      <Handle type="source" position={Position.Right} id="pass" style={{ top: '55%' }} />
      <Handle type="source" position={Position.Right} id="exit" style={{ top: '80%' }} />
    </div>
  )
}
