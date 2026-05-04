'use client'

import { useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData, ParallelChildSlot } from '@/types/workflow'
import { GitFork } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'
import { nodeWidth } from '@/lib/layout'

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
  const { namespace, label, config, executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const waitFor = (config.wait_for as string | undefined) ?? 'all'
  const slots = readSlots(config)

  // Force React Flow to re-scan this node's handles whenever the slot list
  // changes. Without this, an edge created from a freshly-added slot
  // (e.g. a webhook auto-attaching right after the user added the slot)
  // silently fails to render because the new handle isn't in nodeInternals yet.
  const updateNodeInternals = useUpdateNodeInternals()
  const slotIdsKey = slots.map((s) => s.id).join(',')
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, slotIdsKey, updateNodeInternals])

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
        selected ? 'border-slate-400 ring-2 ring-slate-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(effectiveStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(effectiveStep), width }}
    >
      <SuccessBadge visible={isSuccessNode} />
      <NoteBadge note={note} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-beige border-b border-gray-100 px-3 py-2">
        <GitFork className="h-4 w-4 text-slate-500" />
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

      {/* Slot label row + source handles. Both share `handleLeftPct` so the
          dot always sits directly under its label, even when layout-computed
          _handleOffsets place handles above asymmetric child columns. */}
      {slots.length > 0 ? (() => {
        const offsets = (data as { _handleOffsets?: number[] } | undefined)?._handleOffsets
        const handleLeftPct = (i: number): string => {
          if (offsets && offsets[i] !== undefined) {
            return `${((offsets[i] + width / 2) / width) * 100}%`
          }
          return `${((i + 0.5) / slots.length) * 100}%`
        }
        return (
          <>
            <div className="relative border-t border-gray-100 py-2 text-xs" style={{ height: 28 }}>
              {slots.map((s, i) => (
                <span
                  key={s.id}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 truncate px-1 text-center text-slate-500"
                  style={{ left: handleLeftPct(i), maxWidth: `${(100 / slots.length).toFixed(2)}%` }}
                >
                  ↓ {s.label}
                </span>
              ))}
            </div>
            {slots.map((s, i) => (
              <Handle
                key={s.id}
                type="source"
                position={Position.Bottom}
                id={s.id}
                style={{ left: handleLeftPct(i) }}
              />
            ))}
          </>
        )
      })() : (
        <Handle type="source" position={Position.Bottom} id="output" />
      )}
    </div>
  )
}
