import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { ArrowLeftRight } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'

interface TransformMapping {
  source: string
  target: string
}

export function TransformNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const mappings = (config.mappings as TransformMapping[] | undefined) ?? []
  const count = mappings.length

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-orange-50 border-b border-orange-100 px-3 py-2">
        <ArrowLeftRight className="h-4 w-4 text-orange-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-orange-700">Transform</span>
        {count > 0 && (
          <span className="ml-auto rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-600">
            {count} field{count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {count === 0 ? (
          <p className="mt-0.5 truncate text-xs text-slate-400">No mappings configured</p>
        ) : (
          <div className="mt-1 space-y-0.5">
            {mappings.slice(0, 2).map((m, i) => (
              <p key={i} className="truncate font-mono text-xs text-gray-500">
                {m.source} → {m.target}
              </p>
            ))}
            {count > 2 && (
              <p className="text-xs text-slate-400">+{count - 2} more</p>
            )}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
