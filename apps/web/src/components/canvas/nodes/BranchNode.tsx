import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitBranch } from 'lucide-react'
import { getExecutionClasses, ExecutionBadge } from './execution-status'

interface BranchEntry { label: string }

export function BranchNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const branches = (config.branches as BranchEntry[] | undefined) ?? []

  // All handles: one per branch label + else
  const handles = [...branches.map((b) => b.label), 'else']
  const handleCount = handles.length

  return (
    <div
      className={`relative w-52 rounded-lg border-l-4 border-l-purple-500 border-t border-r border-b bg-white shadow-sm ${
        selected ? 'border-t-purple-300 border-r-purple-300 border-b-purple-300 ring-2 ring-purple-100' : 'border-t-gray-200 border-r-gray-200 border-b-gray-200'
      } ${getExecutionClasses(executionStep)}`}
    >
      <ExecutionBadge exec={executionStep} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <GitBranch className="h-3.5 w-3.5 text-purple-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-purple-600">Branch</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">
          {branches.length === 0 ? 'No branches' : `${branches.length} branch${branches.length !== 1 ? 'es' : ''} + else`}
        </p>
      </div>
      <div className="flex justify-around border-t border-gray-100 px-2 py-2 text-xs">
        {handles.map((label) => (
          <span key={label} className={label === 'else' ? 'text-gray-400' : 'text-purple-600'}>
            ↓ {label}
          </span>
        ))}
      </div>

      {handles.map((label, i) => (
        <Handle
          key={label}
          type="source"
          position={Position.Bottom}
          id={label}
          style={{ left: `${((i + 1) / (handleCount + 1)) * 100}%` }}
        />
      ))}
    </div>
  )
}
