'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowVersion } from '@/types/workflow'
import { ArrowLeft, RotateCcw } from 'lucide-react'

export default function VersionHistoryPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.versions.list(id)
      .then(setVersions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  async function handleRestore(versionId: string, versionNumber: number) {
    if (!confirm(`Restore to v${versionNumber}? This will create a new version with that definition.`)) return
    setRestoring(versionId)
    try {
      await api.versions.restore(id, versionId)
      router.push(`/workflows/${id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
      setRestoring(null)
    }
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-6 flex items-center gap-3">
          <button
            onClick={() => router.push(`/workflows/${id}`)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to editor
          </button>
          <h1 className="text-xl font-semibold text-gray-900">Version History</h1>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : versions.length === 0 ? (
          <div className="text-sm text-gray-500">No versions saved yet.</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Version</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Message</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                  <th className="w-24 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {versions.map((v) => (
                  <tr key={v.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">v{v.version_number}</td>
                    <td className="px-4 py-3 text-gray-500">{v.message ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(v.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleRestore(v.id, v.version_number)}
                        disabled={restoring === v.id}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        {restoring === v.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </NavLayout>
  )
}
