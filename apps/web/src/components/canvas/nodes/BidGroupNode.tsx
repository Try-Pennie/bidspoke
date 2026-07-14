import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Layers } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { bidGroupPartnerSummary } from '@/lib/bid-group-partners'
import { NODE_TYPE_COLOR } from './node-colors'

type BidGroupMode = 'cascade' | 'highest_bid' | 'tiered'

interface BidGroupOutput {
  winner: { partner: string; bid: number; raw_response?: unknown } | null
  reason: string
  mode: BidGroupMode
  _route: 'winner' | 'no_winner'
}

export function BidGroupNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const mode = (config.mode as BidGroupMode | undefined) ?? 'highest_bid'
  // Counts the fallback partner too: the engine calls it when nobody wins, so
  // leaving it out advertised fewer partners than the group can hit (#645).
  const partnerSummary = bidGroupPartnerSummary(config)

  let winnerPreview: string | null = null
  let routeLabel: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as Partial<BidGroupOutput>
    if (out.winner) {
      winnerPreview = `${out.winner.partner} $${out.winner.bid}`
    } else if (out._route === 'no_winner') {
      winnerPreview = `no winner${out.reason ? ` (${out.reason})` : ''}`
    }
    routeLabel = out._route ?? null
  }

  // Render at layout's reserved span width so wide subtrees underneath don't
  // visually overlap. Handle positions come from `_handleOffsets` so each
  // handle sits directly above its child's column (matching branch/parallel).
  const width = nodeWidth('bid_group', data)
  const handleOffsets = (data as { _handleOffsets?: number[] } | undefined)?._handleOffsets
  const handleLeftPct = (i: number, fallbackPct: number): string => {
    if (handleOffsets && handleOffsets[i] != null && width > 0) {
      return `${50 + (handleOffsets[i] / width) * 100}%`
    }
    return `${fallbackPct}%`
  }

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-rose-400 ring-2 ring-rose-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-rose-50 border-b border-rose-100 px-3 py-2">
        <Layers className={`h-4 w-4 ${NODE_TYPE_COLOR.bid_group.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-rose-700">Bid Group</span>
        <span className="ml-auto rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-600">
          {modeLabel(mode)}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {winnerPreview ? (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${
            routeLabel === 'no_winner' ? 'bg-gray-100 text-gray-500' : 'bg-rose-100 text-rose-700'
          }`}>
            {winnerPreview}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-400">{partnerSummary}</p>
        )}
      </div>

      <div className="relative border-t border-gray-100 py-2 text-xs" style={{ height: 28 }}>
        <span
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 truncate px-1 text-center text-rose-600"
          style={{ left: handleLeftPct(0, 30) }}
        >
          ↓ winner
        </span>
        <span
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 truncate px-1 text-center text-slate-400"
          style={{ left: handleLeftPct(1, 70) }}
        >
          ↓ no winner
        </span>
      </div>

      <Handle type="source" position={Position.Bottom} id="winner" style={{ left: handleLeftPct(0, 30) }} />
      <Handle type="source" position={Position.Bottom} id="no_winner" style={{ left: handleLeftPct(1, 70) }} />
    </div>
  )
}

function modeLabel(mode: BidGroupMode): string {
  if (mode === 'cascade') return 'cascade'
  if (mode === 'tiered') return 'tiered'
  return 'highest bid'
}
