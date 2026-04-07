import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Trophy } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle } from './execution-status'

interface BidEvaluationOutput {
  winner: { partner: string; bid: number | null; is_fallback?: boolean } | null
  reason: string
  _route: 'winner' | 'no_winner'
}

export function BidEvaluationNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const strategy = (config.strategy as string | undefined) ?? 'highest_bid'
  const strategyLabel = strategy === 'weighted_score' ? 'weighted' : 'highest bid'

  let winnerPreview: string | null = null
  let routeLabel: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as Partial<BidEvaluationOutput>
    if (out.winner) {
      winnerPreview = out.winner.is_fallback
        ? `fallback → ${out.winner.partner}`
        : `${out.winner.partner} $${out.winner.bid}`
    } else if (out._route === 'no_winner') {
      winnerPreview = `no winner (${out.reason ?? ''})`
    }
    routeLabel = out._route ?? null
  }

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-yellow-300 ring-2 ring-yellow-100' : 'border-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-yellow-50 border-b border-yellow-100 px-3 py-2">
        <Trophy className="h-4 w-4 text-yellow-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-yellow-700">Bid Eval</span>
        <span className="ml-auto rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-600">
          {strategyLabel}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-gray-900">{namespace}</p>
        {winnerPreview ? (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${
            routeLabel === 'no_winner'
              ? 'bg-gray-100 text-gray-500'
              : 'bg-yellow-100 text-yellow-700'
          }`}>
            {winnerPreview}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-gray-400">
            {(config.parallel_source as string | undefined)
              ? `← ${config.parallel_source}`
              : 'No source configured'}
          </p>
        )}
      </div>

      <div className="flex justify-between border-t border-gray-100 px-3 py-2 text-xs">
        <span className="text-yellow-600">↓ winner</span>
        <span className="text-gray-400">↓ no winner</span>
      </div>

      {/* winner handle — left */}
      <Handle type="source" position={Position.Bottom} id="winner" style={{ left: '30%' }} />
      {/* no_winner handle — right */}
      <Handle type="source" position={Position.Bottom} id="no_winner" style={{ left: '70%' }} />
    </div>
  )
}
