'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { DollarSign } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'

interface PartnerBidOutput {
  partner: string
  bid: number | null
  accepted: boolean
  skipped: boolean
  skip_reason?: string
}

export function PartnerBidNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData

  const partnerName = (config.partner_name as string | undefined) ?? (config.partner_id ? '…' : null)

  let resultLine: { text: string; tone: 'green' | 'gray' | 'red' } | null = null
  if (executionStep?.output && typeof executionStep.output === 'object') {
    const out = executionStep.output as Partial<PartnerBidOutput>
    if (out.accepted && out.bid != null) {
      resultLine = { text: `$${out.bid}`, tone: 'green' }
    } else if (out.skipped) {
      resultLine = { text: out.skip_reason ?? 'skipped', tone: 'gray' }
    } else if (executionStep.status === 'failed') {
      resultLine = { text: 'error', tone: 'red' }
    }
  }

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-sky-400 ring-2 ring-sky-200' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-sky-50 border-b border-sky-100 px-3 py-2">
        <DollarSign className="h-4 w-4 text-sky-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-sky-700">Partner Bid</span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        {resultLine ? (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${
            resultLine.tone === 'green' ? 'bg-sky-100 text-sky-700' :
            resultLine.tone === 'red' ? 'bg-red-100 text-red-600' :
            'bg-gray-100 text-gray-500'
          }`}>
            {resultLine.text}
          </p>
        ) : partnerName ? (
          <p className="mt-0.5 truncate text-xs text-slate-400">{partnerName}</p>
        ) : (
          <p className="mt-0.5 truncate text-xs text-amber-500">No partner selected</p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
