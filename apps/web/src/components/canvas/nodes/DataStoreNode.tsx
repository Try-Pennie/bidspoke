import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Database } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

type DataStoreOp = 'set' | 'get' | 'delete'

export function DataStoreNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const store = (config.store as string | undefined) ?? 'submissions'
  const operation = (config.operation as DataStoreOp | undefined) ?? 'set'
  const key = (config.key as string | undefined) ?? ''
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-cyan-400 ring-2 ring-cyan-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-cyan-50 border-b border-cyan-100 px-3 py-2">
        <Database className="h-4 w-4 text-cyan-500" />
        <span className="font-mono text-xs font-bold tracking-wide text-cyan-700">DATA STORE</span>
        <span className="ml-auto rounded bg-cyan-100 px-1.5 py-0.5 text-xs text-cyan-700">{operation}</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400">{store}</p>
        {key
          ? <p className="mt-1 truncate rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">{key}</p>
          : <p className="mt-1 truncate text-xs text-slate-400">No key configured</p>}
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
