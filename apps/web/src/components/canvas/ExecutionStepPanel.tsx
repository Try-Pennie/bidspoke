import { useState } from 'react'
import { Check, Clock, Copy, CheckCircle, SkipForward, X, XCircle } from 'lucide-react'
import type { ExecutionStep } from '@/types/workflow'
import type { Node } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import RailResizeHandle from './RailResizeHandle'

interface Props {
  node: Node
  onClose: () => void
  width?: number
  onResize?: (width: number) => void
}

const STATUS_CONFIG = {
  completed:            { icon: CheckCircle, label: 'Completed',  color: 'text-green-600' },
  failed:               { icon: XCircle,     label: 'Failed',     color: 'text-red-600'   },
  skipped:              { icon: SkipForward, label: 'Skipped',    color: 'text-gray-500'  },
  running:              { icon: Clock,       label: 'Running',    color: 'text-blue-600'  },
  failed_with_fallback: { icon: XCircle,     label: 'Fallback',   color: 'text-yellow-600'},
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState(false)
  if (value === null || value === undefined) return null
  const text = JSON.stringify(value, null, 2)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <button
          onClick={() => {
            navigator.clipboard.writeText(text).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          title="Copy"
        >
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-700">
        {text}
      </pre>
    </div>
  )
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export default function ExecutionStepPanel({ node, onClose, width, onResize }: Props) {
  const { namespace, executionStep } = node.data as unknown as CanvasNodeData
  const effectiveWidth = width ?? 320
  const [errCopied, setErrCopied] = useState(false)

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: effectiveWidth }}
    >
      {onResize && <RailResizeHandle width={effectiveWidth} onResize={onResize} />}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="font-mono text-sm font-semibold text-graphite">{namespace}</p>
          <p className="text-xs capitalize text-gray-400">{node.type} node</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!executionStep ? (
          <p className="text-sm text-gray-400">This step was not reached in this execution.</p>
        ) : (
          <>
            {/* Status + duration */}
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-beige px-3 py-2">
              <div className="flex items-center gap-2">
                {(() => {
                  const cfg = STATUS_CONFIG[executionStep.status as keyof typeof STATUS_CONFIG]
                  if (!cfg) return null
                  const Icon = cfg.icon
                  return (
                    <>
                      <Icon className={`h-4 w-4 ${cfg.color}`} />
                      <span className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</span>
                    </>
                  )
                })()}
              </div>
              <span className="text-xs text-gray-400">{formatDuration(executionStep.duration_ms)}</span>
            </div>

            {/* Error */}
            {executionStep.error_message && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-medium text-red-600">
                    Error{executionStep.error_type ? ` · ${executionStep.error_type}` : ''}
                    {executionStep.retries_used > 0 ? ` · ${executionStep.retries_used} retr${executionStep.retries_used === 1 ? 'y' : 'ies'}` : ''}
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(executionStep.error_message ?? '').catch(() => {})
                      setErrCopied(true)
                      setTimeout(() => setErrCopied(false), 1500)
                    }}
                    className="rounded p-0.5 text-red-400 hover:bg-red-100 hover:text-red-600"
                    title="Copy"
                  >
                    {errCopied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
                <p className="font-mono text-xs text-red-700">{executionStep.error_message}</p>
              </div>
            )}

            {/* Input / Output */}
            <JsonBlock label="Input" value={executionStep.input} />
            <JsonBlock label="Output" value={executionStep.output} />
          </>
        )}
      </div>
    </aside>
  )
}
