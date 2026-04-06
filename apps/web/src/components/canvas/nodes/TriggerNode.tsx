'use client'

import { Handle, Position } from '@xyflow/react'
import { Zap } from 'lucide-react'

export function TriggerNode() {
  return (
    <div className="flex min-w-[160px] flex-col items-center rounded-lg border-2 border-indigo-500 bg-indigo-50 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-indigo-700">
        <Zap size={14} />
        Webhook Trigger
      </div>
      <p className="mt-0.5 text-xs text-indigo-400">POST · API Key</p>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-500" />
    </div>
  )
}
