'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData, ParallelChildSlot } from '@/types/workflow'
import { GitFork } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { nodeWidth } from '@/lib/layout'
import { NODE_TYPE_COLOR } from './node-colors'
import { SourceHandles } from './SourceHandles'

interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
}

function readSlots(config: Record<string, unknown>): ParallelChildSlot[] {
  const raw = config.children
  if (!Array.isArray(raw)) return []
  // Legacy shape: string[] of node ids — synthesize slots so the canvas renders
  // until the next save migrates the definition forward.
  if (raw.length > 0 && typeof raw[0] === 'string') {
    return (raw as string[]).map((_, i) => ({ id: `child-${i}`, label: `child_${i + 1}` }))
  }
  return raw as ParallelChildSlot[]
}

export function ParallelNode({ id, data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData
  const waitFor = (config.wait_for as string | undefined) ?? 'all'
  const slots = readSlots(config)

  let resultLine: string | null = null
  let hasChildFailure = false
  if (executionStep?.output && Array.isArray(executionStep.output)) {
    const results = executionStep.output as ParallelChildResult[]
    const failed = results.filter((r) => r.status !== 'fulfilled').length
    if (failed > 0) {
      const total = results.length
      resultLine = `${total - failed}/${total} completed`
      hasChildFailure = true
    }
  }

  const effectiveStep = hasChildFailure && executionStep
    ? { ...executionStep, status: 'failed' as const }
    : executionStep
  const width = nodeWidth('parallel', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-slate-400 ring-2 ring-slate-200' : 'border-gray-200'
      } ${getNodeClasses(effectiveStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(effectiveStep), width }}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-beige border-b border-gray-100 px-3 py-2">
        <GitFork className={`h-4 w-4 ${NODE_TYPE_COLOR.parallel.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Parallel</span>
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
          wait {waitFor}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {resultLine ? (
          <p className="mt-1 truncate rounded bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-700">
            {resultLine}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {slots.length > 0
              ? `${slots.length} slot${slots.length !== 1 ? 's' : ''}`
              : '(start). No slots.'}
          </p>
        )}
      </div>

      {/* Each slot's handle sits above its child's column; SourceHandles also
          tells React Flow when the slot list changes, so an edge from a freshly
          added slot finds its handle. */}
      {slots.length > 0 ? (
        <SourceHandles
          nodeId={id}
          type="parallel"
          width={width}
          data={data}
          describe={(h) => ({ label: `↓ ${slots.find((s) => s.id === h)?.label ?? h}`, className: 'text-slate-500' })}
        />
      ) : (
        <Handle type="source" position={Position.Bottom} id="output" />
      )}
    </div>
  )
}
