import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Timer } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { nodeWidth } from '@/lib/layout'

type LatencyGateOp = 'mark' | 'check'

export function LatencyGateNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const operation = (config.operation as LatencyGateOp | undefined) ?? 'mark'
  const correlationKey = (config.correlation_key as string | undefined) ?? ''
  const outputPreview = getOutputPreview(executionStep)

  const isCheck = operation === 'check'
  const width = isCheck ? nodeWidth('latency_gate', data) : undefined
  const handleOffsets = (data as { _handleOffsets?: number[] } | undefined)?._handleOffsets
  const handleLeftPct = (i: number, fallbackPct: number): string => {
    if (handleOffsets && handleOffsets[i] != null && width && width > 0) {
      return `${50 + (handleOffsets[i] / width) * 100}%`
    }
    return `${fallbackPct}%`
  }

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width: width ?? 208 }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-orange-50 border-b border-orange-100 px-3 py-2">
        <Timer className="h-4 w-4 text-orange-500" />
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
        <>
          <div className="relative border-t border-gray-100 py-2 text-xs" style={{ height: 28 }}>
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 truncate px-1 text-center text-green-600"
              style={{ left: handleLeftPct(0, 30) }}
            >
              ↓ within
            </span>
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 truncate px-1 text-center text-red-500"
              style={{ left: handleLeftPct(1, 70) }}
            >
              ↓ exceeded
            </span>
          </div>
          <Handle type="source" position={Position.Bottom} id="within" style={{ left: handleLeftPct(0, 30) }} />
          <Handle type="source" position={Position.Bottom} id="exceeded" style={{ left: handleLeftPct(1, 70) }} />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} id="output" />
      )}
    </div>
  )
}
