import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Layers } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { bidGroupPartnerSummary } from '@/lib/bid-group-partners'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles, type HandleLabel } from './SourceHandles'

type BidGroupMode = 'cascade' | 'highest_bid' | 'tiered'

interface BidGroupOutput {
  winner: { partner: string; bid: number; raw_response?: unknown } | null
  reason: string
  mode: BidGroupMode
  _route: 'winner' | 'no_winner'
}

const BID_GROUP_LABEL: Record<string, HandleLabel> = {
  winner: { label: '↓ winner', className: 'text-rose-600' },
  no_winner: { label: '↓ no winner', className: 'text-slate-400' },
}

export function BidGroupNode({ id, data, selected }: NodeProps) {
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

  // Rendered at the layout's reserved span width so wide subtrees underneath
  // don't visually overlap, each handle above its child's column.
  const width = nodeWidth('bid_group', data)

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

      <SourceHandles nodeId={id} type="bid_group" width={width} data={data} describe={(h) => BID_GROUP_LABEL[h] ?? { label: h }} />
    </div>
  )
}

function modeLabel(mode: BidGroupMode): string {
  if (mode === 'cascade') return 'cascade'
  if (mode === 'tiered') return 'tiered'
  return 'highest bid'
}
