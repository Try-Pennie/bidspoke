'use client'

import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { Cloud } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { NODE_TYPE_COLOR } from './node-colors'

const OPERATION_LABELS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  upsert: 'Upsert',
  query:  'Query',
  apex:   'Apex',
}

// A query names its object inside its SOQL and has no `object` field (#1568), so
// the subtitle reads the object after FROM, or plain "Query" when the SOQL is a
// template. "Unconfigured" means only that there is no SOQL at all.
function querySubtitle(soql: string): string {
  if (!soql.trim()) return 'Unconfigured'
  const from = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(soql)
  return from ? `Query ${from[1]}` : 'Query'
}

export function SalesforceNode({ data, selected }: NodeProps) {
  const { namespace, label, config, executionStep, hasError, isReachable } = data as unknown as CanvasNodeData

  const operation = (config.operation as string | undefined) ?? 'create'
  const object = (config.object as string | undefined) ?? ''
  const apexPath = (config.apex_path as string | undefined) ?? ''
  const opLabel = OPERATION_LABELS[operation] ?? operation
  const subtitle = operation === 'apex'
    ? (apexPath || 'Unconfigured')
    : operation === 'query'
      ? querySubtitle((config.soql as string | undefined) ?? '')
      : object ? `${opLabel} ${object}` : 'Unconfigured'

  const execOutput = executionStep?.output as { status?: number; body?: unknown } | null | undefined
  const statusCode = execOutput?.status

  return (
    <div
      className={`relative w-52 rounded-lg border bg-white shadow-sm ${
        selected ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={getExecutionStyle(executionStep)}
    >
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-blue-50 border-b border-blue-100 px-3 py-2">
        <Cloud className={`h-4 w-4 ${NODE_TYPE_COLOR.salesforce.icon}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">Salesforce</span>
        {(object || operation === 'apex') && (
          <span className="ml-auto rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">
            {opLabel}
          </span>
        )}
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{label || namespace}</p>
        {label && <p className="truncate font-mono text-xs text-slate-400">{namespace}</p>}
        <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>
        {statusCode !== undefined && (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 font-mono text-xs ${statusCode >= 200 && statusCode < 300 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {statusCode}
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
