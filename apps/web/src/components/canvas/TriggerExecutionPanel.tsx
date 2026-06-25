'use client'

import { X } from 'lucide-react'
import JsonTreeView from './JsonTreeView'
import RailResizeHandle from './RailResizeHandle'

interface Props {
  workflowId: string
  payload: unknown
  source?: string | null
  traceId?: string | null
  startedAt?: string | null
  onClose: () => void
  width?: number
  onResize?: (width: number) => void
}

export default function TriggerExecutionPanel({
  workflowId,
  payload,
  source,
  traceId,
  startedAt,
  onClose,
  width,
  onResize,
}: Props) {
  const effectiveWidth = width ?? 320

  // Shape mirrors ctx.trigger in the engine so copyable paths line up with
  // what code/transform nodes actually see at runtime.
  const triggerData = {
    payload: payload ?? null,
    source: source ?? null,
    workflow_id: workflowId,
    trace_id: traceId ?? null,
    started_at: startedAt ?? null,
  }

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: effectiveWidth }}
    >
      {onResize && <RailResizeHandle width={effectiveWidth} onResize={onResize} />}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Trigger</p>
          <p className="mt-0.5 text-sm font-semibold text-graphite">Webhook event</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {payload === undefined ? (
          <p className="text-sm text-gray-500">Loading event…</p>
        ) : (
          <JsonTreeView data={triggerData} basePath="steps.trigger" maxHeightClassName="max-h-[calc(100vh-140px)]" />
        )}
      </div>
    </aside>
  )
}
