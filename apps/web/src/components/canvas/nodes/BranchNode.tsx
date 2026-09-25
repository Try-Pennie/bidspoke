import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitBranch } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles } from './SourceHandles'

interface BranchEntry { label: string }

export function BranchNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const branches = (config.branches as BranchEntry[] | undefined) ?? []
  const elseBehavior = (config.else_behavior as 'output' | 'none' | 'error' | undefined)
    ?? ((config.use_else as boolean | undefined) === false ? 'none' : 'output')
  const elseLabel = (config.else_label as string | undefined) || 'else'
  const outputPreview = getOutputPreview(executionStep)

  // Handle id stays 'else' (engine + edges depend on it); only the rendered label
  // is customizable. SourceHandles tells React Flow when the arms change, so a
  // wire dropped on a freshly added arm finds its handle.
  const width = nodeWidth('branch', data)

  const description = branches.length === 0
    ? 'No branches'
    : elseBehavior === 'output' ? 'branches + else'
    : elseBehavior === 'error' ? 'branches (else errors)'
    : 'branches'

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-purple-400 ring-2 ring-purple-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-purple-50 border-b border-purple-100 px-3 py-2">
        <GitBranch className={`h-4 w-4 ${NODE_TYPE_COLOR.branch.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">Branch</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 text-xs text-slate-400">{description}</p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
      <SourceHandles
        nodeId={id}
        type="branch"
        width={width}
        data={data}
        describe={(h) => (h === 'else' && elseBehavior === 'output'
          ? { label: `↓ ${elseLabel}`, className: 'text-slate-400' }
          : { label: `↓ ${h}`, className: 'text-purple-600' })}
      />
    </div>
  )
}
