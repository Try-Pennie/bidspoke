import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { MousePointerClick } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles } from './SourceHandles'

const label = (handle: string): string => handle.replace(/_/g, ' ')

interface ClickSendOutputPreview {
  _route?: string
  reason?: string | null
  partner_lead_id?: string | null
  count?: number | null
  partner_slug?: string | null
}

/**
 * The Buyer Click Send card (#1542). Says whether a buyer is picked, names it
 * by the slug the last run resolved (the config holds only its id, #1553, which
 * is never shown as a name), and after a run the route it took: the partner lead
 * id on a send, the reason otherwise.
 */
export function BuyerClickSendNode({ id, data, selected }: NodeProps) {
  const { namespace, label: title, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const hasPartner = typeof config.partner_id === 'string' && config.partner_id.trim() !== ''
  let partnerSlug = ''

  let preview: string | null = null
  let route: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as ClickSendOutputPreview
    route = out._route ?? null
    if (typeof out.partner_slug === 'string') partnerSlug = out.partner_slug
    if (out._route === 'sent') {
      preview = `sent${out.partner_lead_id ? ` (${out.partner_lead_id})` : ''}${typeof out.count === 'number' ? `, ${out.count} today` : ''}`
    } else if (out._route) {
      preview = `${label(out._route)}${out.reason ? ` (${out.reason})` : ''}`
    }
  }

  const width = nodeWidth('buyer_click_send', data)

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
        <span className={`ml-auto rounded px-1.5 py-0.5 text-xs ${hasPartner ? 'bg-lime-100 text-lime-800' : 'bg-amber-100 text-amber-800'}`}>
          {!hasPartner ? 'no partner' : partnerSlug || 'partner set'}
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

      {/* Each label owns the room above its handle and may wrap to two lines. */}
      <SourceHandles
        nodeId={id}
        type="buyer_click_send"
        width={width}
        data={data}
        rowHeight={34}
        textClassName="text-[10px]"
        wrap
        describe={(h) => ({ label: label(h), className: h === 'sent' ? 'font-semibold text-lime-800' : 'text-slate-500' })}
      />
    </div>
  )
}
