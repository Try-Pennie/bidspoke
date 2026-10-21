import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { SquareCheckBig } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { NODE_TYPE_COLOR } from './node-colors'

/** How many checks the step runs, the one fact the card gives about them (C1). */
function checksLine(config: Record<string, unknown>): string {
  const n = Array.isArray(config.checks) ? config.checks.length : 0
  if (n === 0) return 'No checks'
  return n === 1 ? '1 check' : `${n} checks`
}

/**
 * The lead validation step's card (#2590), as Dan settled it on 2026-10-21 in
 * docs/design/lead-validation-node-card.html: under its title and step id it
 * says how many checks it runs and nothing more, the checks living in the
 * settings panel (C1); its header is slate, 50 behind, 100 for the rule and 700
 * for the label (C2); and it has one way out, labelled pass as a Filter's is,
 * because a rejected lead is answered by the step itself and goes nowhere else
 * on the canvas (C3).
 */
export function LeadValidationNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const outputPreview = getOutputPreview(executionStep)

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-p-blue-dark ring-2 ring-p-blue-light' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div data-card-header className="flex items-center gap-2 rounded-t-lg border-b border-slate-100 bg-slate-50 px-3 py-2">
        <SquareCheckBig className={`h-4 w-4 ${NODE_TYPE_COLOR.lead_validation.icon}`} aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">Lead validation</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400">{checksLine(config)}</p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
      <div className="relative border-t border-gray-100 text-xs" style={{ height: 28 }}>
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-0.5 text-center text-green-600">↓ pass</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
