'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import type { WorkflowVersion } from '@/types/workflow'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { formatDatetime } from '@/lib/dates'
import { Skeleton } from '@/components/ui/Skeleton'

export default function VersionHistoryPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null)
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.versions.list(id)
      .then(setVersions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  function requestRestore(versionId: string) {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current)
    setConfirmingRestore(versionId)
    restoreTimerRef.current = setTimeout(() => setConfirmingRestore(null), 4000)
  }

  function cancelRestore() {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current)
    setConfirmingRestore(null)
  }

  async function handleRestore(versionId: string) {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current)
    setConfirmingRestore(null)
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
          <h1 className="text-3xl font-bold text-gray-900">Version History</h1>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full">
              <tbody className="divide-y divide-gray-100">
                {[...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-36" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-7 w-16 rounded-lg" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-sm text-gray-500">No versions saved yet.</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Version</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Message</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Created</th>
                  <th className="w-24 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {versions.map((v) => (
                  <tr key={v.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">v{v.version_number}</td>
                    <td className="px-4 py-3 text-gray-500">{v.message ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDatetime(v.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      {confirmingRestore === v.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleRestore(v.id)}
                            disabled={restoring === v.id}
                            className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                          >
                            <RotateCcw className="h-3 w-3" />
                            {restoring === v.id ? 'Restoring…' : 'Restore'}
                          </button>
                          <button onClick={cancelRestore} className="text-xs text-gray-400 hover:text-gray-600">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => requestRestore(v.id)}
                          disabled={restoring === v.id}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {restoring === v.id ? 'Restoring…' : 'Restore'}
                        </button>
                      )}
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
