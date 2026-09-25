import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Filter } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { filterConditionSummary } from '@/lib/filter-condition'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles, type HandleLabel } from './SourceHandles'

const FILTER_LABEL: Record<string, HandleLabel> = {
  pass: { label: '↓ pass', className: 'text-green-600' },
  exit: { label: '↓ exit', className: 'text-red-500' },
}

export function FilterNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const operation = (config.operation as 'continue_if' | 'end_if' | undefined) ?? 'continue_if'
  const outputPreview = getOutputPreview(executionStep)

  // Understands BOTH shapes the engine evaluates. Reading only config.condition
  // made a rule-builder filter render "No condition set" while it gated traffic (#645).
  const conditionSummary = filterConditionSummary(config)

  const width = nodeWidth('filter', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-p-blue-dark ring-2 ring-p-blue-light' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-p-blue-light border-b border-p-blue-light px-3 py-2">
        <Filter className={`h-4 w-4 ${NODE_TYPE_COLOR.filter.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-p-blue-dark">Filter</span>
        <span className="ml-auto rounded bg-p-blue-light px-1.5 py-0.5 text-xs text-p-blue-dark">
          {operation === 'continue_if' ? 'continue if' : 'end if'}
        </span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400">
          {conditionSummary ?? 'No condition set'}
        </p>
        {outputPreview && (
          <p className="mt-1 truncate rounded bg-green-100 px-1.5 py-0.5 font-mono text-xs text-green-700">{outputPreview}</p>
        )}
      </div>
      <SourceHandles nodeId={id} type="filter" width={width} data={data} describe={(id) => FILTER_LABEL[id] ?? { label: id }} />
    </div>
  )
}
