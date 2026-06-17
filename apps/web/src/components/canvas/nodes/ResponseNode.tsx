import { useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { ArrowRight } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'

export function ResponseNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const statusRaw = config.status_code as number | string | undefined
  // When the status is a {{template}}, the literal can be long and overflow the
  // node body. Show a compact "dynamic" badge and surface the full expression on
  // hover via title attribute. Plain numbers render verbatim.
  const statusIsTemplate = typeof statusRaw === 'string' && statusRaw.includes('{{')
  const statusDisplay = statusIsTemplate ? 'dynamic' : (statusRaw ?? 200)
  const statusTitle = statusIsTemplate ? String(statusRaw) : undefined
  const continueAfter = Boolean(config.continue_after_response)
  const outputPreview = getOutputPreview(executionStep)

  // Toggling continue_after_response adds/removes the bottom source handle at
  // runtime. Without this, React Flow's nodeInternals doesn't know about the
  // new handle and edges from it render as invisible (silent-edge-drop).
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, continueAfter, updateNodeInternals])

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-green-400 ring-2 ring-green-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />
      {continueAfter && <Handle type="source" position={Position.Bottom} id="output" />}

      <div className="flex items-center gap-2 rounded-t-lg bg-green-100 border-b border-green-200 px-3 py-2">
        <ArrowRight className="h-4 w-4 text-green-600" />
        <span className="text-xs font-semibold uppercase tracking-wide text-green-700">Response</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400" title={statusTitle}>HTTP {statusDisplay}{continueAfter ? ' · continues' : ''}</p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
    </div>
  )
}
