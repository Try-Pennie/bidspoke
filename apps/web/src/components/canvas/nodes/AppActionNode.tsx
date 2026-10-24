import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Box } from 'lucide-react'
import type { CanvasNodeData } from '@/types/workflow'
import { SERVICE_MARKS } from '@bidspoke/service-catalogue/schema'
import { appActionDisplay, type AppActionMark } from '@/lib/app-action-display'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

/**
 * The service's own mark (#2339, round 2: "Service's own icon"), from the
 * catalogue's display data (marks.ts), each drawn at Google Drive's size and
 * place. A service with no mark (Slack, OpenAI) draws the plain box.
 */
function ServiceMark({ mark }: { mark: AppActionMark | null }) {
  const drawn = mark !== null ? SERVICE_MARKS[mark] : undefined
  if (!drawn) return <Box className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={drawn.viewBox} className="h-4 w-4 shrink-0" aria-hidden="true" data-mark={mark}>
      {drawn.paths.map((p) => (p.stroke
        ? <path key={p.d} d={p.d} fill="none" stroke={p.stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        : <path key={p.d} d={p.d} fill={p.fill} fillRule={p.fillRule} />))}
    </svg>
  )
}

/**
 * An ops step running one catalogue action (#2339), as settled in
 * docs/design/app-action-node-card.html: the plain beige header the uncommon
 * steps use, carrying the service's own mark and name, with the action in a
 * chip on its right; then the step's name and its step id.
 */
export function AppActionNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const shown = appActionDisplay((config ?? {}) as Record<string, unknown>)
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-gray-400 ring-2 ring-gray-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg border-b border-gray-200 bg-beige px-3 py-2">
        <ServiceMark mark={shown.mark} />
        <span className="truncate whitespace-nowrap text-xs font-semibold text-gray-600">{shown.service}</span>
        {shown.action && (
          <span className="ml-auto shrink-0 whitespace-nowrap rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{shown.action}</span>
        )}
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
