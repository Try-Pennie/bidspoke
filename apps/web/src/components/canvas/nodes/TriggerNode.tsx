'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Zap } from 'lucide-react'
import type { WorkflowDef } from '@/types/workflow'

export function TriggerNode({ data }: NodeProps) {
  const trigger = (data as unknown as { trigger?: WorkflowDef['trigger'] }).trigger
  const method = (trigger?.config?.method as string | undefined) ?? 'POST'
  const auth = (trigger?.config?.auth_method as string | undefined) ?? 'api_key'
  const authLabel = auth === 'api_key' ? 'API Key' : auth === 'none' ? 'None' : auth

  return (
    <div className="relative w-52 rounded-lg border border-gray-200 bg-white shadow-sm">
      <Handle type="source" position={Position.Bottom} id="output" />

      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <Zap className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Trigger</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-gray-800">{method}</p>
        <p className="mt-0.5 text-xs text-gray-400">Auth: {authLabel}</p>
      </div>
    </div>
  )
}
