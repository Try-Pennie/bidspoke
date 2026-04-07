'use client'

import type { Node } from '@xyflow/react'
import type { CanvasNodeData, ConditionGroup, EdgeCondition, NodeType, ExecutionStep } from '@/types/workflow'
import RuleBuilder from '@/components/rule-builder/RuleBuilder'
import FieldAutocomplete from '@/components/rule-builder/FieldAutocomplete'
import TemplateTextarea from './TemplateTextarea'
import { X, Trash2, Plus, XCircle, CheckCircle, ChevronDown, ArrowRight } from 'lucide-react'

interface Props {
  node: Node
  onUpdate: (id: string, data: Partial<CanvasNodeData>) => void
  onDelete: (id: string) => void
  onClose: () => void
  nodeNamespaces: string[]
  refs?: string[]
}

export default function ConfigPanel({ node, onUpdate, onDelete, onClose, nodeNamespaces, refs = [] }: Props) {
  const data = node.data as unknown as CanvasNodeData & { executionStep?: ExecutionStep | null }
  const type = node.type as NodeType
  const exec = data.executionStep

  function updateConfig(patch: Record<string, unknown>) {
    onUpdate(node.id, { config: { ...data.config, ...patch } })
  }

  return (
    <aside className="flex w-80 flex-col border-l border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{type}</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">{data.namespace}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onDelete(node.id)}
            className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
            title="Delete node"
          >
            <Trash2 className="h-4 w-4" />
          </button>
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

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm">

        {/* Namespace */}
        <Field label="Step name (namespace)">
          <input
            className="input"
            value={data.namespace}
            onChange={(e) => onUpdate(node.id, { namespace: e.target.value })}
          />
        </Field>

        {/* Type-specific config */}
        {type === 'filter' && <FilterConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'branch' && <BranchConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'code' && <CodeConfig config={data.config} onChange={updateConfig} />}
        {type === 'response' && <ResponseConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'exit' && <ExitConfig config={data.config} onChange={updateConfig} refs={refs} />}
        {type === 'bid_evaluation' && <BidEvaluationConfig config={data.config} onChange={updateConfig} nodeNamespaces={nodeNamespaces} />}
        {type === 'transform' && <TransformConfig config={data.config} onChange={updateConfig} refs={refs} />}

        {/* Common: retry + error handling */}
        <details>
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600">
            Advanced
          </summary>
          <div className="mt-3 space-y-3">
            <Field label="Timeout (ms)">
              <input
                type="number"
                className="input"
                placeholder="30000"
                value={(data.config.timeout_ms as number | undefined) ?? ''}
                onChange={(e) => updateConfig({ timeout_ms: e.target.value ? parseInt(e.target.value) : undefined })}
              />
            </Field>
            <Field label="Retries">
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
            <Field label="On error">
              <select
                className="input"
                value={(data.config.on_error as string | undefined) ?? 'fail'}
                onChange={(e) => updateConfig({ on_error: e.target.value })}
              >
                <option value="fail">Fail execution</option>
                <option value="skip">Skip step</option>
                <option value="fallback">Go to fallback</option>
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
          </div>
        </details>
      </div>
    </aside>
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
            placeholder="Field or reference…"
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
        className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700"
      >
        <Plus className="h-3.5 w-3.5" />
        Add branch
      </button>
      <p className="text-xs text-gray-400">An implicit &quot;else&quot; branch is always last.</p>
    </section>
  )
}

function CodeConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  return (
    <Field label="Worker name">
      <input
        className="input font-mono"
        placeholder="workflow-abc123-step-name"
        value={(config.worker_name as string | undefined) ?? ''}
        onChange={(e) => onChange({ worker_name: e.target.value })}
      />
      <p className="mt-1 text-xs text-gray-400">
        Must be deployed in the <code className="rounded bg-gray-100 px-1">bidspoke-code-nodes</code> dispatch namespace.
      </p>
    </Field>
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
      <Field label="Parallel node (source)">
        <div className="relative">
          <select
            value={(config.parallel_source as string | undefined) ?? ''}
            onChange={(e) => onChange({ parallel_source: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="">— select a node —</option>
            {nodeNamespaces.map((ns) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
        <p className="mt-1 text-xs text-gray-400">Namespace of the Parallel node whose output to evaluate.</p>
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
        <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-500">Score = (bid × w₁) + (acceptance_rate × w₂) − (avg_ms × w₃)</p>
          <WeightSlider
            label="Bid amount weight (w₁)"
            value={(config.weight_bid as number | undefined) ?? 1.0}
            onChange={(v) => onChange({ weight_bid: v })}
          />
          <WeightSlider
            label="Acceptance rate weight (w₂)"
            value={(config.weight_acceptance as number | undefined) ?? 0.5}
            onChange={(v) => onChange({ weight_acceptance: v })}
          />
          <WeightSlider
            label="Speed weight (w₃)"
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
      <Field label="Fallback partner (slug)">
        <input
          className="input"
          placeholder="e.g. engine"
          value={(config.fallback_partner as string | undefined) ?? ''}
          onChange={(e) => onChange({ fallback_partner: e.target.value || null })}
        />
        <p className="mt-1 text-xs text-gray-400">Used when no bids qualify. Routes to winner handle.</p>
      </Field>

      {/* No-winner behavior */}
      <Field label="No-winner behavior">
        <div className="relative">
          <select
            value={noWinnerBehavior}
            onChange={(e) => onChange({ no_winner_behavior: e.target.value })}
            className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
          >
            <option value="exit">Exit (route to no_winner handle)</option>
            <option value="fail">Fail execution</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
        </div>
        <p className="mt-1 text-xs text-gray-400">When no fallback is set and all bids fail evaluation.</p>
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
        Only mapped fields appear in output. Source can be a path (<code className="rounded bg-gray-100 px-1 font-mono">steps.ns.field</code>),
        quoted literal (<code className="rounded bg-gray-100 px-1 font-mono">&quot;pending&quot;</code>),
        or arithmetic expression (<code className="rounded bg-gray-100 px-1 font-mono">steps.ns.amount * 0.85</code>).
      </p>

      <div className="space-y-2">
        {mappings.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <FieldAutocomplete
              value={row.source}
              onChange={(v) => updateRow(i, { source: v })}
              suggestions={refs}
              placeholder="source…"
              className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-gray-400 focus:outline-none font-mono"
            />
            <ArrowRight className="h-3 w-3 flex-shrink-0 text-gray-300" />
            <input
              className="min-w-0 w-24 rounded-md border border-gray-200 px-2 py-1.5 text-xs focus:border-gray-400 focus:outline-none font-mono"
              placeholder="target"
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
        className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700"
      >
        <Plus className="h-3.5 w-3.5" />
        Add field
      </button>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      {children}
    </div>
  )
}
