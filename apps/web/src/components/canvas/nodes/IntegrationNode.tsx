import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Plug } from 'lucide-react'
import { getExecutionClasses, getExecutionStyle } from './execution-status'

const SERVICE_LABELS: Record<string, string> = {
  equifax: 'Equifax',
  eligibility_scout: 'Eligibility Scout',
  lendswift: 'LendSwift',
  salesforce: 'Salesforce',
  custom: 'Webhook',
}

export function IntegrationNode({ data, selected }: NodeProps) {
  const { namespace, config, executionStep } = data as unknown as CanvasNodeData
  const service = (config.service as string | undefined) ?? 'custom'
  const method = ((config.method as string | undefined) ?? 'POST').toUpperCase()
  const url = (config.url as string | undefined) ?? ''
  const serviceLabel = SERVICE_LABELS[service] ?? service

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
        selected ? 'border-teal-300 ring-2 ring-teal-100' : 'border-gray-200'
      } ${getExecutionClasses(executionStep)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Plug className="h-3.5 w-3.5 text-teal-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-teal-600">
          {serviceLabel}
        </span>
        <span className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-500">
          {method}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium text-gray-800">{namespace}</p>
        {statusBadge ? (
          <p className="mt-1 truncate rounded bg-teal-50 px-1.5 py-0.5 font-mono text-xs text-teal-700">
            HTTP {statusBadge}
          </p>
        ) : url ? (
          <p className="mt-0.5 truncate font-mono text-xs text-gray-400" title={url}>
            {urlDisplay}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-gray-400">No URL configured</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
