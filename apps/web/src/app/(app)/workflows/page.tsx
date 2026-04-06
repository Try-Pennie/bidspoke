'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowSummary } from '@/types/workflow'
import { Plus, Trash2, Power } from 'lucide-react'

// Last execution status per workflow_id
type HealthMap = Record<string, 'completed' | 'failed' | 'running'>

const HEALTH_DOT: Record<string, string> = {
  completed: 'bg-green-400',
  failed:    'bg-red-500',
  running:   'bg-amber-400 animate-pulse',
}

export default function WorkflowsPage() {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [health, setHealth] = useState<HealthMap>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workflows.list()
      .then(setWorkflows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))

    // Fetch recent executions across all workflows to build health map
    api.executions.listRecent()
      .then((execs) => {
        const map: HealthMap = {}
        for (const e of execs) {
          if (!map[e.workflow_id]) {
            map[e.workflow_id] = e.status as HealthMap[string]
          }
        }
        setHealth(map)
      })
      .catch(() => {})
  }, [])

  async function handleCreate() {
    setCreating(true)
    try {
      const wf = await api.workflows.create('Untitled Workflow')
      router.push(`/workflows/${wf.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workflow')
      setCreating(false)
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    try {
      await api.workflows.delete(id)
      setWorkflows((ws) => ws.filter((w) => w.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function handleToggleActive(wf: WorkflowSummary) {
    const next = !wf.is_active
    // Optimistic update
    setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: next } : w))
    try {
      await api.workflows.setActive(wf.id, next)
    } catch {
      // Revert on failure
      setWorkflows((ws) => ws.map((w) => w.id === wf.id ? { ...w, is_active: wf.is_active } : w))
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Workflows</h1>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Creating…' : 'New Workflow'}
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : workflows.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center">
            <p className="text-sm text-gray-500">No workflows yet.</p>
            <button
              onClick={handleCreate}
              className="mt-3 text-sm font-medium text-blue-600 hover:underline"
            >
              Create your first workflow
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Last run</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Active</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Last modified</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">By</th>
                  <th className="w-16 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {workflows.map((wf) => {
                  const lastRunStatus = health[wf.id]
                  return (
                    <tr key={wf.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/workflows/${wf.id}`}
                          className="font-medium text-gray-900 hover:text-blue-600"
                        >
                          {wf.name}
                        </Link>
                        {wf.description && (
                          <p className="mt-0.5 text-xs text-gray-400">{wf.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {lastRunStatus ? (
                          <span className="flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${HEALTH_DOT[lastRunStatus] ?? 'bg-gray-300'}`} />
                            <span className="text-xs capitalize text-gray-500">{lastRunStatus}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">No runs</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleToggleActive(wf)}
                          title={wf.is_active ? 'Click to deactivate' : 'Click to activate'}
                          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                            wf.is_active ? 'bg-green-500' : 'bg-gray-200'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                              wf.is_active ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {new Date(wf.updated_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{wf.updated_by_email ?? '—'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDelete(wf.id, wf.name)}
                          className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </NavLayout>
  )
}
