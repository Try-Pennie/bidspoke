'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas'
import type { Workflow } from '@/types/workflow'

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>()
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.get(id)
      .then(setWorkflow)
      .catch((e) => setError(e.message))
  }, [id])

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

  return <WorkflowCanvas workflow={workflow} />
}
