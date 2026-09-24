import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NODE_TRAITS } from '@/types/workflow'
import type { CanvasNodeData } from '@/types/workflow'
import { MousePointerClick } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'

/** The seven outgoing handles, from the node type's own list, in the order the layout places them. */
const HANDLES = NODE_TRAITS.buyer_click_send.staticHandles ?? []

const label = (handle: string): string => handle.replace(/_/g, ' ')

interface ClickSendOutputPreview {
  _route?: string
  reason?: string | null
  partner_lead_id?: string | null
  count?: number | null
}

/**
 * The Buyer Click Send card (#1542). Names the buyer it sends to, and after a
 * run the route it took: the partner lead id on a send, the reason otherwise.
 */
export function BuyerClickSendNode({ data, selected }: NodeProps) {
  const { namespace, label: title, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const partnerSlug = typeof config.partner_slug === 'string' ? config.partner_slug : ''

  let preview: string | null = null
  let route: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as ClickSendOutputPreview
    route = out._route ?? null
    if (out._route === 'sent') {
      preview = `sent${out.partner_lead_id ? ` (${out.partner_lead_id})` : ''}${typeof out.count === 'number' ? `, ${out.count} today` : ''}`
    } else if (out._route) {
      preview = `${label(out._route)}${out.reason ? ` (${out.reason})` : ''}`
    }
  }

  const width = nodeWidth('buyer_click_send', data)
  const handleOffsets = (data as { _handleOffsets?: number[] } | undefined)?._handleOffsets
  const handleLeftPct = (i: number): string => {
    if (handleOffsets && handleOffsets[i] != null && width > 0) return `${50 + (handleOffsets[i] / width) * 100}%`
    return `${((i + 0.5) / HANDLES.length) * 100}%`
  }

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-lime-500 ring-2 ring-lime-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg border-b border-lime-100 bg-lime-50 px-3 py-2">
        <MousePointerClick className={`h-4 w-4 ${NODE_TYPE_COLOR.buyer_click_send.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-lime-800">Buyer Click Send</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-xs ${partnerSlug ? 'bg-lime-100 text-lime-800' : 'bg-amber-100 text-amber-800'}`}>
          {partnerSlug || 'no partner'}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{title || namespace}</p>
        {title && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {preview && (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${route === 'sent' ? 'bg-lime-100 text-lime-800' : 'bg-gray-100 text-gray-600'}`}>
            {preview}
          </p>
        )}
      </div>

      {/* Each label owns the column above its handle and may wrap to two lines. */}
      <div className="relative border-t border-gray-100 text-[10px] leading-tight" style={{ height: 34 }}>
        {HANDLES.map((h, i) => (
          <span
            key={h}
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 px-0.5 text-center ${h === 'sent' ? 'font-semibold text-lime-800' : 'text-slate-500'}`}
            style={{ left: handleLeftPct(i), width: `${100 / HANDLES.length}%` }}
          >
            {label(h)}
          </span>
        ))}
      </div>

      {HANDLES.map((h, i) => (
        <Handle key={h} type="source" position={Position.Bottom} id={h} style={{ left: handleLeftPct(i) }} />
      ))}
    </div>
  )
}
