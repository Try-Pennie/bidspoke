'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { Play, X, XCircle, Loader2, Save, Trash2, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { ExecutionStep, SavedTestPayload } from '@/types/workflow'

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
}

const DEFAULT_PAYLOAD = '{\n  \n}'

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
}: Props) {
  const [payload, setPayload] = useState(initialPayload ?? DEFAULT_PAYLOAD)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; body: unknown } | null>(null)
  const [resultKey, setResultKey] = useState(0)
  const [parseError, setParseError] = useState<string | null>(null)

  // Saved payloads
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [showSaveInput, setShowSaveInput] = useState(false)

  async function run() {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      setParseError('Invalid JSON')
      return
    }
    setParseError(null)

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
    setSaving(true)
    try {
      const next = [...savedPayloads.filter((p) => p.name !== saveName.trim()), { name: saveName.trim(), payload: parsed }]
      await api.workflows.saveTestPayloads(workflowId, next)
      onSavedPayloadsChange?.(next)
      setSaveName('')
      setShowSaveInput(false)
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
    <aside className="flex w-96 flex-shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-graphite">Test run</p>
          <p className="text-xs text-gray-400">Runs in test mode — no Slack alerts</p>
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
            className="h-52 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            value={payload}
            onChange={(e) => { setPayload(e.target.value); setParseError(null) }}
            spellCheck={false}
          />
          {parseError && <p className="mt-1 text-xs text-red-500">{parseError}</p>}
        </div>

        {/* Save payload */}
        {showSaveInput ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              className="flex-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs focus:border-gray-400 focus:outline-none"
              placeholder="Payload name (e.g. happy path)"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePayload()
                if (e.key === 'Escape') { setShowSaveInput(false); setSaveName('') }
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
              onClick={() => { setShowSaveInput(false); setSaveName('') }}
              className="rounded p-1 text-gray-400 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
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

        {/* Result */}
        {result && (
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
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-700">
              {JSON.stringify(result.body, null, 2)}
            </pre>
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
