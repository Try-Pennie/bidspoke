'use client'

export const runtime = 'edge'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import type { Workflow, ExecutionStep } from '@/types/workflow'

function WorkflowEditorInner() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const executionId = searchParams.get('execution') ?? undefined
  const mode = searchParams.get('mode') === 'edit' ? 'edit' : 'view'

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

  useEffect(() => {
    if (!executionId) {
      setExecutionSteps(undefined)
      setExecutionPayload(undefined)
      setExecutionSource(null)
      setExecutionTraceId(null)
      setExecutionStartedAt(null)
      setExecutionParentId(null)
      setExecutionChildren([])
      return
    }
    api.executions.get(executionId).then((exec) => {
      setExecutionPayload(exec.trigger_payload)
      setExecutionSource(exec.source)
      setExecutionTraceId(exec.trace_id)
      setExecutionStartedAt(exec.started_at)
      setExecutionParentId(exec.parent_execution_id ?? null)
      setExecutionChildren(exec.child_executions ?? [])
      const map: Record<string, ExecutionStep> = {}
      for (const step of exec.steps) {
        map[step.step_namespace] = {
          status: step.status as ExecutionStep['status'],
          input: step.input,
          output: step.output,
          error_message: step.error_message,
          error_type: step.error_type,
          duration_ms: step.duration_ms,
          retries_used: step.retries_used,
        }
      }
      setExecutionSteps(map)
    }).catch(() => {})
  }, [executionId])

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
