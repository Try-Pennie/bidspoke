'use client'

import { useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { Check, CheckCircle2, ChevronDown, ChevronRight, Copy, Loader2, MinusCircle, Play, Save, Trash2, X, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { ExecutionStep, SavedTestPayload } from '@/types/workflow'
import RailResizeHandle from './RailResizeHandle'

type TestStep = {
  step_namespace: string
  status: string
  input: unknown
  output: unknown
  error_message: string | null
  duration_ms: number
  step_order: number
  parallel_group_id?: string | null
}

interface Props {
  workflowId: string
  currentDefinition?: unknown
  onClose: () => void
  onComplete: () => void
  initialPayload?: string
  savedPayloads?: SavedTestPayload[]
  onSavedPayloadsChange?: (payloads: SavedTestPayload[]) => void
  onTestStart?: (executionId: string) => void
  onLiveStep?: (namespace: string, step: ExecutionStep) => void
  onTestEnd?: () => void
  onTestStepsLoaded?: (steps: Record<string, ExecutionStep>, execId: string) => void
  width?: number
  onResize?: (width: number) => void
}

const DEFAULT_PAYLOAD = '{\n  \n}'

function StepIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
  if (status === 'failed_with_fallback') return <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
  if (status === 'skipped') return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-gray-300" />
  return <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-gray-200" />
}

export default function TestRunPanel({
  workflowId,
  currentDefinition,
  onClose,
  onComplete,
  initialPayload,
  savedPayloads = [],
  onSavedPayloadsChange,
  onTestStart,
  onLiveStep,
  onTestEnd,
  onTestStepsLoaded,
  width,
  onResize,
}: Props) {
  const effectiveWidth = width ?? 384
  const [payload, setPayload] = useState(initialPayload ?? DEFAULT_PAYLOAD)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; body: unknown } | null>(null)
  const [resultKey, setResultKey] = useState(0)
  const [parseError, setParseError] = useState<string | null>(null)
  const [testSteps, setTestSteps] = useState<TestStep[] | null>(null)
  const [expandedStep, setExpandedStep] = useState<string | null>(null)

  // Saved payloads
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showSaveInput, setShowSaveInput] = useState(false)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
  }

  const nsToLabel = useMemo(() => {
    const def = currentDefinition as { nodes?: Array<{ namespace?: string; label?: string }> } | null | undefined
    const map: Record<string, string> = {}
    for (const n of def?.nodes ?? []) {
      if (n.namespace && n.label) map[n.namespace] = n.label
    }
    return map
  }, [currentDefinition])

  async function run() {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      setParseError('Invalid JSON')
      return
    }
    setParseError(null)
    setTestSteps(null)
    setExpandedStep(null)

    const execId = crypto.randomUUID()

    const supabase = createClient()
    const channel = supabase
      .channel(`test-run-${execId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'execution_steps', filter: `execution_id=eq.${execId}` },
        (payload) => {
          const row = payload.new as {
            step_namespace: string
            status: string
            output: unknown
            input: unknown
            error_message: string | null
            error_type: string | null
            duration_ms: number
            retries_used: number
          }
          onLiveStep?.(row.step_namespace, {
            status: row.status as ExecutionStep['status'],
            output: row.output,
            input: row.input,
            error_message: row.error_message,
            error_type: row.error_type,
            duration_ms: row.duration_ms,
            retries_used: row.retries_used,
          })
        }
      )
      .subscribe()

    onTestStart?.(execId)
    setRunning(true)
    setResult(null)

    try {
      const res = await api.workflows.test(workflowId, parsed, execId, currentDefinition)
      setResult({ ok: true, body: res })
      setResultKey((k) => k + 1)
      onComplete()
    } catch (e) {
      setResult({ ok: false, body: e instanceof Error ? e.message : String(e) })
      setResultKey((k) => k + 1)
      onComplete()
    } finally {
      setRunning(false)
      // Fetch step results — steps are logged synchronously so they're in the DB by now
      try {
        const exec = await api.executions.get(execId)
        if (exec.steps?.length) {
          const steps = exec.steps as TestStep[]
          setTestSteps(steps)
          // Feed results back to canvas for node + edge coloring
          const byNamespace: Record<string, ExecutionStep> = {}
          for (const s of steps) {
            byNamespace[s.step_namespace] = {
              status: s.status as ExecutionStep['status'],
              input: s.input,
              output: s.output,
              error_message: s.error_message,
              error_type: null,
              duration_ms: s.duration_ms,
              retries_used: 0,
            }
          }
          onTestStepsLoaded?.(byNamespace, execId)
        }
      } catch {
        // non-critical
      }
      // Keep Realtime channel open for canvas node coloring (Realtime has delivery lag)
      await new Promise<void>((r) => setTimeout(r, 3000))
      onTestEnd?.()
      await supabase.removeChannel(channel)
    }
  }

  async function savePayload() {
    if (!saveName.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      setParseError('Fix the JSON before saving')
      return
    }
    setParseError(null)
    setSaveError(null)
    setSaving(true)
    try {
      const next = [...savedPayloads.filter((p) => p.name !== saveName.trim()), { name: saveName.trim(), payload: parsed }]
      await api.workflows.saveTestPayloads(workflowId, next)
      onSavedPayloadsChange?.(next)
      setSaveName('')
      setShowSaveInput(false)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function deletePayload(name: string) {
    const next = savedPayloads.filter((p) => p.name !== name)
    await api.workflows.saveTestPayloads(workflowId, next)
    onSavedPayloadsChange?.(next)
  }

  return (
    <aside
      className="relative flex flex-shrink-0 flex-col border-l border-gray-200 bg-white"
      style={{ width: effectiveWidth }}
    >
      {onResize && <RailResizeHandle width={effectiveWidth} onResize={onResize} />}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-graphite">Test run</p>
          <p className="text-xs text-gray-400">Runs in test mode. No Slack alerts.</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* Saved payloads picker */}
        {savedPayloads.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-gray-500">Saved payloads</p>
            <div className="space-y-1">
              {savedPayloads.map((sp) => (
                <div key={sp.name} className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPayload(JSON.stringify(sp.payload, null, 2))}
                    className="flex flex-1 items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-left text-xs hover:bg-beige"
                  >
                    <ChevronDown className="h-3 w-3 text-gray-300 rotate-[-90deg]" />
                    <span className="font-medium text-gray-700">{sp.name}</span>
                  </button>
                  <button
                    onClick={() => deletePayload(sp.name)}
                    className="rounded p-1 text-gray-300 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Payload editor */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-gray-500">Trigger payload (JSON)</p>
          <textarea
            className="h-44 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            value={payload}
            onChange={(e) => { setPayload(e.target.value); setParseError(null) }}
            spellCheck={false}
          />
          {parseError && <p className="mt-1 text-xs text-red-500">{parseError}</p>}
        </div>

        {/* Save payload */}
        {showSaveInput ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                className="flex-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs focus:border-gray-400 focus:outline-none"
                placeholder="Payload name (e.g. happy path)"
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); setSaveError(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') savePayload()
                  if (e.key === 'Escape') { setShowSaveInput(false); setSaveName(''); setSaveError(null) }
                }}
              />
              <button
                onClick={savePayload}
                disabled={saving || !saveName.trim()}
                className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-beige disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
              </button>
              <button
                onClick={() => { setShowSaveInput(false); setSaveName(''); setSaveError(null) }}
                className="rounded p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
          </div>
        ) : (
          <button
            onClick={() => setShowSaveInput(true)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600"
          >
            <Save className="h-3.5 w-3.5" />
            Save payload for reuse
          </button>
        )}

        {/* Result banner — shown on success (to preview response body) or on failure
            when no step errors are available (otherwise the step list tells the story). */}
        {result && (result.ok || !testSteps || testSteps.length === 0) && (
          <div
            key={resultKey}
            className={`rounded-lg border p-3 ${result.ok ? 'border-green-200 bg-green-50 result-success' : 'border-red-200 bg-red-50'}`}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              {result.ok ? (
                <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 flex-shrink-0" fill="none">
                  <path
                    d="M2.5 7 L5.5 10 L11.5 4"
                    stroke="#16a34a"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="check-path"
                  />
                </svg>
              ) : (
                <XCircle className="h-3.5 w-3.5 text-red-600" />
              )}
              <span className={`text-xs font-medium ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
                {result.ok ? 'Completed' : 'Failed'}
              </span>
              <button
                onClick={() => copy('result', typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2))}
                className="ml-auto rounded p-1 text-gray-400 hover:bg-black/5 hover:text-gray-600"
                title="Copy"
              >
                {copiedKey === 'result'
                  ? <Check className="h-3 w-3 text-green-600" />
                  : <Copy className="h-3 w-3" />}
              </button>
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-700">
              {typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}
            </pre>
          </div>
        )}

        {/* Step list */}
        {testSteps && testSteps.length > 0 && (
          <div>
            {(() => {
              // Wall-clock total: sum durations, but skip parallel children
              // (their duration overlaps with the parallel_start/end wrapper).
              const totalMs = testSteps.reduce(
                (sum, s) => sum + (s.parallel_group_id ? 0 : s.duration_ms),
                0
              )
              return (
                <div className="mb-1.5 flex items-baseline justify-between">
                  <p className="text-xs font-medium text-gray-500">Steps</p>
                  <p className="text-xs tabular-nums text-gray-500">
                    <span className="text-gray-400">total </span>{totalMs}ms
                  </p>
                </div>
              )
            })()}
            <div className="overflow-hidden rounded-lg border border-gray-200 divide-y divide-gray-100">
              {testSteps.map((step) => {
                const isExpanded = expandedStep === step.step_namespace
                const label = nsToLabel[step.step_namespace] ?? step.step_namespace
                const hasDetail = !!(step.error_message || (step.output !== null && step.output !== undefined))
                return (
                  <div key={step.step_namespace}>
                    <button
                      onClick={() => hasDetail && setExpandedStep(isExpanded ? null : step.step_namespace)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${hasDetail ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                    >
                      <StepIcon status={step.status} />
                      <span className="min-w-0 flex-1 truncate font-medium text-gray-700">{label}</span>
                      <span
                        className={`shrink-0 tabular-nums ${step.duration_ms > 0 ? 'text-gray-400' : 'text-gray-300'}`}
                        title={step.duration_ms > 0 ? undefined : 'Completed in under a millisecond'}
                      >
                        {step.duration_ms > 0 ? `${step.duration_ms}ms` : '<1ms'}
                      </span>
                      {step.error_message && (
                        <span className="ml-1 shrink-0 max-w-[96px] truncate text-red-500" title={step.error_message}>
                          {step.error_message.split('\n')[0]}
                        </span>
                      )}
                      {hasDetail && (
                        isExpanded
                          ? <ChevronDown className="h-3 w-3 shrink-0 text-gray-300" />
                          : <ChevronRight className="h-3 w-3 shrink-0 text-gray-300" />
                      )}
                    </button>
                    {isExpanded && (
                      <div className="space-y-2 border-t border-gray-100 bg-gray-50 px-3 py-2.5">
                        {step.error_message && (
                          <div>
                            <div className="mb-1 flex items-center justify-between">
                              <p className="text-xs font-medium text-red-600">Error</p>
                              <button
                                onClick={() => copy(`${step.step_namespace}-err`, step.error_message ?? '')}
                                className="rounded p-0.5 text-red-400 hover:bg-red-100 hover:text-red-600"
                                title="Copy"
                              >
                                {copiedKey === `${step.step_namespace}-err`
                                  ? <Check className="h-3 w-3 text-green-600" />
                                  : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700 border border-red-100">{step.error_message}</pre>
                          </div>
                        )}
                        {step.output !== null && step.output !== undefined && (
                          <div>
                            <div className="mb-1 flex items-center justify-between">
                              <p className="text-xs font-medium text-gray-500">Output</p>
                              <button
                                onClick={() => copy(`${step.step_namespace}-out`, JSON.stringify(step.output, null, 2))}
                                className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                                title="Copy"
                              >
                                {copiedKey === `${step.step_namespace}-out`
                                  ? <Check className="h-3 w-3 text-green-600" />
                                  : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700">{JSON.stringify(step.output, null, 2)}</pre>
                          </div>
                        )}
                        {step.input !== null && step.input !== undefined && (
                          <div>
                            <div className="mb-1 flex items-center justify-between">
                              <p className="text-xs font-medium text-gray-500">Input</p>
                              <button
                                onClick={() => copy(`${step.step_namespace}-in`, JSON.stringify(step.input, null, 2))}
                                className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                                title="Copy"
                              >
                                {copiedKey === `${step.step_namespace}-in`
                                  ? <Check className="h-3 w-3 text-green-600" />
                                  : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 text-xs text-gray-700">{JSON.stringify(step.input, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 p-4">
        <button
          onClick={run}
          disabled={running}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-p-blue-dark py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {running ? 'Running…' : 'Run test'}
        </button>
      </div>
    </aside>
  )
}
