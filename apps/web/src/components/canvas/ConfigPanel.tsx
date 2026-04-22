'use client'

import { useState, useEffect, useRef } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import dynamic from 'next/dynamic'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })
import type { Node } from '@xyflow/react'
import type { CanvasNodeData, ConditionGroup, EdgeCondition, NodeType, ExecutionStep } from '@/types/workflow'
import RuleBuilder from '@/components/rule-builder/RuleBuilder'
import FieldAutocomplete from '@/components/rule-builder/FieldAutocomplete'
import TemplateTextarea from './TemplateTextarea'
import { X, Trash2, Plus, XCircle, CheckCircle, ChevronDown, ChevronRight, ArrowRight, Copy, Link2, RotateCcw, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { ServicePreset, ServiceConnection, SchemaObject, Partner } from '@/lib/api'
import RailResizeHandle from './RailResizeHandle'

interface Props {
  node: Node
  onUpdate?: (id: string, data: Partial<CanvasNodeData>) => void
  onDelete?: (id: string) => void
  onDuplicate?: (id: string) => void
  onClose: () => void
  nodeNamespaces: string[]
  nodeOptions?: { id: string; namespace: string; label?: string }[]
  refs?: string[]
  readOnly?: boolean
  edges?: { id: string; source: string; target: string; sourceHandle?: string | null }[]
  onEdgesChange?: (add: { id: string; source: string; target: string; sourceHandle: string }[], removeIds: string[]) => void
  canRerun?: boolean
  onRerun?: (namespace: string) => void
  width?: number
  onResize?: (width: number) => void
}

export default function ConfigPanel({ node, onUpdate = () => {}, onDelete = () => {}, onDuplicate = () => {}, onClose, nodeNamespaces, nodeOptions = [], refs = [], readOnly = false, edges = [], onEdgesChange, canRerun = false, onRerun, width, onResize }: Props) {
  const data = node.data as unknown as CanvasNodeData & { executionStep?: ExecutionStep | null }
  const type = node.type as NodeType
  const exec = data.executionStep
  const isCode = type === 'code'
  const effectiveWidth = width ?? (isCode ? 540 : 320)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showMeta, setShowMeta] = useState(true)
  const nsManuallyEdited = useRef(false)

  useEffect(() => { nsManuallyEdited.current = false }, [node.id])

  function toNamespace(label: string) {
    return label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  }

  function handleLabelChange(value: string) {
    const patch: Partial<CanvasNodeData> = { label: value || undefined }
    if (!nsManuallyEdited.current) patch.namespace = toNamespace(value) || data.namespace
    onUpdate(node.id, patch)
  }

  function handleNamespaceChange(value: string) {
    nsManuallyEdited.current = true
    onUpdate(node.id, { namespace: value })
  }

  function updateConfig(patch: Record<string, unknown>) {
    onUpdate(node.id, { config: { ...data.config, ...patch } })
  }

  return (
    <aside
      className="relative flex flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: effectiveWidth }}
    >
      {onResize && <RailResizeHandle width={effectiveWidth} onResize={onResize} />}
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{type}</p>
          <p className="mt-0.5 text-sm font-semibold text-graphite">{data.label || data.namespace}</p>
          {data.label && <p className="font-mono text-xs text-gray-400">{data.namespace}</p>}
        </div>
        <div className="flex items-center gap-1">
          {readOnly ? (
            <span className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">View only</span>
          ) : (
            <>
              <button
                onClick={() => onDuplicate(node.id)}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                title="Duplicate node (⌘D)"
              >
                <Copy className="h-4 w-4" />
              </button>
              <button
                onClick={() => onDelete(node.id)}
                className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                title="Delete node"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Execution result banner */}
      {exec && exec.status === 'failed' && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-red-600">
            <XCircle className="h-3.5 w-3.5 flex-shrink-0" />
            Failed{exec.error_type ? ` · ${exec.error_type}` : ''}
          </div>
          {exec.error_message && (
            <p className="mt-1 font-mono text-xs text-red-700">{exec.error_message}</p>
          )}
        </div>
      )}
      {exec && exec.status === 'completed' && (
        <div className="flex items-center gap-1.5 border-b border-green-100 bg-green-50 px-4 py-2 text-xs font-medium text-green-700">
          <CheckCircle className="h-3.5 w-3.5" />
          Completed
        </div>
      )}

      {/* Body — code nodes use a flex-fill layout so the editor expands to full height */}
      {isCode ? (
        <div className={`flex flex-1 flex-col overflow-hidden text-sm ${readOnly ? 'pointer-events-none' : ''}`}>
          {/* Collapsible meta fields */}
          <div className="border-b border-gray-100">
            <button
              onClick={() => setShowMeta((s) => !s)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-gray-400 hover:text-gray-600"
            >
              <span className="uppercase tracking-wide">Step settings</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMeta ? '' : '-rotate-90'}`} />
            </button>
            {showMeta && (
              <div className="grid grid-cols-2 gap-3 px-4 pb-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-500">Display name</p>
                  <input
                    className="input"
                    placeholder={data.namespace}
                    value={data.label ?? ''}
                    onChange={(e) => handleLabelChange(e.target.value)}
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-gray-500">Step ID</p>
                  <input
                    className="input font-mono"
                    value={data.namespace}
                    onChange={(e) => handleNamespaceChange(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
          {/* Editor — fills remaining height */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <CodeConfig config={data.config} onChange={updateConfig} />
          </div>
          {/* Advanced */}
          <div className="border-t border-gray-100 px-4 py-3">
            <button
              onClick={() => setShowAdvanced((s: boolean) => !s)}
              className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? '' : '-rotate-90'}`} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <Field label="Timeout" hint="How long to wait before giving up on this step. Default 30s.">
                  <div className="flex items-center gap-2">
                    <input type="number" className="input" placeholder="30000"
                      value={(data.config.timeout_ms as number | undefined) ?? ''}
                      onChange={(e) => updateConfig({ timeout_ms: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <span className="text-xs text-gray-400 whitespace-nowrap">ms</span>
                  </div>
                </Field>
                <Field label="Retries" hint="How many times to retry on temporary failures. Max 5.">
                  <input type="number" className="input" placeholder="0" min={0} max={5}
                    value={(data.config.retries as number | undefined) ?? ''}
                    onChange={(e) => updateConfig({ retries: e.target.value ? parseInt(e.target.value) : undefined })}
                  />
                </Field>
                <Field label="If this step fails">
                  <select className="input"
                    value={(data.config.on_error as string | undefined) ?? 'fail'}
                    onChange={(e) => updateConfig({ on_error: e.target.value })}
                  >
                    <option value="fail">Stop the workflow</option>
                    <option value="skip">Skip and continue</option>
                    <option value="fallback">Go to fallback step</option>
                  </select>
                </Field>
                {data.config.on_error === 'fallback' && (
                  <Field label="Fallback node">
                    <select className="input"
                      value={(data.config.fallback_node as string | undefined) ?? ''}
                      onChange={(e) => updateConfig({ fallback_node: e.target.value })}
                    >
                      <option value="">— select —</option>
                      {nodeNamespaces.filter((ns) => ns !== data.namespace).map((ns) => (
                        <option key={ns} value={ns}>{ns}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto text-sm">
      <div className={`p-4 space-y-5 ${readOnly ? 'pointer-events-none' : ''}`}>

        {/* Display name */}
        <Field label="Display name" hint="How this step appears on the canvas. Leave blank to use the step ID.">
          <input
            className="input"
            placeholder={data.namespace}
            value={data.label ?? ''}
            onChange={(e) => handleLabelChange(e.target.value)}
          />
        </Field>

        {/* Namespace */}
        <Field label="Step ID" hint="Unique identifier used to reference this step's output in later steps — e.g. steps.credit_check.score">
          <input
            className="input"
            value={data.namespace}
            onChange={(e) => handleNamespaceChange(e.target.value)}
          />
        </Field>

        {/* Type-specific config */}
        {type === 'filter' && <FilterConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'branch' && <BranchConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'response' && <ResponseConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'exit' && <ExitConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'bid_evaluation' && <BidEvaluationConfig config={data.config} onChange={updateConfig} nodeNamespaces={nodeNamespaces} />}
        {type === 'transform' && <TransformConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'webhook' && <IntegrationConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'partner_bid' && <PartnerBidConfig config={data.config} onChange={updateConfig} />}
        {type === 'constants' && <ConstantsConfig config={data.config} onChange={updateConfig} />}
        {type === 'salesforce' && <SalesforceConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'parallel' && <ParallelConfig config={data.config} onChange={updateConfig} currentNodeId={node.id} nodeOptions={nodeOptions} edges={edges} onEdgesChange={onEdgesChange} />}
        {type === 'parallel_end' && <ParallelEndConfig config={data.config} onChange={updateConfig} />}

        {/* Common: retry + error handling */}
        <div>
          <button
            onClick={() => setShowAdvanced((s: boolean) => !s)}
            className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? '' : '-rotate-90'}`} />
            Advanced
          </button>
          {showAdvanced && <div className="mt-3 space-y-3">
            <Field label="Timeout" hint="How long to wait before giving up on this step. Default 30s.">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input"
                  placeholder="30000"
                  value={(data.config.timeout_ms as number | undefined) ?? ''}
                  onChange={(e) => updateConfig({ timeout_ms: e.target.value ? parseInt(e.target.value) : undefined })}
                />
                <span className="text-xs text-gray-400 whitespace-nowrap">ms</span>
              </div>
            </Field>
            <Field label="Retries" hint="How many times to retry on temporary failures (network errors, 429, 502–504). Max 5.">
              <input
                type="number"
                className="input"
                placeholder="0"
                min={0}
                max={5}
                value={(data.config.retries as number | undefined) ?? ''}
                onChange={(e) => updateConfig({ retries: e.target.value ? parseInt(e.target.value) : undefined })}
              />
            </Field>
            <Field label="If this step fails">
              <select
                className="input"
                value={(data.config.on_error as string | undefined) ?? 'fail'}
                onChange={(e) => updateConfig({ on_error: e.target.value })}
              >
                <option value="fail">Stop the workflow</option>
                <option value="skip">Skip and continue</option>
                <option value="fallback">Go to fallback step</option>
              </select>
            </Field>
            {data.config.on_error === 'fallback' && (
              <Field label="Fallback node">
                <select
                  className="input"
                  value={(data.config.fallback_node as string | undefined) ?? ''}
                  onChange={(e) => updateConfig({ fallback_node: e.target.value })}
                >
                  <option value="">— select —</option>
                  {nodeNamespaces.filter((ns) => ns !== data.namespace).map((ns) => (
                    <option key={ns} value={ns}>{ns}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>}
        </div>
      </div>
      </div>
      )}

      {exec && <StepResults exec={exec} namespace={data.namespace ?? ''} canRerun={canRerun} onRerun={onRerun ? async () => onRerun(data.namespace) : undefined} />}
    </aside>
  )
}

// ── JSON tree with copyable paths/values ──────────────────────────────────────

function JsonNode({ label, value, path, depth }: {
  label: string
  value: unknown
  path: string
  depth: number
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const [copiedKey, setCopiedKey] = useState<'path' | 'value' | null>(null)

  function copyTo(text: string, key: 'path' | 'value') {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1400)
  }

  const isObj = value !== null && value !== undefined && typeof value === 'object'
  const childEntries: [string, unknown, string][] = isObj
    ? Array.isArray(value)
      ? (value as unknown[]).map((v, i) => [`[${i}]`, v, `${path}[${i}]`])
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v, `${path}.${k}`])
    : []

  const copyableValue = isObj
    ? JSON.stringify(value)
    : value === null || value === undefined
    ? String(value)
    : typeof value === 'string'
    ? value
    : String(value)

  const displayValue = isObj ? null
    : value === null || value === undefined
    ? <span className="text-gray-400 italic">null</span>
    : typeof value === 'boolean'
    ? <span className="text-amber-600">{String(value)}</span>
    : typeof value === 'number'
    ? <span className="text-blue-600">{value}</span>
    : <span className="text-green-700 break-all">{'"'}{String(value)}{'"'}</span>

  return (
    <div>
      <div
        className="group flex min-h-[22px] items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-blue-50 cursor-default"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {isObj ? (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}

        <span className="shrink-0 font-mono text-xs text-gray-700">{label}</span>
        <span className="shrink-0 font-mono text-xs text-gray-400">:</span>

        {isObj && !expanded && (
          <span className="font-mono text-xs text-gray-400 ml-0.5">
            {Array.isArray(value) ? `[${childEntries.length}]` : `{${childEntries.length}}`}
          </span>
        )}
        {!isObj && <span className="font-mono text-xs ml-0.5 min-w-0">{displayValue}</span>}

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {copiedKey === 'path' ? (
            <span className="px-1 text-[10px] text-green-600">copied</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); copyTo(path, 'path') }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              title={`Copy path: ${path}`}
            >
              <Link2 className="h-3 w-3" />
            </button>
          )}
          {copiedKey === 'value' ? (
            <span className="px-1 text-[10px] text-green-600">copied</span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); copyTo(copyableValue, 'value') }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              title="Copy value"
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isObj && expanded && childEntries.map(([lbl, val, childPath]) => (
        <JsonNode key={lbl} label={lbl} value={val} path={childPath} depth={depth + 1} />
      ))}
    </div>
  )
}

function JsonTreeView({ data, basePath }: { data: unknown; basePath: string }) {
  if (data === null || data === undefined || typeof data !== 'object') {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 p-1">
        <JsonNode label="value" value={data} path={basePath} depth={0} />
      </div>
    )
  }
  const entries: [string, unknown, string][] = Array.isArray(data)
    ? (data as unknown[]).map((v, i) => [`[${i}]`, v, `${basePath}[${i}]`])
    : Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, v, `${basePath}.${k}`])
  return (
    <div className="max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-1">
      {entries.map(([lbl, val, path]) => (
        <JsonNode key={lbl} label={lbl} value={val} path={path} depth={0} />
      ))}
    </div>
  )
}

// ── Step results section (shown below config after a test run) ─────────────────

function StepResults({ exec, namespace, canRerun, onRerun }: { exec: ExecutionStep; namespace: string; canRerun?: boolean; onRerun?: () => Promise<void> }) {
  const [open, setOpen] = useState(true)
  const [showInput, setShowInput] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  async function handleRerun() {
    if (!onRerun) return
    setRerunning(true)
    try { await onRerun() } finally { setRerunning(false) }
  }
  const hasOutput = exec.output !== null && exec.output !== undefined
  const hasInput = exec.input !== null && exec.input !== undefined

  const statusLabel = exec.status === 'completed' ? 'Success'
    : exec.status === 'failed' ? 'Failed'
    : exec.status === 'failed_with_fallback' ? 'Failed (fallback)'
    : exec.status === 'skipped' ? 'Skipped'
    : exec.status

  const statusColor = exec.status === 'completed'
    ? 'bg-green-50 border-green-200 text-green-700'
    : exec.status === 'skipped'
    ? 'bg-gray-50 border-gray-200 text-gray-500'
    : 'bg-red-50 border-red-200 text-red-700'

  return (
    <div className="border-t border-gray-200 flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          onClick={() => setOpen((s) => !s)}
          className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
          Results
        </button>
        {canRerun && onRerun && (
          <button
            onClick={handleRerun}
            disabled={rerunning}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            title="Re-run this step with the same upstream context"
          >
            {rerunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Re-run
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 px-4 pb-4">
          <div className={`rounded-md border px-3 py-2 text-xs font-medium ${statusColor}`}>
            {statusLabel}{exec.duration_ms > 0 ? ` · ${exec.duration_ms}ms` : ''}
          </div>
          {exec.error_message && (
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded border border-red-100 bg-red-50 p-2 text-xs text-red-700">{exec.error_message}</pre>
          )}
          {hasOutput && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-gray-500">Output</p>
              <JsonTreeView data={exec.output} basePath={`steps.${namespace}.output`} />
            </div>
          )}
          {hasInput && (
            <div>
              <button
                onClick={() => setShowInput((s) => !s)}
                className="mb-1.5 flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-600"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showInput ? '' : '-rotate-90'}`} />
                Input
              </button>
              {showInput && (
                <JsonTreeView data={exec.input} basePath={`steps.${namespace}.input`} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Type-specific sections ────────────────────────────────────────────────────

const FILTER_OPERATORS: { value: EdgeCondition['operator']; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater than or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less than or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'exists', label: 'exists' },
  { value: 'not_exists', label: 'does not exist' },
]

const VALUE_LESS = new Set<EdgeCondition['operator']>(['exists', 'not_exists'])

function FilterConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const operation = (config.operation as 'continue_if' | 'end_if' | undefined) ?? 'continue_if'
  const condition = (config.condition as { field?: string; operator?: EdgeCondition['operator']; value?: unknown } | undefined) ?? {}
  const field = condition.field ?? ''
  const operator = condition.operator ?? 'eq'
  const value = condition.value as string | undefined ?? ''

  function setCondition(patch: Partial<{ field: string; operator: EdgeCondition['operator']; value: unknown }>) {
    onChange({ condition: { ...condition, ...patch } })
  }

  return (
    <div className="space-y-5">
      {/* Operation */}
      <section>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Operation</p>
        <div className="relative">
          <select
            value={operation}
            onChange={(e) => onChange({ operation: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="continue_if">Continue if condition is met</option>
            <option value="end_if">End if condition is met</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
        <p className="mt-1 text-xs text-gray-400">
          {operation === 'continue_if'
            ? 'Workflow continues on the pass path when the condition is true.'
            : 'Workflow exits on the exit path when the condition is true.'}
        </p>
      </section>

      {/* Condition */}
      <section>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Condition</p>
        <div className="space-y-2">
          {/* Field */}
          <FieldAutocomplete
            value={field}
            onChange={(v) => setCondition({ field: v })}
            suggestions={refs}
            placeholder="e.g. trigger.payload.status or steps.validate.score"
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
          />
          {/* Operator */}
          <div className="relative">
            <select
              value={operator}
              onChange={(e) => setCondition({ operator: e.target.value as EdgeCondition['operator'] })}
              className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            >
              {FILTER_OPERATORS.map((op) => (
                <option key={op.value} value={op.value}>{op.label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
          </div>
          {/* Value */}
          {!VALUE_LESS.has(operator) && (
            <input
              type="text"
              value={value}
              onChange={(e) => setCondition({ value: e.target.value })}
              placeholder="Value…"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            />
          )}
        </div>
      </section>
    </div>
  )
}

function BranchConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const branches = (config.branches as Array<{ label: string; condition: { groups: ConditionGroup[]; logic: 'AND' | 'OR' } }> | undefined) ?? []
  const useElse = (config.use_else as boolean | undefined) ?? true

  function addBranch() {
    onChange({
      branches: [
        ...branches,
        { label: `branch_${branches.length + 1}`, condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } },
      ],
    })
  }

  function removeBranch(i: number) {
    onChange({ branches: branches.filter((_, idx) => idx !== i) })
  }

  function updateBranch(
    i: number,
    patch: Partial<{ label: string; condition: { groups: ConditionGroup[]; logic: 'AND' | 'OR' } }>
  ) {
    onChange({ branches: branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) })
  }

  return (
    <section className="space-y-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Branches</p>
      {branches.map((branch, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-3">
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="branch label"
              value={branch.label}
              onChange={(e) => updateBranch(i, { label: e.target.value })}
            />
            <button onClick={() => removeBranch(i)} className="text-gray-300 hover:text-red-400">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <RuleBuilder
            groups={branch.condition.groups}
            logic={branch.condition.logic}
            onChange={(groups, logic) => updateBranch(i, { condition: { groups, logic } })}
            fieldSuggestions={refs}
          />
        </div>
      ))}
      <button
        onClick={addBranch}
        className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
      >
        <Plus className="h-3.5 w-3.5" />
        Add branch
      </button>
      <div className="flex items-center justify-between pt-1">
        <div>
          <p className="text-xs font-medium text-gray-700">Else output</p>
          <p className="text-xs text-gray-400">Fires when no branch matches</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ use_else: !useElse })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            useElse ? 'bg-p-blue-dark' : 'bg-gray-200'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              useElse ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    </section>
  )
}

const DEFAULT_SCRIPT = `// Available: payload, steps, env
// Return a JSON-serialisable value.

return {

}`

function CodeConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const script = (config.script as string | undefined) ?? DEFAULT_SCRIPT

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">
        <MonacoEditor
          height="100%"
          language="javascript"
          value={script}
          onChange={(val) => onChange({ script: val ?? '' })}
          onMount={(_editor, monaco) => {
            monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
              noSemanticValidation: true,
              noSyntaxValidation: false,
            })
            monaco.languages.typescript.javascriptDefaults.addExtraLib(
              `declare const payload: Record<string, unknown>;
               declare const steps: Record<string, { output: unknown; status: string }>;
               declare const env: Record<string, string>;`,
              'bidspoke-code-node-globals.d.ts'
            )
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 11,
            lineHeight: 18,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            folding: false,
            overviewRulerLanes: 0,
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
            padding: { top: 10, bottom: 10 },
          }}
          theme="vs"
        />
      </div>
      <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
        Async function body — <code className="rounded bg-gray-100 px-1">payload</code>, <code className="rounded bg-gray-100 px-1">steps</code>, <code className="rounded bg-gray-100 px-1">env</code> available. Must <code className="rounded bg-gray-100 px-1">return</code> a value.
      </p>
    </div>
  )
}

function ResponseConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const bodyStr =
    config.body !== undefined
      ? typeof config.body === 'string'
        ? config.body
        : JSON.stringify(config.body, null, 2)
      : ''

  return (
    <section className="space-y-3">
      <Field label="Status code">
        <input
          type="number"
          className="input"
          placeholder="200"
          value={(config.status_code as number | undefined) ?? 200}
          onChange={(e) => onChange({ status_code: parseInt(e.target.value) || 200 })}
        />
      </Field>
      <Field label="Body (JSON or template)">
        <TemplateTextarea
          className="input min-h-[100px] resize-y font-mono text-xs"
          placeholder={'{\n  "message": "{{steps.step1.value}}"\n}'}
          value={bodyStr}
          onChange={(val) => {
            try {
              onChange({ body: JSON.parse(val) })
            } catch {
              onChange({ body: val })
            }
          }}
          refs={refs}
        />
      </Field>
    </section>
  )
}

function ExitConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const responseStr =
    config.response !== undefined
      ? typeof config.response === 'string'
        ? config.response
        : JSON.stringify(config.response, null, 2)
      : ''

  return (
    <Field label="Response body (optional)">
      <TemplateTextarea
        className="input min-h-[80px] resize-y font-mono text-xs"
        placeholder="Optional response body"
        value={responseStr}
        onChange={(val) => {
          try {
            onChange({ response: JSON.parse(val) })
          } catch {
            onChange({ response: val })
          }
        }}
        refs={refs}
      />
    </Field>
  )
}

function BidEvaluationConfig({
  config,
  onChange,
  nodeNamespaces,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  nodeNamespaces: string[]
}) {
  const strategy = (config.strategy as string | undefined) ?? 'highest_bid'
  const noWinnerBehavior = (config.no_winner_behavior as string | undefined) ?? 'exit'
  const tiebreaker = (config.tiebreaker as string | undefined) ?? 'partner_priority'

  return (
    <section className="space-y-4">
      {/* Parallel source */}
      <Field label="Bids from" hint="The Parallel step that ran all partner bids simultaneously. This node picks the winner from its results.">
        <div className="relative">
          <select
            value={(config.parallel_source as string | undefined) ?? ''}
            onChange={(e) => onChange({ parallel_source: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="">— select a step —</option>
            {nodeNamespaces.map((ns) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      {/* Strategy */}
      <Field label="Selection strategy">
        <div className="relative">
          <select
            value={strategy}
            onChange={(e) => onChange({ strategy: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="highest_bid">Highest bid</option>
            <option value="weighted_score">Weighted score</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      {/* Weighted score sliders */}
      {strategy === 'weighted_score' && (
        <div className="space-y-3 rounded-lg border border-gray-100 bg-beige p-3">
          <p className="text-xs text-gray-500">Rank partners by a combined score. Slide each weight to control how much it matters — higher = more important.</p>
          <WeightSlider
            label="Bid amount"
            value={(config.weight_bid as number | undefined) ?? 1.0}
            onChange={(v) => onChange({ weight_bid: v })}
          />
          <WeightSlider
            label="Acceptance rate"
            value={(config.weight_acceptance as number | undefined) ?? 0.5}
            onChange={(v) => onChange({ weight_acceptance: v })}
          />
          <WeightSlider
            label="Speed (lower ms = better)"
            value={(config.weight_speed as number | undefined) ?? 0.1}
            onChange={(v) => onChange({ weight_speed: v })}
          />
        </div>
      )}

      {/* Min bid threshold */}
      <Field label="Minimum bid threshold ($)">
        <input
          type="number"
          className="input"
          placeholder="No minimum"
          min={0}
          step={0.01}
          value={(config.min_bid_threshold as number | undefined) ?? ''}
          onChange={(e) => onChange({ min_bid_threshold: e.target.value ? parseFloat(e.target.value) : null })}
        />
        <p className="mt-1 text-xs text-gray-400">Bids below this amount are excluded before evaluation.</p>
      </Field>

      {/* Tiebreaker */}
      <Field label="Tiebreaker">
        <div className="relative">
          <select
            value={tiebreaker}
            onChange={(e) => onChange({ tiebreaker: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="partner_priority">Partner priority order</option>
            <option value="fastest_response">Fastest response</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      {/* Fallback partner */}
      <Field label="Fallback partner" hint="If no bids qualify, route to this partner as a last resort (e.g. a catch-all buyer like Engine). Uses the partner's slug.">
        <input
          className="input"
          placeholder="e.g. engine"
          value={(config.fallback_partner as string | undefined) ?? ''}
          onChange={(e) => onChange({ fallback_partner: e.target.value || null })}
        />
      </Field>

      {/* No-winner behavior */}
      <Field label="If no winner is found" hint="What to do when all bids are rejected, below minimum, or errored — and no fallback partner is set.">
        <div className="relative">
          <select
            value={noWinnerBehavior}
            onChange={(e) => onChange({ no_winner_behavior: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="exit">Exit gracefully (no_winner output)</option>
            <option value="fail">Fail the execution</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>
    </section>
  )
}

function TransformConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const mappings = (config.mappings as Array<{ source: string; target: string }> | undefined) ?? []

  function addRow() {
    onChange({ mappings: [...mappings, { source: '', target: '' }] })
  }

  function removeRow(i: number) {
    onChange({ mappings: mappings.filter((_, idx) => idx !== i) })
  }

  function updateRow(i: number, patch: Partial<{ source: string; target: string }>) {
    onChange({ mappings: mappings.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) })
  }

  return (
    <section className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Field mappings</p>
      <p className="text-xs text-gray-400">
        Map values from earlier steps into a new shape. Only the fields you define here appear in this step&apos;s output.
        Source can be a step reference (<code className="rounded bg-gray-100 px-1 font-mono">steps.validate.amount</code>),
        a literal string (<code className="rounded bg-gray-100 px-1 font-mono">&quot;pending&quot;</code>),
        or a calculation (<code className="rounded bg-gray-100 px-1 font-mono">steps.credit.score * 0.85</code>).
      </p>

      <div className="space-y-2">
        {mappings.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <FieldAutocomplete
              value={row.source}
              onChange={(v) => updateRow(i, { source: v })}
              suggestions={refs}
              placeholder="steps.validate.amount"
              className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-gray-400 focus:outline-none font-mono"
            />
            <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" />
            <input
              className="min-w-0 w-24 rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-gray-400 focus:outline-none font-mono"
              placeholder="output_field"
              value={row.target}
              onChange={(e) => updateRow(i, { target: e.target.value })}
            />
            <button
              onClick={() => removeRow(i)}
              className="flex-shrink-0 text-gray-300 hover:text-red-400"
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={addRow}
        className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
      >
        <Plus className="h-3.5 w-3.5" />
        Add field
      </button>
    </section>
  )
}

// ── Webhook node config ───────────────────────────────────────────────────────

const BUILTIN_SERVICE_OPTIONS = [
  { value: 'custom', label: 'Custom' },
  { value: 'equifax', label: 'Equifax' },
  { value: 'salesforce', label: 'Salesforce' },
]

const AUTH_PRESETS: Record<string, { authType: string }> = {
  equifax: { authType: 'basic' },
  salesforce: { authType: 'bearer' },
  custom: { authType: 'none' },
}

function IntegrationConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const service = (config.service as string | undefined) ?? 'custom'
  const method = (config.method as string | undefined) ?? 'POST'
  const auth = (config.auth as Record<string, unknown> | undefined) ?? {}
  const authType = (auth.type as string | undefined) ?? 'none'
  const headersMap = (config.headers as Record<string, string> | undefined) ?? {}
  const headerRows = Object.entries(headersMap)

  const [userPresets, setUserPresets] = useState<ServicePreset[]>([])
  const [connections, setConnections] = useState<ServiceConnection[]>([])
  const [selectedObject, setSelectedObject] = useState<string>('')
  const [syncingSchema, setSyncingSchema] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  useEffect(() => {
    api.servicePresets.list().then(setUserPresets).catch(() => {})
    api.connections.list().then(setConnections).catch(() => {})
  }, [])

  const SCHEMA_SERVICES = new Set(['salesforce', 'supabase', 'snowflake'])
  const activeConnection = SCHEMA_SERVICES.has(service)
    ? connections.find((c) => c.service_type === service) ?? null
    : null
  const schemaObjects: SchemaObject[] = activeConnection?.schema_cache?.objects ?? []
  const currentObject = schemaObjects.find((o) => o.name === selectedObject) ?? null

  async function handleSyncSchema() {
    if (!activeConnection) return
    setSyncingSchema(true)
    setSchemaError(null)
    try {
      const result = await api.connections.syncSchema(service)
      const updated = await api.connections.list()
      setConnections(updated)
      setSchemaError(null)
      console.info(`[schema] synced ${result.object_count} objects`)
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncingSchema(false)
    }
  }

  const allOptions = [
    ...BUILTIN_SERVICE_OPTIONS,
    ...userPresets.map((p) => ({ value: p.slug, label: p.name })),
  ]

  const bodyStr =
    config.body !== undefined
      ? typeof config.body === 'string'
        ? config.body
        : JSON.stringify(config.body, null, 2)
      : ''

  function setAuth(patch: Record<string, unknown>) {
    onChange({ auth: { ...auth, ...patch } })
  }

  function onServiceChange(svc: string) {
    const userPreset = userPresets.find((p) => p.slug === svc)
    const authType = userPreset ? userPreset.auth_type : (AUTH_PRESETS[svc]?.authType ?? 'none')
    const label = allOptions.find((o) => o.value === svc)?.label ?? svc
    const patch: Record<string, unknown> = { service: svc, service_label: label, auth: { ...auth, type: authType } }
    if (userPreset?.base_url) patch.url = userPreset.base_url
    onChange(patch)
  }

  function setHeaderValue(key: string, value: string) {
    onChange({ headers: { ...headersMap, [key]: value } })
  }

  function setHeaderKey(oldKey: string, newKey: string) {
    const updated: Record<string, string> = {}
    for (const [k, v] of Object.entries(headersMap)) {
      updated[k === oldKey ? newKey : k] = v
    }
    onChange({ headers: updated })
  }

  function addHeader() {
    onChange({ headers: { ...headersMap, '': '' } })
  }

  function removeHeader(key: string) {
    const updated = { ...headersMap }
    delete updated[key]
    onChange({ headers: updated })
  }

  const showBody = method !== 'GET' && method !== 'HEAD'

  return (
    <section className="space-y-4">
      {/* Service */}
      <Field label="Service">
        <div className="relative">
          <select
            value={service}
            onChange={(e) => onServiceChange(e.target.value)}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            {allOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      {/* Schema browser — visible when a schema-aware service is selected */}
      {SCHEMA_SERVICES.has(service) && (
        <section className="rounded-md border border-gray-200 bg-beige p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Schema</span>
            {activeConnection ? (
              <button
                onClick={handleSyncSchema}
                disabled={syncingSchema}
                className="text-xs text-p-blue-dark hover:text-navy disabled:opacity-50"
              >
                {syncingSchema ? 'Syncing…' : activeConnection.schema_synced_at ? 'Re-sync' : 'Sync schema'}
              </button>
            ) : (
              <span className="text-xs text-amber-500">No connection configured</span>
            )}
          </div>

          {schemaError && (
            <p className="text-xs text-red-500">{schemaError}</p>
          )}

          {schemaObjects.length > 0 && (
            <>
              {/* Object selector */}
              <div className="relative">
                <select
                  value={selectedObject}
                  onChange={(e) => setSelectedObject(e.target.value)}
                  className="w-full appearance-none rounded-md border border-gray-200 bg-white py-1.5 pl-3 pr-8 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
                >
                  <option value="">Select an object…</option>
                  {schemaObjects.map((o) => (
                    <option key={o.name} value={o.name}>{o.label}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-gray-400" />
              </div>

              {/* Field list */}
              {currentObject && (
                <div className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-white">
                  {currentObject.fields.map((f) => (
                    <button
                      key={f.name}
                      title={`Type: ${f.type}${f.nullable ? '' : ' (required)'}`}
                      onClick={() => navigator.clipboard?.writeText(f.name).catch(() => {})}
                      className="flex w-full items-center justify-between px-2.5 py-1 text-left text-xs hover:bg-p-blue-light"
                    >
                      <span className="font-mono text-gray-800">{f.name}</span>
                      <span className="text-gray-400">{f.type}</span>
                    </button>
                  ))}
                </div>
              )}

              {activeConnection?.schema_synced_at && (
                <p className="text-xs text-gray-400">
                  Last synced {new Date(activeConnection.schema_synced_at).toLocaleDateString()}
                </p>
              )}
            </>
          )}

          {activeConnection && schemaObjects.length === 0 && !syncingSchema && (
            <p className="text-xs text-gray-400">Click &quot;Sync schema&quot; to load available fields.</p>
          )}
        </section>
      )}

      {/* Custom service name */}
      {service === 'custom' && (
        <Field label="Service name">
          <input
            className="input w-full"
            placeholder="My CRM"
            value={(config.service_label as string | undefined) ?? ''}
            onChange={(e) => onChange({ service_label: e.target.value })}
          />
        </Field>
      )}

      {/* Method + URL */}
      <div className="flex gap-2 items-end">
        <div className="w-24 flex-shrink-0">
          <Field label="Method">
            <div className="relative">
              <select
                value={method}
                onChange={(e) => onChange({ method: e.target.value })}
                className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none font-mono"
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-gray-400" />
            </div>
          </Field>
        </div>
        <div className="flex-1 min-w-0">
          <Field label="URL">
            <FieldAutocomplete
              value={(config.url as string | undefined) ?? ''}
              onChange={(v) => onChange({ url: v })}
              suggestions={refs}
              placeholder="https://api.example.com/endpoint"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-mono focus:border-gray-400 focus:outline-none"
            />
          </Field>
        </div>
      </div>

      {/* Auth */}
      <section>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">Auth</p>
        <div className="space-y-2">
          <div className="relative">
            <select
              value={authType}
              onChange={(e) => setAuth({ type: e.target.value })}
              className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic (username + password)</option>
              <option value="api_key">API key header</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
          </div>
          {authType === 'bearer' && (
            <Field label="Token — use {{env.SECRET_NAME}}">
              <FieldAutocomplete
                value={(auth.token as string | undefined) ?? ''}
                onChange={(v) => setAuth({ token: v })}
                suggestions={refs}
                placeholder="{{env.API_TOKEN}}"
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-mono focus:border-gray-400 focus:outline-none"
              />
            </Field>
          )}
          {authType === 'basic' && (
            <>
              <Field label="Username">
                <FieldAutocomplete
                  value={(auth.username as string | undefined) ?? ''}
                  onChange={(v) => setAuth({ username: v })}
                  suggestions={refs}
                  placeholder="{{env.SERVICE_USER}}"
                  className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-mono focus:border-gray-400 focus:outline-none"
                />
              </Field>
              <Field label="Password — use {{env.SECRET_NAME}}">
                <FieldAutocomplete
                  value={(auth.password as string | undefined) ?? ''}
                  onChange={(v) => setAuth({ password: v })}
                  suggestions={refs}
                  placeholder="{{env.SERVICE_PASS}}"
                  className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-mono focus:border-gray-400 focus:outline-none"
                />
              </Field>
            </>
          )}
          {authType === 'api_key' && (
            <>
              <Field label="Header name">
                <input
                  className="input font-mono"
                  placeholder="X-API-Key"
                  value={(auth.header as string | undefined) ?? ''}
                  onChange={(e) => setAuth({ header: e.target.value })}
                />
              </Field>
              <Field label="Value — use {{env.SECRET_NAME}}">
                <FieldAutocomplete
                  value={(auth.key as string | undefined) ?? ''}
                  onChange={(v) => setAuth({ key: v })}
                  suggestions={refs}
                  placeholder="{{env.SERVICE_API_KEY}}"
                  className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-mono focus:border-gray-400 focus:outline-none"
                />
              </Field>
            </>
          )}
        </div>
      </section>

      {/* Body */}
      {showBody && (
        <Field label="Body (JSON or template)">
          <TemplateTextarea
            className="input min-h-[100px] resize-y font-mono text-xs"
            placeholder={'{\n  "ssn": "{{trigger.payload.ssn}}"\n}'}
            value={bodyStr}
            onChange={(val) => {
              try {
                onChange({ body: JSON.parse(val) })
              } catch {
                onChange({ body: val })
              }
            }}
            refs={refs}
          />
        </Field>
      )}

      {/* Headers */}
      <section>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
          Custom headers
        </p>
        <div className="space-y-1.5">
          {headerRows.map(([key, value]) => (
            <div key={key} className="flex items-center gap-1.5">
              <input
                className="min-w-0 w-28 flex-shrink-0 rounded-md border border-gray-200 px-2 py-1.5 text-xs font-mono focus:border-gray-400 focus:outline-none"
                placeholder="Header-Name"
                value={key}
                onChange={(e) => setHeaderKey(key, e.target.value)}
              />
              <span className="text-gray-300 text-xs">:</span>
              <FieldAutocomplete
                value={value}
                onChange={(v) => setHeaderValue(key, v)}
                suggestions={refs}
                placeholder="value or {{env.KEY}}"
                className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs font-mono focus:border-gray-400 focus:outline-none"
              />
              <button
                onClick={() => removeHeader(key)}
                className="flex-shrink-0 text-gray-300 hover:text-red-400"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addHeader}
          className="mt-1.5 flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
        >
          <Plus className="h-3.5 w-3.5" />
          Add header
        </button>
      </section>
    </section>
  )
}

function WeightSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs text-gray-500">{label}</label>
        <span className="font-mono text-xs text-gray-600">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-yellow-500"
      />
    </div>
  )
}

// ── Partner Bid ───────────────────────────────────────────────────────────────

function PartnerBidConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const [partners, setPartners] = useState<Partner[]>([])

  useEffect(() => {
    api.partners.list().then(setPartners).catch(() => {})
  }, [])

  const selectedId = (config.partner_id as string | undefined) ?? ''

  function handleSelect(id: string) {
    const partner = partners.find((p) => p.id === id)
    onChange({ partner_id: id, partner_name: partner?.name ?? '' })
  }

  return (
    <section className="space-y-4">
      <Field label="Partner" hint="Which partner to request a bid from.">
        <div className="relative">
          <select
            value={selectedId}
            onChange={(e) => handleSelect(e.target.value)}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="">— select a partner —</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{!p.is_active ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>
    </section>
  )
}

// ── Salesforce ────────────────────────────────────────────────────────────────

const SF_OPERATIONS = [
  { value: 'create', label: 'Create record' },
  { value: 'update', label: 'Update record' },
  { value: 'upsert', label: 'Upsert record' },
  { value: 'query',  label: 'Query (SOQL)' },
  { value: 'apex',   label: 'Apex REST' },
]

function SalesforceConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const operation = (config.operation as string | undefined) ?? 'create'
  const object    = (config.object as string | undefined) ?? ''
  const body      = config.body
  const recordId  = (config.record_id as string | undefined) ?? ''
  const extField  = (config.external_id_field as string | undefined) ?? ''
  const extValue  = (config.external_id_value as string | undefined) ?? ''
  const soql      = (config.soql as string | undefined) ?? ''
  const apexPath  = (config.apex_path as string | undefined) ?? ''

  const [bodyText, setBodyText] = useState(() =>
    body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) : ''
  )

  function saveBody(raw: string) {
    setBodyText(raw)
    try {
      onChange({ body: JSON.parse(raw) })
    } catch {
      onChange({ body: raw })
    }
  }

  const showBody   = operation !== 'query'
  const showId     = operation === 'update'
  const showUpsert = operation === 'upsert'
  const showSoql   = operation === 'query'
  const showApex   = operation === 'apex'

  return (
    <section className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Operation</label>
        <select
          className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
          value={operation}
          onChange={(e) => onChange({ operation: e.target.value })}
        >
          {SF_OPERATIONS.map((op) => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
      </div>

      {!showSoql && !showApex && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Object (SObject API name)</label>
          <input
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
            value={object}
            onChange={(e) => onChange({ object: e.target.value })}
            placeholder="e.g. Prospect__c"
          />
        </div>
      )}

      {showApex && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Apex path</label>
          <input
            className="w-full rounded border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-blue-400 focus:outline-none"
            value={apexPath}
            onChange={(e) => onChange({ apex_path: e.target.value })}
            placeholder="/services/apexrest/my-endpoint"
          />
        </div>
      )}

      {showId && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Record ID</label>
          <TemplateTextarea
            value={recordId}
            onChange={(v) => onChange({ record_id: v })}
            refs={refs}
            placeholder="{{steps.create_prospect.output.body.id}}"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
          />
        </div>
      )}

      {showUpsert && (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">External ID field</label>
            <input
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
              value={extField}
              onChange={(e) => onChange({ external_id_field: e.target.value })}
              placeholder="e.g. Lead_UUID__c"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">External ID value</label>
            <TemplateTextarea
              value={extValue}
              onChange={(v) => onChange({ external_id_value: v })}
              refs={refs}
              placeholder="{{trigger.payload.leadUuid}}"
              className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
            />
          </div>
        </>
      )}

      {showSoql && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">SOQL query</label>
          <TemplateTextarea
            value={soql}
            onChange={(v) => onChange({ soql: v })}
            refs={refs}
            placeholder="SELECT Id FROM Prospect__c WHERE Lead_UUID__c = '{{trigger.payload.leadUuid}}'"
          />
        </div>
      )}

      {showBody && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Body (JSON)</label>
          <div className="overflow-hidden rounded border border-gray-200" style={{ height: 240 }}>
            <MonacoEditor
              height={240}
              language="json"
              value={bodyText}
              onChange={(val) => saveBody(val ?? '')}
              onMount={(_editor, monaco) => {
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false })
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 11,
                lineHeight: 18,
                lineNumbers: 'on',
                lineNumbersMinChars: 2,
                lineDecorationsWidth: 0,
                glyphMargin: false,
                scrollBeyondLastLine: false,
                wordWrap: 'off',
                tabSize: 2,
                folding: false,
                overviewRulerLanes: 0,
                scrollbar: { vertical: 'auto', horizontal: 'auto' },
                padding: { top: 8, bottom: 8 },
              }}
              theme="vs"
            />
          </div>
          <p className="mt-1 text-xs text-gray-400">Use <code className="rounded bg-gray-100 px-1">{`{{steps.x.output.field}}`}</code> to reference prior step output.</p>
        </div>
      )}
    </section>
  )
}

// ── Parallel ──────────────────────────────────────────────────────────────────

function ParallelConfig({
  config,
  onChange,
  currentNodeId,
  nodeOptions,
  edges,
  onEdgesChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  currentNodeId: string
  nodeOptions: { id: string; namespace: string; label?: string }[]
  edges: { id: string; source: string; target: string; sourceHandle?: string | null }[]
  onEdgesChange?: (add: { id: string; source: string; target: string; sourceHandle: string }[], removeIds: string[]) => void
}) {
  const updateNodeInternals = useUpdateNodeInternals()
  // Queue an edge addition after a node-config change. We can't add the edge in the same
  // render as config.children changes because React Flow hasn't re-registered the new
  // child-N handle in nodeInternals yet — the edge would be silently dropped.
  const [pendingEdge, setPendingEdge] = useState<{
    add: { id: string; source: string; target: string; sourceHandle: string }[]
    removeIds: string[]
  } | null>(null)

  useEffect(() => {
    if (!pendingEdge) return
    // Force React Flow to re-scan the parallel node's handles now that the DOM has updated.
    updateNodeInternals(currentNodeId)
    onEdgesChange?.(pendingEdge.add, pendingEdge.removeIds)
    setPendingEdge(null)
  }, [pendingEdge]) // eslint-disable-line react-hooks/exhaustive-deps

  const children = (config.children as string[] | undefined) ?? []

  // BFS ancestors of currentNodeId — nodes that can reach the parallel node going forward.
  // We exclude these (and the node itself) from the picker so only downstream nodes appear.
  // This works even when the parallel node has no outgoing edges yet (fresh drop).
  const ancestors = (() => {
    const visited = new Set<string>()
    const queue = [currentNodeId]
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const e of edges) {
        if (e.target === id && !visited.has(e.source)) {
          visited.add(e.source)
          queue.push(e.source)
        }
      }
    }
    return visited
  })()

  const available = nodeOptions.filter((n) => !ancestors.has(n.id) && n.id !== currentNodeId)

  function toggleChild(id: string) {
    if (children.includes(id)) {
      // Remove: update children array + delete fan-out edge
      const next = children.filter((c) => c !== id)
      onChange({ children: next })
      const removeIds = edges
        .filter((e) => e.source === currentNodeId && e.target === id && (e.sourceHandle ?? '').startsWith('child-'))
        .map((e) => e.id)
      if (removeIds.length > 0) onEdgesChange?.([], removeIds)
    } else {
      // Add: append to children array, then queue the fan-out edge for the next render.
      // The new child-N handle doesn't exist in React Flow's nodeInternals until after
      // the config change commits to the DOM, so we defer the edge creation via useEffect.
      const next = [...children, id]
      const childIndex = next.length - 1
      onChange({ children: next })
      const newEdge = {
        id: `${currentNodeId}-child-${childIndex}-${id}`,
        source: currentNodeId,
        target: id,
        sourceHandle: `child-${childIndex}`,
      }
      // Remove any existing non-child-* edge from parallel to this node (avoids double connections)
      const removeIds = edges
        .filter((e) => e.source === currentNodeId && e.target === id && !(e.sourceHandle ?? '').startsWith('child-'))
        .map((e) => e.id)
      setPendingEdge({ add: [newEdge], removeIds })
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <label className="mb-2 block text-xs font-medium text-gray-600">Branches</label>
        <p className="mb-2 text-xs text-gray-400">Select which steps run in parallel inside this node.</p>
        {available.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No downstream steps available yet.</p>
        ) : (
          <div className="space-y-1.5 rounded-md border border-gray-200 p-2">
            {available.map((opt) => (
              <label key={opt.id} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={children.includes(opt.id)}
                  onChange={() => toggleChild(opt.id)}
                  className="h-3.5 w-3.5 rounded border-gray-300 accent-slate-600"
                />
                <span className="font-mono text-xs text-gray-700">
                  {opt.label ? `${opt.label} (${opt.namespace})` : opt.namespace}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-400">Configure wait behavior on the Parallel (end) node.</p>
    </section>
  )
}

// ── Parallel End ───────────────────────────────────────────────────────────────

function ParallelEndConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const waitFor = (config.wait_for as string | undefined) ?? 'all'
  const timeoutMs = (config.timeout_ms as number | undefined) ?? 15000
  const onTimeout = (config.on_timeout as string | undefined) ?? 'partial'

  return (
    <section className="space-y-4">
      <Field label="Wait for" hint="'All' waits for every branch. 'First' continues as soon as one succeeds.">
        <div className="relative">
          <select
            value={waitFor}
            onChange={(e) => onChange({ wait_for: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="all">All branches</option>
            <option value="first">First to succeed</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      <Field label="Timeout (ms)" hint="How long to wait before moving on. Default 15000ms.">
        <input
          type="number"
          className="input"
          min={1000}
          step={1000}
          value={timeoutMs}
          onChange={(e) => onChange({ timeout_ms: parseInt(e.target.value) || 15000 })}
        />
      </Field>

      {waitFor === 'all' && (
        <Field label="On timeout" hint="What to do if some branches haven't finished when the timeout fires.">
          <div className="relative">
            <select
              value={onTimeout}
              onChange={(e) => onChange({ on_timeout: e.target.value })}
              className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            >
              <option value="partial">Continue with partial results</option>
              <option value="fail">Fail the execution</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
          </div>
        </Field>
      )}
    </section>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

function ConstantsConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const data = (config.data ?? {}) as Record<string, unknown>

  function updateData(updatedData: Record<string, unknown>) {
    onChange({ data: updatedData })
  }

  function setKeyName(oldKey: string, newKey: string) {
    if (oldKey === newKey) return
    const updated: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      updated[k === oldKey ? newKey : k] = v
    }
    updateData(updated)
  }

  function setValue(key: string, raw: string) {
    const isStates = key === 'states' || Array.isArray(data[key])
    const parsed = isStates ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw
    updateData({ ...data, [key]: parsed })
  }

  function removeKey(key: string) {
    const updated = { ...data }
    delete updated[key]
    updateData(updated)
  }

  function addKey() {
    let name = 'key'
    let i = 1
    while (name in data) { name = `key${i++}` }
    updateData({ ...data, [name]: '' })
  }

  const entries = Object.entries(data)

  return (
    <section className="space-y-5">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-gray-600">Workflow constants</p>
          <button
            type="button"
            onClick={addKey}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light"
          >
            <Plus className="h-3 w-3" />
            Add key
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
            No constants defined. Click &ldquo;Add key&rdquo; to start.
          </p>
        ) : (
          <div className="space-y-1.5">
            {entries.map(([key, value]) => {
              const isArray = Array.isArray(value)
              const displayValue = isArray ? (value as string[]).join(', ') : String(value ?? '')
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <input
                    className="w-32 flex-shrink-0 rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                    value={key}
                    onChange={(e) => setKeyName(key, e.target.value)}
                    placeholder="key"
                  />
                  <input
                    className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                    value={displayValue}
                    onChange={(e) => setValue(key, e.target.value)}
                    placeholder={key === 'states' ? 'AL, AZ, CA, ...' : 'value'}
                  />
                  <button
                    type="button"
                    onClick={() => removeKey(key)}
                    className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-2 text-xs text-gray-400">
          For array values (e.g. &ldquo;states&rdquo;), enter comma-separated items.
        </p>
      </div>

      <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3">
        <p className="text-xs font-medium text-indigo-700">Partner data is automatic</p>
        <p className="mt-1 text-xs text-indigo-600">
          Sub-account UUIDs and sell-off offer copy are pulled from partner settings and merged in at runtime.
        </p>
      </div>
    </section>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}
