'use client'

export const runtime = 'edge'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import type { Workflow } from '@/types/workflow'
import type { ExecutionStep } from '@/types/workflow'

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const executionId = searchParams.get('execution') ?? undefined

  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [executionSteps, setExecutionSteps] = useState<Record<string, ExecutionStep> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.get(id)
      .then(setWorkflow)
      .catch((e) => setError(e.message))
  }, [id])

  useEffect(() => {
    if (!executionId) return
    api.executions.get(executionId).then((exec) => {
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
    }).catch(() => {}) // non-fatal — canvas still shows without overlay
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
      executionId={executionId}
      executionSteps={executionSteps}
    />
  )
}
