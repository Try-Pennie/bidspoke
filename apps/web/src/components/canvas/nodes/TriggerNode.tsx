'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Zap } from 'lucide-react'
import type { WorkflowDef } from '@/types/workflow'
import { NODE_TYPE_COLOR } from './node-colors'

export function TriggerNode({ data, selected }: NodeProps) {
  const trigger = (data as unknown as { trigger?: WorkflowDef['trigger'] }).trigger
  const method = (trigger?.config?.method as string | undefined) ?? 'POST'
  const auth = (trigger?.config?.auth_method as string | undefined) ?? 'api_key'
  const authLabel = auth === 'api_key' ? 'API Key' : auth === 'none' ? 'None' : auth

  return (
    <div className={`relative w-52 rounded-lg border bg-white shadow-sm ${
      selected ? 'border-p-blue-dark ring-2 ring-p-blue-light' : 'border-gray-200'
    }`}>
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-p-blue-light border-b border-p-blue-light px-3 py-2">
        <Zap className={`h-4 w-4 ${NODE_TYPE_COLOR.trigger.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-p-blue-dark">Trigger</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-semibold text-graphite">{method}</p>
        <p className="mt-0.5 text-xs text-slate-400">Auth: {authLabel}</p>
      </div>
    </div>
  )
}
