'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })
import type { Node } from '@xyflow/react'
import type { CanvasNodeData, ConditionGroup, EdgeCondition, NodeType, ExecutionStep } from '@/types/workflow'
import RuleBuilder from '@/components/rule-builder/RuleBuilder'
import FieldAutocomplete from '@/components/rule-builder/FieldAutocomplete'
import TemplateTextarea from './TemplateTextarea'
import { X, Trash2, Plus, CheckCircle, ChevronDown, ChevronUp, ArrowRight, Copy, RotateCcw, Loader2, Play } from 'lucide-react'
import { api } from '@/lib/api'
import type { ServicePreset, ServiceConnection, SchemaObject, Partner } from '@/lib/api'
import RailResizeHandle from './RailResizeHandle'
import JsonTreeView from './JsonTreeView'

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
  // Resume the parent execution from this failed step. Shown as "Retry from
  // here" when the selected step is failed and we're viewing a real execution
  // (not a test run). Resume skips completed upstream steps and re-runs the
  // failed one — so SF prospect creation etc. won't double-fire.
  onRetryFromFailure?: () => Promise<void>
  // Test a single node. "Build from run" seeds upstream context from the last
  // run; "cold start" runs with only the supplied trigger payload.
  onNodeTest?: (namespace: string, opts: { triggerPayload: unknown; useLastRun: boolean }) => Promise<void>
  canBuildFromRun?: boolean
  defaultTestPayload?: unknown
  width?: number
  onResize?: (width: number) => void
  workflowId?: string
}

export default function ConfigPanel({ node, onUpdate = () => {}, onDelete = () => {}, onDuplicate = () => {}, onClose, nodeNamespaces, nodeOptions = [], refs = [], readOnly = false, edges = [], onEdgesChange, canRerun = false, onRerun, onRetryFromFailure, onNodeTest, canBuildFromRun = false, defaultTestPayload, width, onResize, workflowId }: Props) {
  const data = node.data as unknown as CanvasNodeData & { executionStep?: ExecutionStep | null }
  const type = node.type as NodeType
  const exec = data.executionStep
  const isCode = type === 'code'
  const effectiveWidth = width ?? (isCode ? 540 : 320)

  const [showAdvanced, setShowAdvanced] = useState(true)
  const [showMeta, setShowMeta] = useState(true)
  // Notes default to expanded if the node already has one, collapsed otherwise.
  // Re-init when the user clicks a different node so each node gets its own
  // initial state.
  const [showNotes, setShowNotes] = useState<boolean>(!!data.note)
  useEffect(() => { setShowNotes(!!data.note) }, [node.id]) // eslint-disable-line react-hooks/exhaustive-deps
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

      {/* (Top failure banner removed — the Failed pill + duration in the
          RESULTS section plus the structured Output tree cover this already.) */}
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
                    className={`input font-mono ${nodeNamespaces.filter((ns) => ns === data.namespace).length > 1 ? 'border-red-400 ring-1 ring-red-200' : ''}`}
                    value={data.namespace}
                    onChange={(e) => handleNamespaceChange(e.target.value)}
                  />
                  {nodeNamespaces.filter((ns) => ns === data.namespace).length > 1 && (
                    <p className="mt-1 text-xs text-red-500">
                      Already used by another node. Step IDs must be unique.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Notes — its own collapsible so users can hide it without hiding step settings */}
          <div className="border-b border-gray-100">
            <button
              type="button"
              onClick={() => setShowNotes((s) => !s)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-gray-400 hover:text-gray-600"
            >
              <span className="uppercase tracking-wide">Notes</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showNotes ? '' : '-rotate-90'}`} />
            </button>
            {showNotes && (
              <div className="px-4 pb-3">
                <textarea
                  className="input min-h-[60px] resize-y"
                  placeholder="Notes for future you, or anyone else looking at this step..."
                  value={(data.note as string | undefined) ?? ''}
                  onChange={(e) => onUpdate(node.id, { note: e.target.value || undefined })}
                />
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
              className="pointer-events-auto flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? '' : '-rotate-90'}`} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <TimeoutField config={data.config} updateConfig={updateConfig} workflowId={workflowId} namespace={data.namespace} nodeType={type} />
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
                      <option value="">Select...</option>
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
        <Field label="Step ID" hint="Unique identifier used to reference this step's output in later steps. E.g. steps.credit_check.score">
          <input
            className={`input ${nodeNamespaces.filter((ns) => ns === data.namespace).length > 1 ? 'border-red-400 ring-1 ring-red-200' : ''}`}
            value={data.namespace}
            onChange={(e) => handleNamespaceChange(e.target.value)}
          />
          {nodeNamespaces.filter((ns) => ns === data.namespace).length > 1 && (
            <p className="mt-1 text-xs text-red-500">
              Already used by another node. Step IDs must be unique — references like <code className="rounded bg-red-50 px-1">steps.{data.namespace}</code> would resolve ambiguously.
            </p>
          )}
        </Field>

        {/* Notes — free-form per-step annotation, surfaced as a small icon on the canvas */}
        <div>
          <button
            type="button"
            onClick={() => setShowNotes((s) => !s)}
            className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showNotes ? '' : '-rotate-90'}`} />
            Notes
          </button>
          {showNotes && (
            <div className="mt-2">
              <textarea
                className="input min-h-[72px] resize-y"
                placeholder="Notes for future you, or anyone else looking at this step..."
                value={(data.note as string | undefined) ?? ''}
                onChange={(e) => onUpdate(node.id, { note: e.target.value || undefined })}
              />
            </div>
          )}
        </div>

        {/* Type-specific config */}
        {type === 'filter' && <FilterConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'branch' && <BranchConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'response' && <ResponseConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'exit' && <ExitConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'bid_evaluation' && <BidEvaluationConfig config={data.config} onChange={updateConfig} nodeNamespaces={nodeNamespaces} />}
        {type === 'transform' && <TransformConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'webhook' && <IntegrationConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'partner_bid' && <PartnerBidConfig config={data.config} onChange={updateConfig} />}
        {type === 'bid_group' && <BidGroupConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'constants' && <ConstantsConfig config={data.config} onChange={updateConfig} />}
        {type === 'salesforce' && <SalesforceConfig key={node.id} config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'data_store' && <DataStoreConfig key={node.id} config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'latency_gate' && <LatencyGateConfig key={node.id} config={data.config} onChange={updateConfig} />}
        {type === 'parallel' && <ParallelConfig config={data.config} onChange={updateConfig} currentNodeId={node.id} edges={edges} onEdgesChange={onEdgesChange} />}
        {type === 'parallel_end' && <ParallelEndConfig />}
        {type === 'branch_end' && <BranchEndConfig />}

        {/* Common: retry + error handling. Hidden for parallel_end / branch_end —
            those nodes are passive join markers, all retry/error config sits on the start. */}
        {type !== 'parallel_end' && type !== 'branch_end' && <div>
          <button
            onClick={() => setShowAdvanced((s: boolean) => !s)}
            className="pointer-events-auto flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? '' : '-rotate-90'}`} />
            Advanced
          </button>
          {showAdvanced && <div className="mt-3 space-y-3">
            <TimeoutField config={data.config} updateConfig={updateConfig} workflowId={workflowId} namespace={data.namespace} nodeType={type} />
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
                  <option value="">Select...</option>
                  {nodeNamespaces.filter((ns) => ns !== data.namespace).map((ns) => (
                    <option key={ns} value={ns}>{ns}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>}
        </div>}
      </div>
      </div>
      )}

      {onNodeTest && !readOnly && type !== 'branch_end' && type !== 'parallel_end' && (
        <NodeTestSection
          namespace={data.namespace ?? ''}
          defaultPayload={defaultTestPayload}
          canBuildFromRun={canBuildFromRun}
          onTest={onNodeTest}
        />
      )}

      {exec && <StepResults exec={exec} namespace={data.namespace ?? ''} canRerun={canRerun} onRerun={onRerun ? async () => onRerun(data.namespace) : undefined} onRetryFromFailure={onRetryFromFailure} />}
    </aside>
  )
}

