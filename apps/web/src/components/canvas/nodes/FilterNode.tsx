import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData, ConditionGroup } from '@/types/workflow'
import { Filter } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function FilterNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const rules = config.rules as { groups?: ConditionGroup[] } | undefined
  const ruleCount = rules?.groups?.flatMap((g) => g.conditions).length ?? 0
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Filter className="h-3.5 w-3.5 text-blue-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">Filter</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">
          {ruleCount === 0 ? 'No rules' : `${ruleCount} rule${ruleCount !== 1 ? 's' : ''}`}
        </p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
      <div className="flex justify-between border-t border-gray-100 px-3 py-2 text-xs">
        <span className="text-green-600">↓ pass</span>
        <span className="text-red-500">↓ exit</span>
      </div>

      {/* Two source handles at bottom — pass left, exit right */}
      <Handle type="source" position={Position.Bottom} id="pass" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="exit" style={{ left: '70%' }} />
    </div>
  )
}
