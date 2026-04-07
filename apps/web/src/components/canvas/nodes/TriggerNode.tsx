'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Zap } from 'lucide-react'
import type { WorkflowDef } from '@/types/workflow'

export function TriggerNode({ data, selected }: NodeProps) {
  const trigger = (data as unknown as { trigger?: WorkflowDef['trigger'] }).trigger
  const method = (trigger?.config?.method as string | undefined) ?? 'POST'
  const auth = (trigger?.config?.auth_method as string | undefined) ?? 'api_key'
  const authLabel = auth === 'api_key' ? 'API Key' : auth === 'none' ? 'None' : auth

  return (
    <div className={`relative w-52 rounded-lg border bg-white shadow-sm ${
      selected ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-gray-200'
    }`}>
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 rounded-t-lg bg-indigo-50 border-b border-indigo-100 px-3 py-2">
        <Zap className="h-4 w-4 text-indigo-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Trigger</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-semibold text-gray-900">{method}</p>
        <p className="mt-0.5 text-xs text-slate-400">Auth: {authLabel}</p>
      </div>
    </div>
  )
}
