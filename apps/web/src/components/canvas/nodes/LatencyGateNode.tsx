import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Timer } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles, type HandleLabel } from './SourceHandles'

type LatencyGateOp = 'mark' | 'check'

const LATENCY_LABEL: Record<string, HandleLabel> = {
  within: { label: '↓ within', className: 'text-green-600' },
  exceeded: { label: '↓ exceeded', className: 'text-red-500' },
}

export function LatencyGateNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const operation = (config.operation as LatencyGateOp | undefined) ?? 'mark'
  const correlationKey = (config.correlation_key as string | undefined) ?? ''
  const outputPreview = getOutputPreview(executionStep)

  const isCheck = operation === 'check'
  const width = nodeWidth('latency_gate', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-orange-50 border-b border-orange-100 px-3 py-2">
        <Timer className={`h-4 w-4 ${NODE_TYPE_COLOR.latency_gate.icon}`} />
        <span className="font-mono text-xs font-bold tracking-wide text-orange-700">LATENCY GATE</span>
        <span className="ml-auto rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700">{operation}</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {correlationKey
          ? <p className="mt-1 truncate rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">{correlationKey}</p>
          : <p className="mt-1 truncate text-xs text-slate-400">No correlation key set</p>}
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>

      {isCheck ? (
        <SourceHandles nodeId={id} type="latency_gate" width={width} data={data} describe={(h) => LATENCY_LABEL[h] ?? { label: h }} />
      ) : (
        <Handle type="source" position={Position.Bottom} id="output" />
      )}
    </div>
  )
}
