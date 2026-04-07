import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitBranch } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle, getOutputPreview } from './execution-status'

interface BranchEntry { label: string }

export function BranchNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const branches = (config.branches as BranchEntry[] | undefined) ?? []
  const outputPreview = getOutputPreview(executionStep)

  // All handles: one per branch label + else
  const handles = [...branches.map((b) => b.label), 'else']
  const handleCount = handles.length

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-purple-300 ring-2 ring-purple-100' : 'border-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-purple-50 border-b border-purple-100 px-3 py-2">
        <GitBranch className="h-4 w-4 text-purple-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">Branch</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-gray-900">{namespace}</p>
        <p className="mt-0.5 text-xs text-gray-400">
          {branches.length === 0 ? 'No branches' : `${branches.length} branch${branches.length !== 1 ? 'es' : ''} + else`}
        </p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
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
