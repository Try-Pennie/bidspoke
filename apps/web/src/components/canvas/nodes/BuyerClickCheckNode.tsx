import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { OUT_REASON_LABELS, type OutReason } from '@bidspoke/buyer-profile'
import { NODE_TRAITS } from '@/types/workflow'
import type { CanvasNodeData } from '@/types/workflow'
import { ShieldCheck } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { NODE_W } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'

/** The two outgoing handles, from the node type's own list. */
const HANDLES = NODE_TRAITS.buyer_click_check.staticHandles ?? []

const label = (handle: string): string => handle.replace(/_/g, ' ')

interface ClickCheckOutputPreview {
  _route?: string
  reason?: string | null
  partner_slug?: string | null
  partner_name?: string | null
  count?: number | null
  daily_lead_cap?: number | null
  count_date?: string | null
}

function reasonLabel(reason: string): string {
  return (OUT_REASON_LABELS as Record<string, string | undefined>)[reason as OutReason] ?? reason
}

/**
 * The Buyer Click Check card (#1543). Says whether a buyer is picked, names it
 * by what the last run resolved (the config holds only its id, which is never
 * shown as a name), and after a run what it decided: the clicks it judged
 * against the cap when eligible, the plain reason otherwise.
 */
export function BuyerClickCheckNode({ data, selected }: NodeProps) {
  const { namespace, label: title, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const hasPartner = typeof config.partner_id === 'string' && config.partner_id.trim() !== ''
  let partnerName = ''

  let preview: string | null = null
  let route: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as ClickCheckOutputPreview
    route = out._route ?? null
    if (typeof out.partner_name === 'string') partnerName = out.partner_name
    else if (typeof out.partner_slug === 'string') partnerName = out.partner_slug
    if (out._route === 'eligible') {
      // The date the run counted, never "today": the card shows a stored run (#1557).
      preview = typeof out.count === 'number' && typeof out.daily_lead_cap === 'number'
        ? `eligible, ${out.count} of ${out.daily_lead_cap} clicks${typeof out.count_date === 'string' ? ` on ${out.count_date}` : ''}`
        : 'eligible'
    } else if (out._route) {
      preview = `${label(out._route)}${out.reason ? `: ${reasonLabel(out.reason)}` : ''}`
    }
  }

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-lime-500 ring-2 ring-lime-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width: NODE_W }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg border-b border-lime-100 bg-lime-50 px-3 py-2">
        <ShieldCheck className={`h-4 w-4 ${NODE_TYPE_COLOR.buyer_click_check.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-lime-800">Buyer Click Check</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-xs ${hasPartner ? 'bg-lime-100 text-lime-800' : 'bg-amber-100 text-amber-800'}`}>
          {!hasPartner ? 'no partner' : partnerName || 'partner set'}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{title || namespace}</p>
        {title && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {preview && (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${route === 'eligible' ? 'bg-lime-100 text-lime-800' : 'bg-gray-100 text-gray-600'}`}>
            {preview}
          </p>
        )}
      </div>

      <div className="flex border-t border-gray-100 text-[10px]">
        {HANDLES.map((h) => (
          <span key={h} className={`flex-1 py-1 text-center ${h === 'eligible' ? 'font-semibold text-lime-800' : 'text-slate-500'}`}>
            {label(h)}
          </span>
        ))}
      </div>

      {HANDLES.map((h, i) => (
        <Handle key={h} type="source" position={Position.Bottom} id={h} style={{ left: `${((i + 0.5) / HANDLES.length) * 100}%` }} />
      ))}
    </div>
  )
}
