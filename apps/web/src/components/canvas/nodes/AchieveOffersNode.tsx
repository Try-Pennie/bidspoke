import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { HandCoins } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function AchieveOffersNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const products = (config.targeted_products as string[] | undefined) ?? ['fdr']
  const waitForOffers = config.wait_for_offers !== false
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-violet-400 ring-2 ring-violet-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-violet-50 border-b border-violet-100 px-3 py-2">
        <HandCoins className="h-4 w-4 text-violet-500" />
        <span className="font-mono text-xs font-bold tracking-wide text-violet-700">ACHIEVE OFFERS</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <div className="mt-1 flex flex-wrap gap-1">
          {products.map((p) => (
            <span key={p} className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs text-violet-700">
              {p}
            </span>
          ))}
          {!waitForOffers && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">async</span>
          )}
        </div>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
