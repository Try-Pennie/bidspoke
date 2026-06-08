import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Code } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'
import { TimeoutWarningBadge } from './TimeoutWarningBadge'

export function CodeNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const script = config.script as string | undefined
  const scriptPreview = script?.trim().split('\n')[0]?.slice(0, 40) || undefined
  const outputPreview = getOutputPreview(executionStep)
  // Surface a 4xx/5xx response sentinel (typically an `expected: true` error)
  // as a red pill, mirroring SalesforceNode's expected_errors rendering.
  const execOutput = executionStep?.output as { response?: { status?: number } } | null | undefined
  const sentinelStatus = execOutput?.response?.status
  const showStatusPill = sentinelStatus !== undefined && sentinelStatus >= 400

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-amber-400 ring-2 ring-amber-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <SuccessBadge visible={isSuccessNode} />
      <NoteBadge note={note} />
      <TimeoutWarningBadge type="code" config={config} />
      <Handle type="target" position={Position.Top} id="input" />
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-amber-50 border-b border-amber-100 px-3 py-2">
        <Code className="h-4 w-4 text-amber-500" />
        <span className="font-mono text-xs font-bold tracking-wide text-amber-700">CODE</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
          {scriptPreview ?? 'No script written'}
        </p>
        {showStatusPill ? (
          <p className="mt-1 truncate rounded bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-700">{sentinelStatus}</p>
        ) : outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
