'use client'

export const runtime = 'edge'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import type { Workflow, ExecutionStep } from '@/types/workflow'

function WorkflowEditorInner() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const urlExecutionId = searchParams.get('execution') ?? undefined
  const mode = searchParams.get('mode') === 'edit' ? 'edit' : 'view'

  // Mirror the URL into local state so Clear can drop the execution view
  // synchronously instead of waiting on the App Router transition. router.replace
  // happens in the background and will re-sync via the effect below.
  const [executionId, setExecutionId] = useState<string | undefined>(urlExecutionId)
  useEffect(() => { setExecutionId(urlExecutionId) }, [urlExecutionId])

  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [executionSteps, setExecutionSteps] = useState<Record<string, ExecutionStep> | undefined>(undefined)
  const [executionPayload, setExecutionPayload] = useState<unknown>(undefined)
  const [executionSource, setExecutionSource] = useState<string | null>(null)
  const [executionTraceId, setExecutionTraceId] = useState<string | null>(null)
  const [executionStartedAt, setExecutionStartedAt] = useState<string | null>(null)
  const [executionParentId, setExecutionParentId] = useState<string | null>(null)
  const [executionChildren, setExecutionChildren] = useState<Array<{ id: string; started_at: string; status: string }>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.get(id)
      .then(setWorkflow)
      .catch((e) => setError(e.message))
  }, [id])

  // Track in-flight per-step detail fetches so rapid clicks across nodes don't
  // duplicate work. Keyed by step row id; cleared when the execution changes.
  const inFlightStepDetails = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!executionId) {
      // User cleared the execution — wipe to default empty state.
      setExecutionSteps(undefined)
      setExecutionPayload(undefined)
      setExecutionSource(null)
      setExecutionTraceId(null)
      setExecutionStartedAt(null)
      setExecutionParentId(null)
      setExecutionChildren([])
      inFlightStepDetails.current.clear()
      return
    }

    // Don't reset state before the fetch — keep the previous execution on
    // screen until the new one arrives, then atomic swap. Resetting first
    // doubled the render cost when clicking through executions: one render
    // to clear, another to populate, ~200ms apart.
    let cancelled = false
    inFlightStepDetails.current.clear()
    api.executions.get(executionId, { summary: true }).then((exec) => {
      if (cancelled) return
      const map: Record<string, ExecutionStep> = {}
      for (const step of exec.steps) {
        map[step.step_namespace] = {
          step_id: step.id,
          status: step.status as ExecutionStep['status'],
          input: undefined,
          output: undefined,
          error_message: step.error_message,
          error_type: step.error_type,
          duration_ms: step.duration_ms,
          retries_used: step.retries_used,
          detail_loaded: false,
        }
      }
      setExecutionPayload(exec.trigger_payload)
      setExecutionSource(exec.source)
      setExecutionTraceId(exec.trace_id)
      setExecutionStartedAt(exec.started_at)
      setExecutionParentId(exec.parent_execution_id ?? null)
      setExecutionChildren(exec.child_executions ?? [])
      setExecutionSteps(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [executionId])

  const clearExecution = useCallback(() => {
    setExecutionId(undefined)
    setExecutionSteps(undefined)
    setExecutionPayload(undefined)
    setExecutionSource(null)
    setExecutionTraceId(null)
    setExecutionStartedAt(null)
    setExecutionParentId(null)
    setExecutionChildren([])
    inFlightStepDetails.current.clear()
  }, [])

  const loadStepDetail = useCallback((namespace: string) => {
    if (!executionId) return
    const step = executionSteps?.[namespace]
    if (!step || !step.step_id || step.detail_loaded) return
    if (inFlightStepDetails.current.has(step.step_id)) return
    inFlightStepDetails.current.add(step.step_id)
    api.executions.getStep(executionId, step.step_id).then((detail) => {
      setExecutionSteps((prev) => {
        if (!prev) return prev
        const existing = prev[namespace]
        if (!existing) return prev
        return {
          ...prev,
          [namespace]: {
            ...existing,
            input: detail.input,
            output: detail.output,
            logs: detail.logs,
            detail_loaded: true,
          },
        }
      })
    }).catch(() => {}).finally(() => {
      if (step.step_id) inFlightStepDetails.current.delete(step.step_id)
    })
  }, [executionId, executionSteps])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-red-600">
        {error}
      </div>
    )
  }

  if (!workflow) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    )
  }

  return (
    <WorkflowCanvas
      workflow={workflow}
      mode={mode}
      executionId={executionId}
      executionSteps={executionSteps}
      executionPayload={executionPayload}
      executionSource={executionSource}
      executionTraceId={executionTraceId}
      executionStartedAt={executionStartedAt}
      executionParentId={executionParentId}
      executionChildren={executionChildren}
      onLoadStepDetail={loadStepDetail}
      onClearExecution={clearExecution}
    />
  )
}

export default function WorkflowEditorPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    }>
      <WorkflowEditorInner />
    </Suspense>
  )
}