// ── Test this node (single-node execution) ────────────────────────────────────
// "Build from run" seeds the context with the last run's upstream step outputs +
// trigger payload (editable). "Run cold" runs with only the trigger payload
// below — for nodes that don't read steps.*. Output renders in StepResults below.
function NodeTestSection({
  namespace,
  defaultPayload,
  canBuildFromRun,
  onTest,
}: {
  namespace: string
  defaultPayload: unknown
  canBuildFromRun: boolean
  onTest: (namespace: string, opts: { triggerPayload: unknown; useLastRun: boolean }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(defaultPayload ?? {}, null, 2))
  const [parseError, setParseError] = useState<string | null>(null)
  const [running, setRunning] = useState<null | 'run' | 'cold'>(null)

  async function run(useLastRun: boolean) {
    let parsed: unknown
    try {
      parsed = payloadText.trim() ? JSON.parse(payloadText) : {}
    } catch {
      setParseError('Invalid JSON')
      return
    }
    setParseError(null)
    setRunning(useLastRun ? 'run' : 'cold')
    try { await onTest(namespace, { triggerPayload: parsed, useLastRun }) } finally { setRunning(null) }
  }

  return (
    <div className="border-t border-gray-100 px-4 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-xs font-semibold text-gray-700"
      >
        <span>Test this node</span>
        {open ? <ChevronUp className="h-3.5 w-3.5 text-gray-400" /> : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <label className="block text-xs font-medium text-gray-500">Trigger payload (JSON)</label>
          <textarea
            value={payloadText}
            onChange={(e) => { setPayloadText(e.target.value); setParseError(null) }}
            spellCheck={false}
            rows={6}
            className="w-full resize-y rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-800 focus:border-purple-300 focus:outline-none focus:ring-1 focus:ring-purple-200"
          />
          {parseError && <p className="text-xs text-red-600">{parseError}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={() => run(true)}
              disabled={!canBuildFromRun || running !== null}
              title={canBuildFromRun ? 'Run this node using the upstream outputs from the last run' : 'Run the workflow once to enable'}
              className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running === 'run' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Build from run
            </button>
            <button
              onClick={() => run(false)}
              disabled={running !== null}
              title="Run this node with only the trigger payload above (no upstream outputs)"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
            >
              {running === 'cold' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run cold
            </button>
          </div>
          {!canBuildFromRun && (
            <p className="text-xs text-gray-400">Run the full workflow once to enable &ldquo;Build from run&rdquo; (uses upstream step outputs).</p>
          )}
        </div>
      )}
    </div>
  )
}

const LOG_LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-300',
  warn: 'text-yellow-300',
  info: 'text-blue-300',
  log: 'text-gray-100',
  debug: 'text-gray-400',
}

// ── Step results section (shown below config after a test run) ─────────────────

function StepResults({ exec, namespace, canRerun, onRerun, onRetryFromFailure }: { exec: ExecutionStep; namespace: string; canRerun?: boolean; onRerun?: () => Promise<void>; onRetryFromFailure?: () => Promise<void> }) {
  const [open, setOpen] = useState(true)
  const [showInput, setShowInput] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [retrying, setRetrying] = useState(false)

  async function handleRerun() {
    if (!onRerun) return
    setRerunning(true)
    try { await onRerun() } finally { setRerunning(false) }
  }

  async function handleRetryFromFailure() {
    if (!onRetryFromFailure) return
    setRetrying(true)
    try { await onRetryFromFailure() } finally { setRetrying(false) }
  }

  const isFailed = exec.status === 'failed' || exec.status === 'failed_with_fallback'
  const showRetryButton = isFailed && !!onRetryFromFailure
  const hasOutput = exec.output !== null && exec.output !== undefined
  const hasInput = exec.input !== null && exec.input !== undefined
  // detail_loaded=false means summary fetch only — input/output are still
  // being fetched. Show a skeleton instead of "no output" so the user knows
  // the step did run, the payload just hasn't arrived yet.
  const detailPending = exec.detail_loaded === false && (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'failed_with_fallback')

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
        {showRetryButton && (
          <button
            onClick={handleRetryFromFailure}
            disabled={retrying}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light disabled:opacity-50"
            title="Resume the execution from this failed step. Completed upstream steps are skipped, so this re-runs only the failed step (and anything downstream)."
          >
            {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Retry from here
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 px-4 pb-4">
          <div className={`rounded-md border px-3 py-2 text-xs font-medium ${statusColor}`}>
            {statusLabel}{exec.duration_ms > 0 ? ` · ${exec.duration_ms}ms` : ''}
          </div>
          {/* Error message — shown only when there's no Output tree to carry it.
              When the step's output IS the error shape (e.g. respond sentinel
              with error body), the Output tree already displays the detail and
              repeating it would be redundant. */}
          {exec.error_message && !hasOutput && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-red-100 bg-red-50 p-2 text-xs text-red-700">{exec.error_message}</pre>
          )}
          {detailPending && !hasOutput && !hasInput && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-500">Output</p>
              <div className="h-20 animate-pulse rounded bg-gray-100" />
            </div>
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
                <StepInputView input={exec.input} namespace={namespace} />
              )}
            </div>
          )}
          {exec.logs && exec.logs.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-gray-500">Logs</p>
              <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-100">
                {exec.logs.map((entry, j) => (
                  <div key={j} className={LOG_LEVEL_CLASS[entry.level] ?? 'text-gray-100'}>
                    <span className="text-gray-500">{entry.ts.slice(11, 23)}</span>{' '}
                    <span className="font-semibold">{entry.level}</span>{' '}
                    {entry.message}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// New-shape inputs are `{ template, resolved }`. Older rows (partner_bid
// `{ partner_id }`, or pre-feature null) render with the legacy single tree.
function isResolvedShape(input: unknown): input is { template: unknown; resolved: unknown } {
  return (
    typeof input === 'object'
    && input !== null
    && 'template' in input
    && 'resolved' in input
  )
}

function StepInputView({ input, namespace }: { input: unknown; namespace: string }) {
  if (!isResolvedShape(input)) {
    return <JsonTreeView data={input} basePath={`steps.${namespace}.input`} />
  }
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Template</p>
        <JsonTreeView data={input.template} basePath={`steps.${namespace}.input.template`} />
      </div>
      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Resolved</p>
        <JsonTreeView data={input.resolved} basePath={`steps.${namespace}.input.resolved`} />
      </div>
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
  const elseBehavior = (config.else_behavior as 'output' | 'none' | 'error' | undefined)
    ?? ((config.use_else as boolean | undefined) === false ? 'none' : 'output')
  const elseLabel = (config.else_label as string | undefined) ?? ''

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
      <div className="pt-1">
        <p className="text-xs font-medium text-gray-700">When no branch matches</p>
        <div className="mt-1.5 flex overflow-hidden rounded-lg border border-gray-200 text-xs">
          {([
            { key: 'output', label: 'Else output', hint: 'Fires an else edge' },
            { key: 'none',   label: 'Do nothing',  hint: 'Workflow ends silently' },
            { key: 'error',  label: 'Throw error', hint: 'Marks the run failed' },
          ] as const).map((opt, i) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange({ else_behavior: opt.key, use_else: opt.key === 'output' })}
              title={opt.hint}
              className={`flex-1 px-2 py-1.5 transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
                elseBehavior === opt.key
                  ? 'bg-p-blue-light text-p-blue-dark font-medium'
                  : 'bg-white text-gray-500 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {elseBehavior === 'output' && (
          <div className="mt-2">
            <input
              className="input w-full text-xs"
              placeholder="else"
              value={elseLabel}
              onChange={(e) => onChange({ else_label: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-400">Display label for the else path. Defaults to &ldquo;else&rdquo;.</p>
          </div>
        )}
      </div>
    </section>
  )
}

const DEFAULT_SCRIPT = `// Available: payload, steps, env
// Return a JSON-serialisable value.

return {

}`

interface CodeProp {
  name: string
  source: string
}

// Static analysis: scan the script for `props.X` dot-references. Used to drive
// the props UI — Pipedream-style, only show prop rows for keys the script
// actually references. Mirrors the engine-side step-reference scan.
function extractPropRefs(script: string): Set<string> {
  const refs = new Set<string>()
  const re = /\bprops\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) refs.add(m[1])
  return refs
}

function CodeConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const script = (config.script as string | undefined) ?? DEFAULT_SCRIPT
  const propsConfig = (config.props as CodeProp[] | undefined) ?? []
  const refs = extractPropRefs(script)

  // Visible rows = referenced names ∪ already-configured names. Sorted by
  // referenced-first so users see the live ones at the top.
  const allNames = new Set<string>([...refs, ...propsConfig.map((p) => p.name)])
  const rows: Array<CodeProp & { referenced: boolean }> = Array.from(allNames).map((name) => {
    const existing = propsConfig.find((p) => p.name === name)
    return { name, source: existing?.source ?? '', referenced: refs.has(name) }
  }).sort((a, b) => {
    if (a.referenced !== b.referenced) return a.referenced ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  function updateSource(name: string, source: string) {
    const next = [...propsConfig.filter((p) => p.name !== name)]
    if (source) next.push({ name, source })
    onChange({ props: next.length ? next : undefined })
  }

  function removeUnreferenced(name: string) {
    onChange({ props: propsConfig.filter((p) => p.name !== name) })
  }

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
               declare const env: Record<string, string>;
               declare const props: Record<string, unknown>;`,
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
      {rows.length > 0 && (
        <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
          <p className="mb-2 text-xs font-medium text-gray-600">Props</p>
          <p className="mb-2 text-xs text-gray-400">
            Wire each <code className="rounded bg-white px-1 font-mono">props.X</code> reference in the script. Sources can be templates like <code className="rounded bg-white px-1 font-mono">{'{{steps.x.output.y}}'}</code> or <code className="rounded bg-white px-1 font-mono">{'{{payload.field}}'}</code>.
          </p>
          <div className="space-y-1.5">
            {rows.map((row) => (
              <div key={row.name} className="flex items-center gap-1.5">
                <span className={`w-32 flex-shrink-0 truncate rounded border px-2 py-1.5 font-mono text-xs ${row.referenced ? 'border-gray-200 bg-white text-gray-800' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                  {row.name}
                </span>
                <input
                  className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                  value={row.source}
                  onChange={(e) => updateSource(row.name, e.target.value)}
                  placeholder="{{steps.example.output.field}}"
                />
                {!row.referenced && (
                  <button
                    type="button"
                    onClick={() => removeUnreferenced(row.name)}
                    className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    title="No longer referenced — remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
        Async function body. <code className="rounded bg-gray-100 px-1">payload</code>, <code className="rounded bg-gray-100 px-1">steps</code>, <code className="rounded bg-gray-100 px-1">env</code>, <code className="rounded bg-gray-100 px-1">props</code> available. Must <code className="rounded bg-gray-100 px-1">return</code> a value.
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

  // Display Content-Type: application/json as a pre-populated row when headers
  // is undefined (untouched). Once the user touches anything, persist to config —
  // including an empty {} if they clear every row, so the default doesn't reappear.
  const persistedHeaders = config.headers as Record<string, string> | undefined
  const isPristine = persistedHeaders === undefined
  const headerRows: [string, string][] = isPristine
    ? [['Content-Type', 'application/json']]
    : Object.entries(persistedHeaders)

  function updateHeader(index: number, key: string, value: string) {
    const next: Record<string, string> = {}
    headerRows.forEach(([k, v], i) => {
      if (i === index) {
        if (key) next[key] = value
      } else {
        next[k] = v
      }
    })
    onChange({ headers: next })
  }
  function addHeader() {
    onChange({ headers: { ...Object.fromEntries(headerRows), '': '' } })
  }
  function removeHeader(index: number) {
    const next: Record<string, string> = {}
    headerRows.forEach(([k, v], i) => {
      if (i !== index) next[k] = v
    })
    onChange({ headers: next })
  }

  return (
    <section className="space-y-3">
      <Field label="Status code" hint="A number, or a template like {{steps.X.output.status}} that resolves to one. Falls back to 200 if blank or unresolvable.">
        <input
          type="text"
          className="input"
          placeholder="200"
          value={(() => {
            const raw = config.status_code as number | string | undefined
            return raw === undefined ? '' : String(raw)
          })()}
          onChange={(e) => {
            const v = e.target.value.trim()
            if (v === '') { onChange({ status_code: undefined }); return }
            // Template? Keep as string; engine resolves at run time.
            if (v.includes('{{')) { onChange({ status_code: v }); return }
            const n = parseInt(v, 10)
            onChange({ status_code: Number.isFinite(n) ? n : v })
          }}
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
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-gray-600">Headers</label>
          <button
            type="button"
            onClick={addHeader}
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            + Add
          </button>
        </div>
        {headerRows.length === 0 ? (
          <p className="text-xs text-gray-400">
            No headers will be sent. Click <span className="font-medium text-blue-600">+ Add</span> to set <code className="rounded bg-gray-100 px-1">Content-Type</code>, <code className="rounded bg-gray-100 px-1">Cache-Control</code>, <code className="rounded bg-gray-100 px-1">Location</code>, CORS, etc.
          </p>
        ) : (
          <div className="space-y-1.5">
            {headerRows.map(([key, value], i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className="flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                  value={key}
                  onChange={(e) => updateHeader(i, e.target.value, value)}
                  placeholder="Header"
                />
                <input
                  className="flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                  value={value}
                  onChange={(e) => updateHeader(i, key, e.target.value)}
                  placeholder="Value"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(i)}
                  className="text-xs text-gray-400 hover:text-red-600"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={Boolean(config.continue_after_response)}
          onChange={(e) => onChange({ continue_after_response: e.target.checked || undefined })}
        />
        <span>
          <span className="font-medium">Continue after response</span>
          <span className="mt-0.5 block text-gray-400">
            Send the HTTP response immediately and keep walking the graph (for post-response work like Salesforce patches).
          </span>
        </span>
      </label>
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

function DataStoreConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const store = (config.store as string | undefined) ?? 'submissions'
  const operation = (config.operation as 'set' | 'get' | 'delete' | undefined) ?? 'set'
  const key = (config.key as string | undefined) ?? ''
  const ttl = config.ttl_seconds as number | undefined
  const valueStr =
    config.value !== undefined
      ? typeof config.value === 'string'
        ? config.value
        : JSON.stringify(config.value, null, 2)
      : ''

  // Write defaults to config on mount when they're undefined. Without this, the
  // form shows 'set' as the visual default but config.operation stays undefined
  // until the user clicks a button — and the executor throws on missing
  // operation. Same pattern bit us on BidGroup.no_winner_behavior; root-cause
  // fix is to make the displayed default also the persisted default.
  useEffect(() => {
    const patch: Record<string, unknown> = {}
    if (config.store === undefined) patch.store = 'submissions'
    if (config.operation === undefined) patch.operation = 'set'
    if (Object.keys(patch).length > 0) onChange(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="space-y-4">
      <Field label="Store" hint="Which KV namespace to target. Only one store today; future stores plug in here.">
        <div className="relative">
          <select
            value={store}
            onChange={(e) => onChange({ store: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="submissions">submissions</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      <Field label="Operation">
        <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
          {(['set', 'get', 'delete'] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ operation: op })}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                operation === op
                  ? 'bg-p-blue-light text-p-blue-dark'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              {op}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Key" hint="Supports {{trigger.*}}, {{steps.*.output.*}}, {{env.*}} templates.">
        <input
          className="input"
          placeholder="{{trigger.payload.Submission__c}}"
          value={key}
          onChange={(e) => onChange({ key: e.target.value })}
        />
      </Field>

      {operation === 'set' && (
        <>
          <Field label="Value (JSON or template)">
            <TemplateTextarea
              className="input min-h-[80px] resize-y font-mono text-xs"
              placeholder={'"{{steps.engine_call.output.uuid}}"'}
              value={valueStr}
              onChange={(val) => {
                try {
                  onChange({ value: JSON.parse(val) })
                } catch {
                  onChange({ value: val })
                }
              }}
              refs={refs}
            />
          </Field>
          <Field label="TTL (seconds)" hint="Minimum 60 (Cloudflare KV floor). 604800 = 7 days.">
            <input
              type="number"
              className="input"
              placeholder="604800"
              value={ttl ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value)
                onChange({ ttl_seconds: Number.isFinite(n) ? n : undefined })
              }}
            />
          </Field>
        </>
      )}
    </section>
  )
}

function LatencyGateConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const operation = (config.operation as 'mark' | 'check' | undefined) ?? 'mark'
  const correlationKey = (config.correlation_key as string | undefined) ?? ''
  const scope = (config.scope as string | undefined) ?? ''
  const ttl = config.ttl_seconds as number | undefined
  const thresholdMs = config.threshold_ms as number | undefined
  const partnerId = (config.partner_id as string | undefined) ?? ''
  const [partners, setPartners] = useState<Partner[]>([])

  // Persist the displayed default so the executor doesn't throw on a missing
  // operation (see DataStoreConfig for the same pattern).
  useEffect(() => {
    if (config.operation === undefined) onChange({ operation: 'mark' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    api.partners.list().then(setPartners).catch(() => {})
  }, [])

  return (
    <section className="space-y-4">
      <Field label="Operation" hint="Mark stamps the time on the bid. Check measures elapsed time on the confirmation and gates on it.">
        <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
          {(['mark', 'check'] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ operation: op })}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                operation === op
                  ? 'bg-p-blue-light text-p-blue-dark'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              {op}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Correlation key"
        hint="The id the network echoes on BOTH the bid and the confirmation, so check can find the matching mark. Supports {{trigger.*}}, {{steps.*.output.*}}, {{env.*}}."
      >
        <input
          className="input"
          placeholder="{{trigger.payload.lead_id}}"
          value={correlationKey}
          onChange={(e) => onChange({ correlation_key: e.target.value })}
        />
      </Field>

      <Field label="Scope (optional)" hint="Namespaces the key so two partners can't collide on the same id. Often the partner slug.">
        <input
          className="input"
          placeholder="{{trigger.source}}"
          value={scope}
          onChange={(e) => onChange({ scope: e.target.value || undefined })}
        />
      </Field>

      {operation === 'mark' && (
        <Field label="TTL (seconds)" hint="How long to keep the mark. Minimum 60. Default 86400 (24h). Set above the longest expected waiting period.">
          <input
            type="number"
            className="input"
            placeholder="86400"
            value={ttl ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value)
              onChange({ ttl_seconds: Number.isFinite(n) ? n : undefined })
            }}
          />
        </Field>
      )}

      {operation === 'check' && (
        <>
          <Field label="Threshold partner" hint="Reads this partner's confirmation window as the latency threshold. Set the value on the partner's settings page.">
            <div className="relative">
              <select
                value={partnerId}
                onChange={(e) => onChange({ partner_id: e.target.value || undefined })}
                className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
              >
                <option value="">Select a partner...</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{!p.is_active ? ' (inactive)' : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
            </div>
          </Field>
          <Field label="Threshold override (ms)" hint="Optional. When set, this wins over the partner's confirmation window.">
            <input
              type="number"
              className="input"
              placeholder="(use partner setting)"
              value={thresholdMs ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value)
                onChange({ threshold_ms: Number.isFinite(n) ? n : undefined })
              }}
            />
          </Field>
          <p className="text-xs text-slate-400">
            Over threshold routes to <span className="font-mono">exceeded</span> (reject due to latency). A missing mark also routes <span className="font-mono">exceeded</span>.
          </p>
        </>
      )}
    </section>
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
            <option value="">Select a step...</option>
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
          <p className="text-xs text-gray-500">Rank partners by a combined score. Slide each weight to control how much it matters. Higher = more important.</p>
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
      <Field label="If no winner is found" hint="What to do when all bids are rejected, below minimum, or errored, and no fallback partner is set.">
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
  // Display Content-Type: application/json as a pre-populated row when headers
  // is undefined (untouched). The engine adds the same default; surfacing it
  // makes it editable/removable instead of an invisible behavior.
  const persistedHeaders = config.headers as Record<string, string> | undefined
  const headersMap: Record<string, string> =
    persistedHeaders ?? { 'Content-Type': 'application/json' }
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
            <Field label="Token (use {{env.SECRET_NAME}})">
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
              <Field label="Password (use {{env.SECRET_NAME}})">
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
              <Field label="Value (use {{env.SECRET_NAME}})">
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
            <option value="">Select a partner...</option>
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

// ── Bid Group ─────────────────────────────────────────────────────────────────

type BidGroupMode = 'cascade' | 'highest_bid' | 'tiered'

interface BidGroupTier {
  id: string
  label?: string
  mode: 'cascade' | 'highest_bid'
  partner_ids: string[]
  advance_condition?: { groups: ConditionGroup[]; logic: 'AND' | 'OR' }
}

function BidGroupConfig({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  const [partners, setPartners] = useState<Partner[]>([])

  useEffect(() => {
    api.partners.list().then(setPartners).catch(() => {})
  }, [])

  const mode = ((config.mode as BidGroupMode | undefined) ?? 'highest_bid') as BidGroupMode
  const partnerIds = ((config.partner_ids as string[] | undefined) ?? [])
  const fallbackId = (config.fallback_partner_id as string | null | undefined) ?? null
  const minBid = (config.min_bid_threshold as number | null | undefined) ?? null
  // Legacy 'fail' value is an alias for 'route' — both fall through to the no_winner edge.
  // Normalize on read so the UI only deals with the canonical names.
  const rawNoWinner = config.no_winner_behavior as string | undefined
  const noWinnerBehavior: 'route' | 'exit' = rawNoWinner === 'exit' ? 'exit' : 'route'
  const cascadeTimeoutMs = (config.cascade_total_timeout_ms as number | undefined) ?? 30000

  const buyerPartners = partners.filter((p) => p.partner_type === 'buyer')
  const partnerById = new Map(buyerPartners.map((p) => [p.id, p]))

  function setMode(next: BidGroupMode) {
    onChange({ mode: next })
  }

  function togglePartner(id: string) {
    const next = partnerIds.includes(id) ? partnerIds.filter((p) => p !== id) : [...partnerIds, id]
    onChange({ partner_ids: next })
  }

  function movePartner(idx: number, dir: -1 | 1) {
    const next = [...partnerIds]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange({ partner_ids: next })
  }

  return (
    <section className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-gray-600">Mode</p>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(['cascade', 'highest_bid', 'tiered'] as BidGroupMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === m ? 'bg-graphite text-white' : 'text-gray-600 hover:text-graphite'
              }`}
            >
              {m === 'cascade' ? 'Cascade' : m === 'highest_bid' ? 'Highest bid' : 'Tiered'}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          {mode === 'cascade' && 'Try partners in order. Stop at the first one that accepts.'}
          {mode === 'highest_bid' && 'Run all partners in parallel. Pick the highest accepted bid.'}
          {mode === 'tiered' && 'Cascade between tiers. Each tier runs its own partners in cascade or highest-bid mode. Tiers can be gated by a rule.'}
        </p>
      </div>

      {mode !== 'tiered' && <Field label={mode === 'cascade' ? 'Partners (in cascade order)' : 'Partners'} hint={mode === 'cascade' ? 'Drag the arrows to reorder. Earlier partners are tried first.' : 'Pick which partners to query in parallel.'}>
        <div className="space-y-1.5">
          {partnerIds.length === 0 && (
            <p className="rounded-md border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
              No partners selected.
            </p>
          )}
          {partnerIds.map((id, idx) => {
            const p = partnerById.get(id)
            return (
              <div key={id} className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1.5">
                {mode === 'cascade' && (
                  <div className="flex flex-col">
                    <button type="button" onClick={() => movePartner(idx, -1)} disabled={idx === 0} className="text-gray-400 hover:text-graphite disabled:opacity-30" title="Move up">
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button type="button" onClick={() => movePartner(idx, 1)} disabled={idx === partnerIds.length - 1} className="text-gray-400 hover:text-graphite disabled:opacity-30" title="Move down">
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <span className="flex-1 truncate text-sm text-graphite">
                  {p ? p.name : <span className="text-red-500">Unknown partner ({id.slice(0, 8)})</span>}
                  {p && !p.is_active && <span className="ml-2 text-xs text-gray-400">(inactive)</span>}
                </span>
                <button type="button" onClick={() => togglePartner(id)} className="text-gray-300 hover:text-red-400" title="Remove">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-p-blue-dark hover:text-navy">Add partners…</summary>
          <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-1.5">
            {buyerPartners.filter((p) => !partnerIds.includes(p.id)).length === 0 && (
              <p className="px-1 py-0.5 text-xs text-gray-400">All buyer partners selected.</p>
            )}
            {buyerPartners.filter((p) => !partnerIds.includes(p.id)).map((p) => (
              <button key={p.id} type="button" onClick={() => togglePartner(p.id)} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-gray-50">
                <span>{p.name}{!p.is_active && <span className="ml-2 text-xs text-gray-400">(inactive)</span>}</span>
                <Plus className="h-3.5 w-3.5 text-gray-400" />
              </button>
            ))}
          </div>
        </details>
      </Field>}

      {mode === 'tiered' && (
        <TieredEditor
          tiers={(config.tiers as BidGroupTier[] | undefined) ?? []}
          buyerPartners={buyerPartners}
          refs={refs}
          onChange={(tiers) => onChange({ tiers })}
        />
      )}

      <Field label="Minimum bid ($)" hint="Bids below this threshold count as rejected.">
        <input
          type="number"
          value={minBid ?? ''}
          onChange={(e) => onChange({ min_bid_threshold: e.target.value === '' ? null : parseFloat(e.target.value) })}
          placeholder="No minimum"
          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
        />
      </Field>

      <Field label="Fallback partner" hint="Optional. Tried after primary partners if no winner.">
        <div className="relative">
          <select
            value={fallbackId ?? ''}
            onChange={(e) => onChange({ fallback_partner_id: e.target.value || null })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm focus:border-gray-400 focus:outline-none"
          >
            <option value="">No fallback</option>
            {buyerPartners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      <Field label="If no winner" hint="What happens when no partner accepts and the fallback (if any) doesn't accept either.">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {([
            { v: 'route', label: 'Take no_winner edge' },
            { v: 'exit', label: 'Exit workflow' },
          ] as const).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => onChange({ no_winner_behavior: opt.v })}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                noWinnerBehavior === opt.v ? 'bg-graphite text-white' : 'text-gray-600 hover:text-graphite'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      {mode === 'cascade' && (
        <Field label="Cascade timeout (ms)" hint="Max wall-clock time to spend trying partners in order. Defaults to 30000.">
          <input
            type="number"
            value={cascadeTimeoutMs}
            onChange={(e) => onChange({ cascade_total_timeout_ms: parseInt(e.target.value) || 30000 })}
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
          />
        </Field>
      )}

      {mode === 'highest_bid' && (
        <Field label="Race deadline (ms)" hint="Max time to wait for partners to respond. Partners that don't settle in time are recorded as failed; the underlying fetch keeps running. Leave blank to wait indefinitely (each partner still has its own 15s fetch timeout).">
          <input
            type="number"
            value={(config.timeout_ms as number | undefined) ?? ''}
            placeholder="5000"
            onChange={(e) => {
              const v = e.target.value.trim()
              if (v === '') { onChange({ timeout_ms: undefined }); return }
              const n = parseInt(v, 10)
              onChange({ timeout_ms: Number.isFinite(n) ? n : undefined })
            }}
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
          />
        </Field>
      )}

      <BidGroupContextEditor config={config} onChange={onChange} refs={refs} />
    </section>
  )
}

function BidGroupContextEditor({
  config,
  onChange,
  refs,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  refs: string[]
}) {
  // Local row state. The serialized form (Record<string, unknown>) can't
  // express an empty-key row, so rendering directly off config.context would
  // drop newly-added blank rows before the user could type a key. Same pattern
  // as ExtraExtractionEditor (see reference_row_editor_local_state_for_invalid_rows.md).
  const ctxObj = (config.context as Record<string, unknown> | undefined) ?? {}
  const [entries, setLocalEntries] = useState<[string, unknown][]>(Object.entries(ctxObj))
  const valueKey = JSON.stringify(ctxObj)
  useEffect(() => {
    setLocalEntries(Object.entries(ctxObj))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey])

  function setEntries(next: [string, unknown][]) {
    setLocalEntries(next)
    const out: Record<string, unknown> = {}
    for (const [k, v] of next) {
      if (!k) continue
      out[k] = v
    }
    onChange({ context: Object.keys(out).length > 0 ? out : undefined })
  }

  function addRow() {
    setEntries([...entries, ['', '']])
  }
  function updateKey(i: number, key: string) {
    setEntries(entries.map((e, idx) => (idx === i ? [key, e[1]] : e)))
  }
  function updateVal(i: number, val: string) {
    setEntries(entries.map((e, idx) => (idx === i ? [e[0], val] : e)))
  }
  function removeRow(i: number) {
    setEntries(entries.filter((_, idx) => idx !== i))
  }

  return (
    <div className="border-t border-gray-100 pt-4">
      <h4 className="mb-1 text-xs font-medium text-gray-600">Context</h4>
      <p className="mb-2 text-xs text-gray-400">
        Name → template pairs resolved once per BidGroup run, exposed to partner
        formulas as <code className="rounded bg-gray-100 px-1 font-mono">context.&lt;name&gt;</code>.
        Use these to keep partner configs workflow-agnostic: bind step outputs here,
        partner formulas reference the name. Example:
        <code className="rounded bg-gray-100 px-1 font-mono">finalDebt</code> →
        <code className="rounded bg-gray-100 px-1 font-mono">{'{{steps.pennie_or_eligibility.output.final}}'}</code>.
      </p>
      {entries.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={k}
                onChange={(e) => updateKey(i, e.target.value)}
                placeholder="finalDebt"
                className="w-32 flex-shrink-0 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
              />
              <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" />
              <input
                value={typeof v === 'string' ? v : String(v ?? '')}
                onChange={(e) => updateVal(i, e.target.value)}
                placeholder="{{steps.eligibility.output.final}}"
                className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 font-mono text-xs focus:border-gray-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="flex-shrink-0 text-gray-300 hover:text-red-400"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
      >
        <Plus className="h-3.5 w-3.5" />
        Add context value
      </button>
      {refs.length > 0 && entries.length === 0 && (
        <p className="mt-1 text-xs text-gray-400">
          {/* refs prop already supports the template autocomplete used elsewhere; */}
          {/* documenting unused-but-available for now */}
        </p>
      )}
    </div>
  )
}

function TieredEditor({
  tiers,
  buyerPartners,
  refs,
  onChange,
}: {
  tiers: BidGroupTier[]
  buyerPartners: Partner[]
  refs: string[]
  onChange: (next: BidGroupTier[]) => void
}) {
  const partnerById = new Map(buyerPartners.map((p) => [p.id, p]))

  function update(i: number, patch: Partial<BidGroupTier>) {
    onChange(tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  }
  function remove(i: number) {
    onChange(tiers.filter((_, idx) => idx !== i))
  }
  function move(i: number, dir: -1 | 1) {
    const next = [...tiers]
    const target = i + dir
    if (target < 0 || target >= next.length) return
    ;[next[i], next[target]] = [next[target], next[i]]
    onChange(next)
  }
  function add() {
    onChange([...tiers, { id: `tier_${Math.random().toString(36).slice(2, 8)}`, mode: 'highest_bid', partner_ids: [] }])
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Tiers</p>
      {tiers.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-400">
          No tiers yet. Tiers run in order — each tier&apos;s mode determines how its partners are queried.
        </p>
      )}
      {tiers.map((tier, i) => {
        const cond = tier.advance_condition
        const hasGate = !!cond && cond.groups && cond.groups.length > 0
        return (
          <div key={tier.id} className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-500">{i + 1}</span>
              <input
                value={tier.label ?? ''}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder={`Tier ${i + 1}`}
                className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
              />
              <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
                {(['cascade', 'highest_bid'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => update(i, { mode: m })}
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      tier.mode === m ? 'bg-graphite text-white' : 'text-gray-600 hover:text-graphite'
                    }`}
                  >
                    {m === 'cascade' ? 'Cascade' : 'Highest'}
                  </button>
                ))}
              </div>
              <div className="flex flex-col">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-graphite disabled:opacity-30" title="Move up">
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === tiers.length - 1} className="text-gray-400 hover:text-graphite disabled:opacity-30" title="Move down">
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              <button type="button" onClick={() => remove(i)} className="text-gray-300 hover:text-red-400">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-gray-600">Partners</p>
              <div className="space-y-1">
                {tier.partner_ids.length === 0 && (
                  <p className="rounded-md border border-dashed border-gray-200 px-2 py-1.5 text-xs text-gray-400">No partners selected.</p>
                )}
                {tier.partner_ids.map((id) => {
                  const p = partnerById.get(id)
                  return (
                    <div key={id} className="flex items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1">
                      <span className="flex-1 truncate text-xs text-graphite">{p?.name ?? id.slice(0, 8)}</span>
                      <button type="button" onClick={() => update(i, { partner_ids: tier.partner_ids.filter((x) => x !== id) })} className="text-gray-300 hover:text-red-400">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <details className="mt-1.5">
                <summary className="cursor-pointer text-xs text-p-blue-dark hover:text-navy">Add partners…</summary>
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md border border-gray-200 p-1.5">
                  {buyerPartners.filter((p) => !tier.partner_ids.includes(p.id)).map((p) => (
                    <button key={p.id} type="button" onClick={() => update(i, { partner_ids: [...tier.partner_ids, p.id] })} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-gray-50">
                      <span>{p.name}{!p.is_active && <span className="ml-2 text-gray-400">(inactive)</span>}</span>
                      <Plus className="h-3 w-3 text-gray-400" />
                    </button>
                  ))}
                </div>
              </details>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium text-gray-600">Advance condition</p>
                {hasGate ? (
                  <button type="button" onClick={() => update(i, { advance_condition: undefined })} className="text-xs text-gray-400 hover:text-red-400">Remove gate</button>
                ) : (
                  <button
                    type="button"
                    onClick={() => update(i, { advance_condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } })}
                    className="text-xs text-p-blue-dark hover:text-navy"
                  >
                    Add gate
                  </button>
                )}
              </div>
              {hasGate ? (
                <RuleBuilder
                  groups={cond.groups}
                  logic={cond.logic}
                  onChange={(groups, logic) => update(i, { advance_condition: { groups, logic } })}
                  fieldSuggestions={refs}
                />
              ) : (
                <p className="text-xs text-gray-400">Always run this tier when no winner yet.</p>
              )}
            </div>
          </div>
        )
      })}
      <button onClick={add} className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy">
        <Plus className="h-3.5 w-3.5" />
        Add tier
      </button>
    </div>
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

// Pre-populated when a Salesforce node is first opened. Edits/removals stick
// per-node — clearing the list serializes as [] (not undefined), so the default
// only re-applies to nodes that have never been touched. See
// feedback_form_displayed_default_must_be_persisted memory.
const SF_DEFAULT_TRANSIENT_ERRORS: { code: string; message_contains?: string }[] = [
  { code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'Concurrent' },
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
  const expectedErrors = (config.expected_errors as { code: string; message_contains?: string; response_body?: unknown; response_status?: number }[] | undefined) ?? []
  const transientErrors = (config.transient_errors as { code: string; message_contains?: string }[] | undefined) ?? []
  const injectedFields = (config.injected_fields as Record<string, string> | undefined) ?? {}
  const injectedRows = Object.entries(injectedFields)

  // Persisted default: pre-populate transient_errors with the SF concurrency-limit
  // entry on first mount of an unconfigured node. With key={node.id} at the render
  // site, this fires per node. An explicit [] (user cleared all rows) is preserved.
  useEffect(() => {
    if (config.transient_errors === undefined) {
      onChange({ transient_errors: SF_DEFAULT_TRANSIENT_ERRORS })
    }
    // Intentional one-time mount write — re-runs are gated by the key={node.id} remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateTransientError(index: number, patch: Partial<{ code: string; message_contains: string }>) {
    const next = [...transientErrors]
    const current = next[index] ?? { code: '' }
    next[index] = { ...current, ...patch }
    if (next[index].message_contains !== undefined && next[index].message_contains!.trim() === '') {
      delete next[index].message_contains
    }
    onChange({ transient_errors: next })
  }
  function addTransientError() {
    onChange({ transient_errors: [...transientErrors, { code: '' }] })
  }
  function removeTransientError(index: number) {
    // Keep [] (explicit empty) rather than undefined so the mount-effect default
    // doesn't re-add rows the user deliberately cleared.
    const next = transientErrors.filter((_, i) => i !== index)
    onChange({ transient_errors: next })
  }

  function updateInjectedField(index: number, key: string, value: string) {
    const next: Record<string, string> = {}
    injectedRows.forEach(([k, v], i) => {
      if (i === index) {
        if (key) next[key] = value
      } else {
        next[k] = v
      }
    })
    onChange({ injected_fields: Object.keys(next).length > 0 ? next : undefined })
  }
  function addInjectedField() {
    onChange({ injected_fields: { ...injectedFields, '': '' } })
  }
  function removeInjectedField(index: number) {
    const next: Record<string, string> = {}
    injectedRows.forEach(([k, v], i) => {
      if (i !== index) next[k] = v
    })
    onChange({ injected_fields: Object.keys(next).length > 0 ? next : undefined })
  }

  const [bodyText, setBodyText] = useState(() =>
    body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) : ''
  )

  function updateExpectedError(index: number, patch: Partial<{ code: string; message_contains: string; response_body: unknown; response_status: number }>) {
    const next = [...expectedErrors]
    const current = next[index] ?? { code: '' }
    next[index] = { ...current, ...patch }
    // Clean empty message_contains so it serializes as undefined
    if (next[index].message_contains !== undefined && next[index].message_contains!.trim() === '') {
      delete next[index].message_contains
    }
    onChange({ expected_errors: next })
  }
  function addExpectedError() {
    onChange({ expected_errors: [...expectedErrors, { code: '' }] })
  }
  function removeExpectedError(index: number) {
    const next = expectedErrors.filter((_, i) => i !== index)
    onChange({ expected_errors: next.length > 0 ? next : undefined })
  }

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

      {(operation === 'create' || operation === 'update' || operation === 'upsert') && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-xs font-medium text-gray-600">Injected fields</label>
            <button
              type="button"
              onClick={addInjectedField}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              + Add
            </button>
          </div>
          {injectedRows.length === 0 ? (
            <p className="text-xs text-gray-400">
              Always-merge fields. Override the body on key collision. Use <code className="rounded bg-gray-100 px-1">{'{{execution.bidspoke_link}}'}</code> for the run deeplink.
            </p>
          ) : (
            <div className="space-y-1.5">
              {injectedRows.map(([key, value], i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    className="flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                    value={key}
                    onChange={(e) => updateInjectedField(i, e.target.value, value)}
                    placeholder="Field__c"
                  />
                  <TemplateTextarea
                    value={value}
                    onChange={(v) => updateInjectedField(i, key, v)}
                    refs={refs}
                    placeholder="{{execution.bidspoke_link}}"
                    className="flex-1 rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeInjectedField(i)}
                    className="text-xs text-gray-400 hover:text-red-600"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-gray-600">Expected errors</label>
          <button
            type="button"
            onClick={addExpectedError}
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            + Add
          </button>
        </div>
        {expectedErrors.length === 0 ? (
          <p className="text-xs text-gray-400">
            Treat matching Salesforce errors as business rejections. Step completes and the workflow exits here instead of failing.
          </p>
        ) : (
          <div className="space-y-2">
            {expectedErrors.map((err, i) => (
              <div key={i} className="rounded border border-gray-200 p-2">
                <div className="mb-2 flex items-start gap-2">
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">errorCode</label>
                    <input
                      className="w-full rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                      value={err.code}
                      onChange={(e) => updateExpectedError(i, { code: e.target.value })}
                      placeholder="FIELD_CUSTOM_VALIDATION_EXCEPTION"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeExpectedError(i)}
                    className="mt-4 text-xs text-gray-400 hover:text-red-600"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">Message contains (optional)</label>
                  <input
                    className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
                    value={err.message_contains ?? ''}
                    onChange={(e) => updateExpectedError(i, { message_contains: e.target.value })}
                    placeholder="Social Security Number was created in the last 60 days"
                  />
                </div>
                <div className="mt-2 grid grid-cols-[80px_1fr] gap-2">
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">Response status</label>
                    <input
                      type="number"
                      min={100}
                      max={599}
                      className="w-full rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                      value={err.response_status ?? ''}
                      onChange={(e) => updateExpectedError(i, { response_status: e.target.value ? parseInt(e.target.value) : undefined as unknown as number })}
                      placeholder="200"
                    />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">Response body (JSON, optional)</label>
                    <TemplateTextarea
                      className="w-full rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none min-h-[60px] resize-y"
                      value={err.response_body !== undefined ? (typeof err.response_body === 'string' ? err.response_body : JSON.stringify(err.response_body)) : ''}
                      onChange={(v) => {
                        if (v.trim() === '') {
                          updateExpectedError(i, { response_body: undefined })
                          return
                        }
                        try { updateExpectedError(i, { response_body: JSON.parse(v) }) }
                        catch { updateExpectedError(i, { response_body: v }) }
                      }}
                      refs={refs}
                      placeholder='{ "lead_id": "{{trigger.payload.leadUuid}}", "status": "rejected", "reason": "duplicated lead" }'
                    />
                  </div>
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-400">
              Both errorCode and message substring must match. Leave message blank to match any message with that errorCode. If a response body is set, it&apos;s returned to the caller instead of the raw SF error structure.
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium text-gray-600">Retryable errors</label>
          <button
            type="button"
            onClick={addTransientError}
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            + Add
          </button>
        </div>
        {transientErrors.length === 0 ? (
          <p className="text-xs text-gray-400">
            Treat matching Salesforce errors as transient — the engine&apos;s retry + backoff kicks in instead of failing immediately. Defaults to <code className="rounded bg-gray-100 px-1">REQUEST_LIMIT_EXCEEDED</code> + <code className="rounded bg-gray-100 px-1">Concurrent</code> (org concurrency limit, clears in seconds).
          </p>
        ) : (
          <div className="space-y-2">
            {transientErrors.map((err, i) => (
              <div key={i} className="rounded border border-gray-200 p-2">
                <div className="mb-2 flex items-start gap-2">
                  <div className="flex-1">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">errorCode</label>
                    <input
                      className="w-full rounded border border-gray-200 px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none"
                      value={err.code}
                      onChange={(e) => updateTransientError(i, { code: e.target.value })}
                      placeholder="REQUEST_LIMIT_EXCEEDED"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTransientError(i)}
                    className="mt-4 text-xs text-gray-400 hover:text-red-600"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase text-gray-400">Message contains (optional)</label>
                  <input
                    className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
                    value={err.message_contains ?? ''}
                    onChange={(e) => updateTransientError(i, { message_contains: e.target.value })}
                    placeholder="Concurrent"
                  />
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-400">
              Both errorCode and message substring must match (case-sensitive). Leave message blank to match any message with that errorCode. Retry count + backoff are set in Advanced settings below.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Parallel ──────────────────────────────────────────────────────────────────

function ParallelConfig({
  config,
  onChange,
  currentNodeId,
  edges,
  onEdgesChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  currentNodeId: string
  edges: { id: string; source: string; target: string; sourceHandle?: string | null }[]
  onEdgesChange?: (add: { id: string; source: string; target: string; sourceHandle: string }[], removeIds: string[]) => void
}) {
  const slots = readSlots(config)
  const waitFor = (config.wait_for as string | undefined) ?? 'all'
  const timeoutMs = (config.timeout_ms as number | undefined) ?? 15000
  const onTimeout = (config.on_timeout as string | undefined) ?? 'partial'
  const onChildError = (config.on_child_error as string | undefined) ?? 'fail'

  function nextSlotId(): string {
    let n = 0
    const used = new Set(slots.map((s) => s.id))
    while (used.has(`child-${n}`)) n++
    // Also avoid reusing ids that ever appeared on edges (defensive — survives a removed slot's edges).
    while (edges.some((e) => e.source === currentNodeId && e.sourceHandle === `child-${n}`)) n++
    return `child-${n}`
  }

  function addSlot() {
    const id = nextSlotId()
    onChange({ children: [...slots, { id, label: `child_${slots.length + 1}` }] })
  }

  function updateSlotLabel(i: number, label: string) {
    const next = slots.map((s, idx) => (idx === i ? { ...s, label } : s))
    onChange({ children: next })
  }

  function removeSlot(i: number) {
    const removed = slots[i]
    const next = slots.filter((_, idx) => idx !== i)
    onChange({ children: next })
    // Drop any edges that referenced the removed slot's handle so we don't leave dangling edges.
    const removeIds = edges
      .filter((e) => e.source === currentNodeId && e.sourceHandle === removed.id)
      .map((e) => e.id)
    if (removeIds.length > 0) onEdgesChange?.([], removeIds)
  }

  return (
    <section className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Slots</p>
        <p className="mt-1 mb-2 text-xs text-gray-400">Each slot fans out to one parallel branch. Drop a node under a slot to wire it up.</p>
        {slots.map((slot, i) => (
          <div key={slot.id} className="mb-2 flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder="slot label"
              value={slot.label}
              onChange={(e) => updateSlotLabel(i, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeSlot(i)}
              className="text-gray-300 hover:text-red-400"
              aria-label="Remove slot"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addSlot}
          className="flex items-center gap-1 text-xs text-p-blue-dark hover:text-navy"
        >
          <Plus className="h-3.5 w-3.5" />
          Add slot
        </button>
      </div>

      <Field label="Wait for" hint="'All' waits for every slot. 'First' continues as soon as one succeeds. 'Specific slot' continues as soon as the named slot finishes — siblings keep running but their results are ignored unless they happened to settle in time.">
        <div className="relative">
          <select
            value={waitFor}
            onChange={(e) => onChange({ wait_for: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="all">All slots</option>
            <option value="first">First to succeed</option>
            <option value="specific">Specific slot</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
      </Field>

      {waitFor === 'specific' && (
        <Field label="Wait for slot" hint="Parallel proceeds as soon as this slot finishes. If it fails, the parallel fails.">
          <div className="relative">
            <select
              value={(config.wait_for_slot as string | undefined) ?? ''}
              onChange={(e) => onChange({ wait_for_slot: e.target.value })}
              className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            >
              <option value="">Select a slot...</option>
              {slots.map((s) => (
                <option key={s.id} value={s.id}>{s.label || s.id}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
          </div>
        </Field>
      )}

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
        <Field label="On timeout" hint="What to do if some slots haven't finished when the timeout fires.">
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

      {waitFor === 'all' && (
        <Field label="On child error" hint="What to do when a slot fails. Default is to stop the workflow. Use 'Continue' when a downstream step (e.g. Bid Evaluation) handles rejections in the result array.">
          <div className="relative">
            <select
              value={onChildError}
              onChange={(e) => onChange({ on_child_error: e.target.value })}
              className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            >
              <option value="fail">Fail the execution</option>
              <option value="continue">Continue with results (include rejections)</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
          </div>
        </Field>
      )}
    </section>
  )
}

function readSlots(config: Record<string, unknown>): { id: string; label: string }[] {
  const raw = config.children
  if (!Array.isArray(raw)) return []
  if (raw.length > 0 && typeof raw[0] === 'string') {
    return (raw as string[]).map((_, i) => ({ id: `child-${i}`, label: `child_${i + 1}` }))
  }
  return raw as { id: string; label: string }[]
}

// ── Parallel End ───────────────────────────────────────────────────────────────

function ParallelEndConfig() {
  return (
    <section className="space-y-2">
      <p className="text-xs text-gray-500">
        This is the join point for the parallel above. Slots, wait behavior, and timeout are all configured on the parallel start node.
      </p>
    </section>
  )
}

function BranchEndConfig() {
  return (
    <section className="space-y-2">
      <p className="text-xs text-gray-500">
        Convergence point for the branch above. Wire the end of any branch path into this node and the chain continues from here. Branches that exit early don&apos;t need to feed in.
      </p>
    </section>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

type ConstantType = 'string' | 'number' | 'boolean' | 'array'

function detectType(value: unknown): ConstantType {
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function coerceForType(raw: string, type: ConstantType): unknown {
  switch (type) {
    case 'number': {
      if (raw.trim() === '') return ''
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    case 'boolean':
      return raw === 'true'
    case 'array':
      return raw.split(',').map((s) => s.trim()).filter(Boolean)
    case 'string':
    default:
      return raw
  }
}

function ConstantsConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  const data = (config.data ?? {}) as Record<string, unknown>
  const [typeOverrides, setTypeOverrides] = useState<Record<string, ConstantType>>({})

  function effectiveType(key: string): ConstantType {
    return typeOverrides[key] ?? detectType(data[key])
  }

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
    setTypeOverrides((m) => {
      if (!(oldKey in m)) return m
      const { [oldKey]: t, ...rest } = m
      return { ...rest, [newKey]: t }
    })
  }

  function setValue(key: string, raw: string) {
    updateData({ ...data, [key]: coerceForType(raw, effectiveType(key)) })
  }

  function setType(key: string, nextType: ConstantType) {
    setTypeOverrides((m) => ({ ...m, [key]: nextType }))
    const current = data[key]
    const asString = Array.isArray(current) ? current.join(', ') : String(current ?? '')
    updateData({ ...data, [key]: coerceForType(asString, nextType) })
  }

  function removeKey(key: string) {
    const updated = { ...data }
    delete updated[key]
    updateData(updated)
    setTypeOverrides((m) => {
      if (!(key in m)) return m
      const { [key]: _, ...rest } = m
      return rest
    })
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
              const type = effectiveType(key)
              const displayValue = Array.isArray(value)
                ? value.join(', ')
                : String(value ?? '')
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <input
                    className="w-32 flex-shrink-0 rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                    value={key}
                    onChange={(e) => setKeyName(key, e.target.value)}
                    placeholder="key"
                  />
                  <select
                    className="flex-shrink-0 rounded border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                    value={type}
                    onChange={(e) => setType(key, e.target.value as ConstantType)}
                    title="Value type"
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="array">array</option>
                  </select>
                  {type === 'boolean' ? (
                    <select
                      className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                      value={value === true ? 'true' : 'false'}
                      onChange={(e) => setValue(key, e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
                      value={displayValue}
                      onChange={(e) => setValue(key, e.target.value)}
                      placeholder={
                        type === 'array' ? 'item1, item2, item3'
                          : type === 'number' ? '0'
                          : 'value'
                      }
                      inputMode={type === 'number' ? 'decimal' : 'text'}
                    />
                  )}
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
          For array values, enter comma-separated items.
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

// ── Timeout field with historical stats ──────────────────────────────────────

type StepStats = {
  p50: number | null
  p95: number | null
  p99: number | null
  max_ms: number | null
  sample_size: number
  suggested_ms: number | null
  window_days: number
  source: 'history' | 'similar'
  subtype: string | null
  retries_assumed: number
}

// Module-level cache so reopening the same node panel within the server-side
// 30-min KV window doesn't re-fetch and flicker the callout. TTL matches the
// worker's KV TTL.
const STEP_STATS_TTL_MS = 30 * 60 * 1000
const stepStatsCache = new Map<string, { stats: StepStats; fetchedAt: number }>()
function statsCacheKey(workflowId: string, namespace: string, nodeType?: string, subtype?: string, retries?: number) {
  return `${workflowId}|${namespace}|${nodeType ?? ''}|${subtype ?? ''}|${retries ?? ''}`
}

function TimeoutField({
  config,
  updateConfig,
  workflowId,
  namespace,
  nodeType,
}: {
  config: Record<string, unknown>
  updateConfig: (patch: Record<string, unknown>) => void
  workflowId?: string
  namespace?: string
  nodeType?: NodeType
}) {
  // Salesforce executor defaults operation to 'create' when absent; mirror that here so
  // a fresh create-prospect node can match historical create rows in the typed fallback.
  const subtype = nodeType === 'salesforce'
    ? ((config.operation as string | undefined) || 'create')
    : undefined

  // Mirror the engine's retries default (2) so the suggestion math knows
  // whether to clamp against max (no retries → must clear it) or just p99
  // (retries → long tail self-heals).
  const retries = (config.retries as number | undefined) ?? 2

  // Seed from the module cache so reopening the same panel within 30 min skips
  // the loading flash entirely.
  const cached = workflowId && namespace
    ? stepStatsCache.get(statsCacheKey(workflowId, namespace, nodeType, subtype, retries))
    : undefined
  const isFresh = cached && Date.now() - cached.fetchedAt < STEP_STATS_TTL_MS
  const [stats, setStats] = useState<StepStats | null>(isFresh ? cached.stats : null)
  const [loading, setLoading] = useState(!isFresh)

  useEffect(() => {
    if (!workflowId || !namespace) return
    const key = statsCacheKey(workflowId, namespace, nodeType, subtype, retries)
    const hit = stepStatsCache.get(key)
    if (hit && Date.now() - hit.fetchedAt < STEP_STATS_TTL_MS) {
      setStats(hit.stats)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.executions.stepDurationStats(workflowId, namespace, { node_type: nodeType, subtype, retries })
      .then((s) => {
        if (cancelled) return
        setStats(s)
        stepStatsCache.set(key, { stats: s, fetchedAt: Date.now() })
      })
      .catch(() => { if (!cancelled) setStats(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workflowId, namespace, nodeType, subtype, retries])

  // Pick a single unit (ms or s) for every value rendered inside the callout
  // so we don't mix '766ms' and '7.5s' in the same sentence.
  const fmt = makeUnitFormatter([
    stats?.p50 ?? null,
    stats?.p99 ?? null,
    stats?.max_ms ?? null,
    stats?.suggested_ms ?? null,
  ])

  const current = config.timeout_ms as number | undefined
  const effective = current ?? 30000

  // One callout, always shown when we have data. Tone defaults to neutral.
  // Action sentence is appended only when there's a recommendation to make,
  // and the numeric value inside it is the click target.
  type Tone = 'red' | 'amber' | 'blue' | 'neutral'
  let tone: Tone = 'neutral'
  let actionLeading: string | null = null
  let actionLink: { text: string; ms: number } | null = null
  let actionTrailing: string | null = null
  if (stats && stats.sample_size >= 10 && stats.p99 != null && stats.max_ms != null && stats.suggested_ms != null) {
    const hasRetries = stats.retries_assumed >= 1
    // Red threshold: with retries, only flag when most calls would time out
    // (current below p99 means typical calls fail and burn retries every time).
    // Without retries, anything below max means a real run would have failed.
    const redThreshold = hasRetries ? stats.p99 : stats.max_ms
    // Blue threshold: with retries we can suggest lowering even when current
    // sits between p99 and max, since outliers self-heal. Without retries
    // we still need both checks (suggested * 3 AND max * 2) so we don't push
    // a fat-tail step below its observed max.
    const blueThreshold = hasRetries
      ? effective > stats.suggested_ms * 3
      : effective > stats.suggested_ms * 3 && effective > stats.max_ms * 2

    if (effective < redThreshold) {
      tone = 'red'
      actionLeading = hasRetries
        ? 'Most runs would time out at this value — try'
        : 'Your timeout would have cut that off — try'
      actionLink = { text: `${stats.suggested_ms.toLocaleString()}ms`, ms: stats.suggested_ms }
      actionTrailing = 'for safety.'
    } else if (effective < stats.suggested_ms) {
      tone = 'amber'
      actionLeading = hasRetries
        ? 'Some runs will time out and burn retries — try'
        : 'Slower runs will get cut off — try'
      actionLink = { text: `${stats.suggested_ms.toLocaleString()}ms`, ms: stats.suggested_ms }
      actionTrailing = 'for more headroom.'
    } else if (blueThreshold) {
      tone = 'blue'
      actionLeading = 'You could safely lower this to'
      actionLink = { text: `${stats.suggested_ms.toLocaleString()}ms`, ms: stats.suggested_ms }
      actionTrailing = 'so failures show up faster.'
    }
  }

  const showStats = !loading && stats && stats.sample_size >= 10
  const showThin = !loading && stats && stats.sample_size < 10

  const calloutClasses =
    tone === 'red'
      ? 'border-red-200 bg-red-50 text-red-800'
      : tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : tone === 'blue'
      ? 'border-sky-200 bg-sky-50 text-sky-800'
      : 'border-gray-200 bg-gray-50 text-gray-700'
  const linkClasses =
    tone === 'red'
      ? 'font-semibold text-red-900 underline-offset-2 hover:underline'
      : tone === 'amber'
      ? 'font-semibold text-amber-900 underline-offset-2 hover:underline'
      : tone === 'blue'
      ? 'font-semibold text-sky-900 underline-offset-2 hover:underline'
      : 'font-semibold text-gray-900 underline-offset-2 hover:underline'

  return (
    <Field label="Timeout">
      {/* Input */}
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="input"
          placeholder="30000"
          value={current ?? ''}
          onChange={(e) => updateConfig({ timeout_ms: e.target.value ? parseInt(e.target.value) : undefined })}
        />
        <span className="text-xs text-gray-400 whitespace-nowrap">ms</span>
      </div>

      {/* Plain-language description sits right under the input */}
      <p className="mt-1.5 text-xs text-gray-500">
        How long to wait before giving up on this step. Default 30s.
      </p>

      {/* Single callout: stats + optional action sentence */}
      {workflowId && namespace && (
        <div className="mt-3">
          {loading && <p className="text-xs text-gray-400">Checking past runs…</p>}

          {showThin && (
            <p className="text-xs text-gray-400">
              Not enough runs yet to suggest a value ({stats!.sample_size} in the last week).
            </p>
          )}

          {showStats && (
            <div className={`rounded-md border px-2.5 py-1.5 text-xs leading-relaxed ${calloutClasses}`}>
              {stats!.source === 'similar' ? 'Similar steps in your other workflows' : 'This step'} usually{' '}
              {stats!.source === 'similar' ? 'finish' : 'finishes'} in{' '}
              <strong className="font-semibold">{fmt(stats!.p50!)}</strong>
              {' '}and rarely take{stats!.source === 'similar' ? '' : 's'} more than{' '}
              <strong className="font-semibold">{fmt(stats!.p99!)}</strong>
              {/* Surface max when the tail is meaningful, so users see why they
                  can't safely lower the timeout below it. */}
              {stats!.max_ms != null && stats!.p99 != null && stats!.max_ms > stats!.p99 * 1.2 && (
                <>
                  {', though one run took '}
                  <strong className="font-semibold">{fmt(stats!.max_ms)}</strong>
                </>
              )}
              <span className="opacity-70"> ({stats!.sample_size.toLocaleString()} runs in the last week)</span>.
              {actionLeading && current !== actionLink?.ms && (
                <>
                  {' '}
                  {actionLeading}
                  {actionLink && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => updateConfig({ timeout_ms: actionLink!.ms })}
                        className={linkClasses}
                      >
                        {actionLink.text}
                      </button>
                    </>
                  )}
                  {actionTrailing && <> {actionTrailing}</>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Field>
  )
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${ms.toLocaleString()}ms`
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
}

// Used inside the timeout callout where multiple values appear in one sentence
// and unit-mixing reads badly ("…rarely takes more than 766ms… lower this to 7.5s").
// Picks one unit for the whole set based on the largest value in the callout.
function makeUnitFormatter(values: (number | null)[]): (ms: number) => string {
  const present = values.filter((v): v is number => v != null)
  const useSeconds = present.some((v) => v >= 1000)
  return (ms: number) => {
    if (!useSeconds) {
      if (ms < 1) return '<1ms'
      return `${ms.toLocaleString()}ms`
    }
    if (ms < 10) return '<0.01s'
    const s = ms / 1000
    if (s < 1) return `${s.toFixed(2)}s`
    const oneDecimal = s.toFixed(1)
    return oneDecimal.endsWith('.0') ? `${oneDecimal.slice(0, -2)}s` : `${oneDecimal}s`
  }
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
