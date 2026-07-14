import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Plug } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { NODE_TYPE_COLOR } from './node-colors'

// Fallback labels for nodes saved before service_label was stored in config
const SERVICE_LABELS: Record<string, string> = {
  equifax: 'Equifax',
  salesforce: 'Salesforce',
  custom: 'HTTP Request',
}

export function IntegrationNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const service = (config.service as string | undefined) ?? 'custom'
  const method = ((config.method as string | undefined) ?? 'POST').toUpperCase()
  const url = (config.url as string | undefined) ?? ''
  // service_label is the name the USER gave this integration (the "Service name"
  // field, editable for custom services). It is a name, not a claim about what
  // the node sends, so the engine has no reason to read it. See the display-only
  // allowlist in node-card-config-guard.ts (#645).
  const serviceLabel = (config.service_label as string | undefined) || SERVICE_LABELS[service] || service

  let statusBadge: string | null = null
  if (executionStep?.status === 'completed' && executionStep.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as { status?: number }
    if (out.status) statusBadge = String(out.status)
  }

  // Truncate URL for display — strip protocol and trailing path after first /
  const urlDisplay = url
    .replace(/^\{\{.*?\}\}/, '{{…}}')
    .replace(/^https?:\/\//, '')
    .split('?')[0]

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-teal-400 ring-2 ring-teal-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-teal-50 border-b border-teal-100 px-3 py-2">
        <Plug className={`h-4 w-4 ${NODE_TYPE_COLOR.webhook.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-teal-700">
          {serviceLabel}
        </span>
        <span className="ml-auto rounded bg-teal-100 px-1.5 py-0.5 text-xs font-mono text-teal-600">
          {method}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {statusBadge ? (
          <p className="mt-1 truncate rounded bg-teal-50 px-1.5 py-0.5 font-mono text-xs text-teal-700">
            HTTP {statusBadge}
          </p>
        ) : url ? (
          <p className="mt-0.5 truncate font-mono text-xs text-slate-400" title={url}>
            {urlDisplay}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-slate-400">No URL configured</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
