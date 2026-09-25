import { useId } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { BadgeDollarSign } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles } from './SourceHandles'
import { handBackMeaning } from './buyer-select-exits'

// The handles themselves come from the node type's own list (NODE_TRAITS), through SourceHandles.
const HANDLE_LABEL: Record<string, string> = {
  sold: 'sold',
  no_sale: 'no sale',
  not_applicable: 'not applicable',
  deferred: 'deferred',
}

interface BuyerSelectOutputPreview {
  sale?: { skipped?: boolean; accepted?: boolean; partner_slug?: string | null; result_code?: string | null } | null
  reason?: string | null
  mode_effective?: string
  _route?: string
}

/**
 * The Buyer Select card (#1411). Shows the mode it runs in, and after a run the
 * route it took with the buyer it sold to or the reason it did not.
 */
export function BuyerSelectNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  // No default: the engine has none and fails the step as mode_invalid (#1495).
  const mode = config.mode === 'live' ? 'live' : config.mode === 'decide_only' ? 'decide_only' : null
  const population = (config.population as string | undefined) ?? ''
  const tipId = useId()

  let preview: string | null = null
  let route: string | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as BuyerSelectOutputPreview
    route = out._route ?? null
    if (out._route === 'sold' && out.sale?.partner_slug) {
      preview = `sold to ${out.sale.partner_slug}${out.sale.result_code ? ` (${out.sale.result_code})` : ''}`
    } else if (out._route) {
      preview = `${HANDLE_LABEL[out._route] ?? out._route}${out.reason ? ` (${out.reason})` : ''}`
    }
  }

  // Rendered at the layout's reserved span width, handles placed over their
  // children's columns, the same way branch and bid_group do.
  const width = nodeWidth('buyer_select', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-emerald-50 border-b border-emerald-100 px-3 py-2">
        <BadgeDollarSign className={`h-4 w-4 ${NODE_TYPE_COLOR.buyer_select.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Buyer Select</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-xs ${mode === null ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
          {mode === 'live' ? 'live' : mode === 'decide_only' ? 'decide only' : 'no mode set'}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {preview ? (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${
            route === 'sold' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {preview}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-400">{population ? `${population} leads` : 'no population set'}</p>
        )}
      </div>

      {/* Each label owns the room above its handle and may wrap to two lines,
          because four labels in one row overlapped at the card's real width
          (seen at 1600 wide on 2026-09-22, L606). */}
      <SourceHandles
        nodeId={id}
        type="buyer_select"
        width={width}
        data={data}
        rowHeight={34}
        textClassName="text-[10px]"
        wrap
        describe={(h) => ({
          className: `group ${h === 'sold' ? 'font-semibold text-emerald-700' : 'text-slate-500'}`,
          label: h === 'deferred' || h === 'not_applicable' ? (
            // The two exits that hand the lead back are domain terms nobody can
            // guess (#1490, L604), so each explains itself on hover and on focus.
            <>
              <button
                type="button"
                aria-describedby={`${tipId}-${h}`}
                className="nodrag nopan cursor-help rounded-sm underline decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              >
                {HANDLE_LABEL[h]}
              </button>
              <span
                role="tooltip"
                id={`${tipId}-${h}`}
                className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-60 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-2.5 text-left text-xs font-normal leading-snug text-gray-600 shadow-md group-hover:block group-focus-within:block"
              >
                {handBackMeaning(h, config)}
              </span>
            </>
          ) : (
            HANDLE_LABEL[h] ?? h
          ),
        })}
      />
    </div>
  )
}
