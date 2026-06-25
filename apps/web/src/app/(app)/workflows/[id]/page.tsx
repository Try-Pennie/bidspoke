'use client'

export const runtime = 'edge'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import * as execCache from '@/lib/execution-cache'
import type { ExecutionDetail } from '@/lib/execution-cache'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import { ExecutionNotFoundNotice } from '@/components/ExecutionNotFoundNotice'
import { isNotFoundError } from '@/lib/execution-retention'
import type { Workflow, ExecutionStep } from '@/types/workflow'

function WorkflowEditorInner() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlExecutionId = searchParams.get('execution') ?? undefined
  const urlMode = searchParams.get('mode') === 'edit' ? 'edit' : 'view'
  const urlFocusNodeId = searchParams.get('node') ?? undefined

  // Mirror the URL into local state so Clear can drop the execution view
  // synchronously instead of waiting on the App Router transition. router.replace
  // happens in the background and will re-sync via the effect below.
  const [executionId, setExecutionId] = useState<string | undefined>(urlExecutionId)
  useEffect(() => { setExecutionId(urlExecutionId) }, [urlExecutionId])

  // Same pattern for mode — switching view↔edit through the App Router
  // transition was noticeably laggy on big workflows. Flip local state
  // immediately (instant UI) and push the URL in the background.
  const [mode, setMode] = useState<'edit' | 'view'>(urlMode)
  useEffect(() => { setMode(urlMode) }, [urlMode])
  const changeMode = useCallback((next: 'edit' | 'view') => {
    setMode(next)
    router.push(`/workflows/${id}?mode=${next}`)
  }, [router, id])

  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [executionSteps, setExecutionSteps] = useState<Record<string, ExecutionStep> | undefined>(undefined)
  const [executionPayload, setExecutionPayload] = useState<unknown>(undefined)
  const [executionSource, setExecutionSource] = useState<string | null>(null)
  const [executionTraceId, setExecutionTraceId] = useState<string | null>(null)
  const [executionStartedAt, setExecutionStartedAt] = useState<string | null>(null)
  const [executionParentId, setExecutionParentId] = useState<string | null>(null)
  const [executionChildren, setExecutionChildren] = useState<Array<{ id: string; started_at: string; status: string }>>([])
  const [executionMissing, setExecutionMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.get(id)
      .then(setWorkflow)
      .catch((e) => setError(e.message))
  }, [id])

  // Populate UI state from a (possibly cached) exec detail. Reused by initial
  // sync read, background revalidation, and per-step lazy-load merges.
  //
  // Reference preservation is load-bearing: WorkflowCanvas keys its node-data
  // sync on ExecutionStep object identity, and a fresh ref for every step on
  // every cache notify causes updateNodeInternals to touch all N nodes and
  // freeze the canvas for seconds. See reference_canvas_execution_step_ref
  // _equality_contract memory. So we use functional setState to access the
  // prior map and reuse step objects whose observable fields are unchanged —
  // critical for cache revalidations and per-step detail merges where most
  // namespaces don't actually change.
  const applyExec = useCallback((exec: ExecutionDetail) => {
    setExecutionSteps((prev) => {
      const map: Record<string, ExecutionStep> = {}
      for (const step of exec.steps) {
        const cachedDetail = execCache.getStep(exec.id, step.id)
        const cachedInput = cachedDetail?.input
        const cachedOutput = cachedDetail?.output
        const cachedLogs = cachedDetail?.logs ?? undefined
        const detailLoaded = !!cachedDetail
        const prevStep = prev?.[step.step_namespace]
        const same =
          prevStep !== undefined &&
          prevStep.step_id === step.id &&
          prevStep.status === step.status &&
          prevStep.error_message === step.error_message &&
          prevStep.error_type === step.error_type &&
          prevStep.duration_ms === step.duration_ms &&
          prevStep.retries_used === step.retries_used &&
          prevStep.detail_loaded === detailLoaded &&
          prevStep.input === cachedInput &&
          prevStep.output === cachedOutput &&
          prevStep.logs === cachedLogs
        map[step.step_namespace] = same
          ? prevStep
          : {
              step_id: step.id,
              status: step.status as ExecutionStep['status'],
              input: cachedInput,
              output: cachedOutput,
              logs: cachedLogs,
              error_message: step.error_message,
              error_type: step.error_type,
              duration_ms: step.duration_ms,
              retries_used: step.retries_used,
              detail_loaded: detailLoaded,
            }
      }
      return map
    })
    setExecutionPayload(exec.trigger_payload)
    setExecutionSource(exec.source)
    setExecutionTraceId(exec.trace_id)
    setExecutionStartedAt(exec.started_at)
    setExecutionParentId(exec.parent_execution_id ?? null)
    setExecutionChildren(exec.child_executions ?? [])
  }, [])

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
      return
    }

    // Synchronous cache read: if we've seen this exec before (hover prefetch,
    // 10s sweep, or back-click), the canvas overlay paints immediately with no
    // network wait. Don't reset state before the fetch on a miss — keep the
    // previous execution on screen until the new one lands, then atomic swap.
    const cached = execCache.get(executionId)
    if (cached) applyExec(cached)

    // Stale-while-revalidate: refetch in the background if the cached row was
    // still running. A miss kicks off the foreground fetch (deduped if a
    // prefetch is already in flight).
    setExecutionMissing(false)
    if (cached) {
      execCache.revalidateIfRunning(executionId)
    } else {
      execCache.fetchExec(executionId).catch((e) => {
        // Old Slack links land here when the row aged out of retention or its
        // logs never persisted. Surface a notice instead of a silent blank.
        if (isNotFoundError(e)) setExecutionMissing(true)
      })
    }

    // Subscribe to cache writes for this id — covers background revalidation
    // landing and per-step detail merges from sibling tabs.
    const unsub = execCache.subscribe((id) => {
      if (id !== executionId) return
      const next = execCache.get(executionId)
      if (next) applyExec(next)
    })
    return unsub
  }, [executionId, applyExec])

  // Selecting an execution from the list/banner/parent-link: flip local state
  // synchronously so the canvas reacts on the same tick as the click, AND
  // update the URL bar synchronously via window.history.pushState. router.push
  // routes the URL change through the App Router transition, which on big
  // workflows held the URL bar update for seconds after the click — Dan: "if
  // I click and see it update and then go copy the URL I might get the wrong
  // one." pushState dodges the transition entirely; since Next 14.1,
  // useSearchParams reacts to pushState, so the rest of the data flow still
  // works (the search-params useEffect just resyncs to the same value, no-op).
  const selectExecution = useCallback((execId: string) => {
    setExecutionId(execId)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('execution', execId)
      window.history.pushState(null, '', url.toString())
    }
  }, [])

  const clearExecution = useCallback(() => {
    setExecutionId(undefined)
    setExecutionSteps(undefined)
    setExecutionPayload(undefined)
    setExecutionSource(null)
    setExecutionTraceId(null)
    setExecutionStartedAt(null)
    setExecutionParentId(null)
    setExecutionChildren([])
  }, [])

  const loadStepDetail = useCallback((namespace: string) => {
    if (!executionId) return
    const step = executionSteps?.[namespace]
    if (!step || !step.step_id || step.detail_loaded) return
    // Cache short-circuits: if we've already loaded this step's input/output
    // (or another component did via the same cache), apply immediately.
    const cached = execCache.getStep(executionId, step.step_id)
    if (cached) {
      setExecutionSteps((prev) => {
        if (!prev) return prev
        const existing = prev[namespace]
        if (!existing) return prev
        return {
          ...prev,
          [namespace]: {
            ...existing,
            input: cached.input,
            output: cached.output,
            logs: cached.logs ?? undefined,
            detail_loaded: true,
          },
        }
      })
      return
    }
    // Cache miss — fetchStep dedupes concurrent requests for the same step.
    // The subscribe() in the executionId effect picks up the cache write and
    // re-applies, so no explicit setState here is needed on success.
    execCache.fetchStep(executionId, step.step_id).catch(() => {})
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
      <div className="flex h-screen items-center justify-center text-sm text-gray-500">
        Loading…
      </div>
    )
  }

  return (
    <>
      <WorkflowCanvas
        workflow={workflow}
        mode={mode}
        onModeChange={changeMode}
        executionId={executionMissing ? undefined : executionId}
        executionSteps={executionSteps}
        executionPayload={executionPayload}
        executionSource={executionSource}
        executionTraceId={executionTraceId}
        executionStartedAt={executionStartedAt}
        executionParentId={executionParentId}
        executionChildren={executionChildren}
        onLoadStepDetail={loadStepDetail}
        onClearExecution={clearExecution}
        onSelectExecution={selectExecution}
        focusNodeId={urlFocusNodeId}
      />
      {executionMissing && executionId && (
        <div className="fixed left-1/2 top-16 z-50 w-full max-w-lg -translate-x-1/2 px-4">
          <div className="shadow-lg">
            <ExecutionNotFoundNotice
              executionId={executionId}
              action={
                <button
                  onClick={() => { setExecutionMissing(false); clearExecution() }}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-beige"
                >
                  Dismiss
                </button>
              }
            />
          </div>
        </div>
      )}
    </>
  )
}

export default function WorkflowEditorPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center text-sm text-gray-500">
        Loading…
      </div>
    }>
      <WorkflowEditorInner />
    </Suspense>
  )
}
