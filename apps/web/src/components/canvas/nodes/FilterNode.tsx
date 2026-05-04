import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData, EdgeCondition } from '@/types/workflow'
import { Filter } from 'lucide-react'
import { getNodeClasses, getExecutionStyle, getOutputPreview } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'

const OP_LABELS: Partial<Record<EdgeCondition['operator'], string>> = {
  eq: 'equals', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  contains: 'contains', not_contains: "doesn't contain",
  exists: 'exists', not_exists: "doesn't exist",
}

export function FilterNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const operation = (config.operation as 'continue_if' | 'end_if' | undefined) ?? 'continue_if'
  const condition = config.condition as { field?: string; operator?: EdgeCondition['operator']; value?: unknown } | undefined
  const outputPreview = getOutputPreview(executionStep)

  const conditionSummary = condition?.field
    ? [
        condition.field,
        OP_LABELS[condition.operator ?? 'eq'],
        condition.value !== undefined && condition.value !== '' ? String(condition.value) : undefined,
      ]
        .filter(Boolean)
        .join(' ')
    : null

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-p-blue-dark ring-2 ring-p-blue-light' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <SuccessBadge visible={isSuccessNode} />
      <NoteBadge note={note} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-p-blue-light border-b border-p-blue-light px-3 py-2">
        <Filter className="h-4 w-4 text-p-blue-dark" />
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
      <div className="flex justify-between border-t border-gray-100 px-3 py-2 text-xs">
        <span className="text-green-600">↓ pass</span>
        <span className="text-red-500">↓ exit</span>
      </div>

      <Handle type="source" position={Position.Bottom} id="pass" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="exit" style={{ left: '70%' }} />
    </div>
  )
}
