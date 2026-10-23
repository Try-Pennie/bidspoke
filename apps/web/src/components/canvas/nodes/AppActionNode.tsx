import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Box } from 'lucide-react'
import type { CanvasNodeData } from '@/types/workflow'
import { appActionDisplay, type AppActionMark } from '@/lib/app-action-display'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

/** Google Drive's own mark (#2339, round 2: "Service's own icon"). */
function GoogleDriveMark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 87.3 78" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  )
}

function ServiceMark({ mark }: { mark: AppActionMark | null }) {
  if (mark === 'google-drive') return <GoogleDriveMark />
  // A service whose own mark the build does not hold yet draws the plain box.
  return <Box className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
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
